const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

// Load proxies and private keys from text files
function loadListFromFile(filename) {
  const filePath = path.resolve(__dirname, filename);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}
const proxies = loadListFromFile('proxies.txt');
const privateKeys = loadListFromFile('private_keys.txt');

// Configurations
const config = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  gasLimit: 1_000_000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei'),
  delayMs: 15_000,
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath:     '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    vnusd:   '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8',
    azusd:   '0x2d5a4f5634041f50180A25F26b2A8364452E3152'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:   '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f',
    azusd:   '0xb0b53d8b4ef06f9bbe5db624113c6a5d35bb7522'
  },
  stakes: {
    ausd:    '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:    '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd:  '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:    '0x5bb9Fa02a3DCCDB4E9099b48eBa5841D2e59d51',
    vnusd:   '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60',
    azusd:   '0xf45fde3f484c44cc35bdc2a7fca3ddde0c8f252e'
  },
  methodIds: {
    virtual: '0xa6d67510',
    ath:     '0x1bf6318b',
    vnusd:   '0xa6d67510',
    azusd:   '0xa6d67510',
    stake:   '0xa694fc3a'
  }
};

// Minimal ERC20 ABI
const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)'
];

class WalletBot {
  constructor(key, proxy) {
    const agent = proxy
      ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy))
      : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: config.rpc, fetch: (u, o) => fetch(u, { agent, ...o }) })
      : new ethers.providers.JsonRpcProvider(config.rpc);
    this.http = agent ? axios.create({ httpAgent: agent, httpsAgent: agent, timeout: 10000 }) : axios;
    this.wallet = new ethers.Wallet(key, this.provider);
    this.address = this.wallet.address;
  }
  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async getBalance(addr) {
    const c = new ethers.Contract(addr, erc20Abi, this.wallet);
    const d = await c.decimals();
    const b = await c.balanceOf(this.address);
    const s = await c.symbol().catch(() => '?');
    return { balance: b, formatted: ethers.utils.formatUnits(b, d), symbol: s };
  }

  async swap(name) {
    const router = config.routers[name];
    const method = config.methodIds[name];
    if (!router || !method) return;
    const { balance, formatted, symbol } = await this.getBalance(config.tokens[name]);
    if (balance.isZero()) return;
    const token = new ethers.Contract(config.tokens[name], erc20Abi, this.wallet);
    const tx1 = await token.approve(router, balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`🔏 Approving ${symbol}: ${tx1.hash}`);
    await tx1.wait(); await this.delay(config.delayMs);
    const data = method + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
    const tx2 = await this.wallet.sendTransaction({ to: router, data, gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`⚡ Swapped ${formatted} ${symbol}: ${tx2.hash}`);
    await tx2.wait(); await this.delay(config.delayMs);
  }

  async stake(name, override) {
    const addr = override || config.tokens[name];
    const ct = config.stakes[name];
    const { balance, formatted, symbol } = await this.getBalance(addr);
    if (balance.isZero()) return;
    const token = new ethers.Contract(addr, erc20Abi, this.wallet);
    const tx1 = await token.approve(ct, balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`🔏 Approving ${symbol}: ${tx1.hash}`);
    await tx1.wait(); await this.delay(config.delayMs);
    const allow = await token.allowance(this.address, ct);
    console.log(`➡️ Allowance ${symbol}: ${ethers.utils.formatUnits(allow)}`);
    const data = config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
    const tx2 = await this.wallet.sendTransaction({ to: ct, data, gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`⚡ Staked ${formatted} ${symbol}: ${tx2.hash}`);
    await tx2.wait(); await this.delay(config.delayMs);
    await sendReport(formatStakingReport(symbol, formatted, tx2.hash));
  }

  async claimFaucets() {
    const eps = [
      'https://app.x-network.io/maitrix-faucet/faucet',
      'https://app.x-network.io/maitrix-usde/faucet',
      'https://app.x-network.io/maitrix-lvl/faucet',
      'https://app.x-network.io/maitrix-virtual/faucet',
      'https://app.x-network.io/maitrix-vana/faucet',
      'https://app.x-network.io/maitrix-ai16z/faucet'
    ];
    console.log('-- claimFaucets start');
    for (const url of eps) {
      try { await this.http.post(url, { address: this.address }); console.log(`💧 Faucet ${url}`); } catch {};
      await this.delay(config.delayMs);
    }
    console.log('-- claimFaucets done');
  }

  async run() {
    console.log(`\n🌟 Wallet ${this.address}`);
    await this.claimFaucets();
    for (const name of Object.keys(config.routers)) await this.swap(name);
    for (const name of Object.keys(config.stakes)) await this.stake(name, name === 'vnusd' ?
      '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30' :
      name === 'azusd' ? '0x5966cd11aED7D68705C9692e74e5688C892cb162' : null);
  }
}

// Main
(async () => {
  if (!privateKeys.length) return console.error('No private_keys.txt found');
  privateKeys.forEach(async (key, i) => {
    const bot = new WalletBot(key, proxies[i % proxies.length]);
    await bot.run();
  });
})();
