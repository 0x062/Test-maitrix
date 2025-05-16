const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

function loadList(filename) {
  const file = path.resolve(__dirname, filename);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

const privateKeys = loadList('private_keys.txt');
const rotatingProxy = process.env.ROTATING_PROXY_URL || null;

const config = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei'),
  delayMs: 15000,
  // Daftar alamat token ERC-20 yang akan dicek dan dioperasikan
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath:     '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    vnusd:   '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8',
    ausd:    '0x78De28aABBD5198657B26A8dc9777f441551B477',    // Tambahkan alamat token AUSd
    usde:    '0xf4BE938070f59764C85fAcE374F92A4670ff3877>',    // Tambahkan alamat token USDe
    lvlusd:  '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83>',  // Tambahkan alamat token LVLUSD
    vusd:    '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802>'     // Tambahkan alamat token VUSD
  },
  // Kontrak router untuk swap
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:   '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },
  // Kontrak staking untuk tiap token
  stakes: {
    ausd:    '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:    '0x3988053b7c748023a1aE19a8ED4c1Bf217932bDB',
    lvlusd:  '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:    '0x5bb9Fa02a3DCCDB4E9099b48eBa5841D2e59d51',
    vnusd:   '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60'
  },
  // ID metode (function selectors) untuk swap dan stake
  methodIds: {
    virtual: '0xa6d67510',
    ath:     '0x1bf6318b',
    vnusd:   '0xa6d67510',
    stake:   '0xa694fc3a'
  }
};

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)',
];

class WalletBot {
  constructor(key, proxyUrl) {
    const agent = proxyUrl
      ? (proxyUrl.startsWith('socks')
          ? new SocksProxyAgent(proxyUrl)
          : new HttpsProxyAgent(proxyUrl))
      : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: config.rpc, fetch: (u, o) => fetch(u, { agent, ...o }) })
      : new ethers.providers.JsonRpcProvider(config.rpc);
    this.http = agent
      ? axios.create({ httpAgent: agent, httpsAgent: agent, timeout: 10000 })
      : axios;
    this.wallet = new ethers.Wallet(key, this.provider);
    this.address = this.wallet.address;
    console.log(`🟢 Initialized wallet ${this.address}`);
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async logProxyIp() {
    if (this.http !== axios) {
      try { const { data } = await this.http.get('https://api.ipify.org?format=json'); console.log(`🌐 Using proxy IP: ${data.ip}`); }
      catch (e) { console.log(`⚠️ Failed to fetch proxy IP: ${e.message}`); }
    } else {
      console.log('ℹ️ No proxy used, using direct IP');
    }
  }

  async getToken(name) {
    const addr = config.tokens[name];
    if (!addr) throw new Error(`Token config for '${name}' not found`);
    const contract = new ethers.Contract(addr, erc20Abi, this.wallet);
    const decimals = await contract.decimals();
    const balance = await contract.balanceOf(this.address);
    const symbol = await contract.symbol().catch(() => name);
    return { contract, balance, formatted: ethers.utils.formatUnits(balance, decimals), symbol };
  }

  async claimFaucets() {
    console.log(`-- claimFaucets for ${this.address}`);
    const endpoints = [
      'https://app.x-network.io/maitrix-faucet/faucet',
      'https://app.x-network.io/maitrix-usde/faucet',
      'https://app.x-network.io/maitrix-lvl/faucet',
      'https://app.x-network.io/maitrix-virtual/faucet',
      'https://app.x-network.io/maitrix-vana/faucet',
      'https://app.x-network.io/maitrix-ai16z/faucet'
    ];
    for (const url of endpoints) {
      try { await this.http.post(url, { address: this.address }); console.log(`💧 Faucet claimed: ${url}`); }
      catch (e) { console.log(`⚠️ Faucet error: ${url}`); }
      await this.delay(config.delayMs);
    }
  }

  async swap(name) {
    try {
      const { contract, balance, formatted, symbol } = await this.getToken(name);
      console.log(`🔍 Swap check ${symbol}: balance ${formatted}`);
      if (balance.isZero()) return console.log(`⚠️ No ${symbol} to swap`);
      console.log(`-- swap ${name}`);
      const router = config.routers[name], method = config.methodIds[name];
      const tx1 = await contract.approve(router, balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
      console.log(`🔏 Approving ${symbol}: ${tx1.hash}`);
      await tx1.wait(); await this.delay(config.delayMs);
      const data = method + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx2 = await this.wallet.sendTransaction({ to: router, data, gasLimit: config.gasLimit, gasPrice: config.gasPrice });
      console.log(`⚡ Swapping ${formatted} ${symbol}: ${tx2.hash}`);
      await tx2.wait(); await this.delay(config.delayMs);
      console.log(`✅ Swapped ${symbol}`);
    } catch (e) { console.log(`❌ Swap ${name} failed: ${e.message}`); }
  }

  async stake(name, overrideAddr) {
    try {
      const { contract, balance, formatted, symbol } = await this.getToken(name);
      console.log(`🔍 Stake check ${symbol}: balance ${formatted}`);
      if (balance.isZero()) return console.log(`⚠️ No ${symbol} to stake`);
      console.log(`-- stake ${name}`);
      const stakeCt = config.stakes[name];
      const tx1 = await contract.approve(stakeCt, balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
      console.log(`🔏 Approving ${symbol}: ${tx1.hash}`);
      await tx1.wait(); await this.delay(config.delayMs);
      const data = config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx2 = await this.wallet.sendTransaction({ to: stakeCt, data, gasLimit: config.gasLimit, gasPrice: config.gasPrice });
      console.log(`⚡ Staking ${formatted} ${symbol}: ${tx2.hash}`);
      await tx2.wait(); await this.delay(config.delayMs);
      console.log(`✅ Staked ${symbol}`);
      await sendReport(formatStakingReport(symbol, formatted, tx2.hash));
    } catch (e) { console.log(`❌ Stake ${name} failed: ${e.message}`); }
  }

  async run() {
    console.log(`\n🌟 Run start for ${this.address}`);
    await this.logProxyIp();
    await this.claimFaucets();

    // Swap tokens
    const swapTokens = Object.keys(config.tokens).filter(name => config.routers[name] && config.methodIds[name]);
    console.log('ℹ️ Balances for swapable tokens:');
    for (const name of swapTokens) {
      try {
        const { formatted, symbol } = await this.getToken(name);
        console.log(`   - ${symbol}: ${formatted}`);
      } catch {
        console.log(`   - ${name}: error fetching balance`);
      }
    }
    console.log(`Tokens to swap: ${swapTokens.join(', ')}`);
    for (const name of swapTokens) await this.swap(name);

    // Stake tokens
    const stakeTokens = Object.keys(config.stakes);
    console.log('ℹ️ Balances for stakeable tokens:');
    for (const name of stakeTokens) {
      if (config.tokens[name]) {
        try {
          const { formatted, symbol } = await this.getToken(name);
          console.log(`   - ${symbol}: ${formatted}`);
        } catch {
          console.log(`   - ${name}: error fetching balance`);
        }
      } else {
        console.log(`   - ${name}: token address not configured`);
      }
    }
    console.log(`Tokens to stake: ${stakeTokens.join(', ')}`);
    for (const name of stakeTokens) {
      const override = name === 'vnusd' ? '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30' : null;
      if (config.tokens[name]) await this.stake(name, override);
    }

    console.log(`🌟 Run completed for ${this.address}`);
  }
}

(async () => {
  if (!privateKeys.length) { console.error('❌ No private_keys.txt found'); return; }
  for (const key of privateKeys) {
    const bot = new WalletBot(key, rotatingProxy);
    await bot.run();
    await bot.delay(config.delayMs);
  }
})();
