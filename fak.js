const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

function loadProxiesFromFile(filename = 'proxies.txt') {
  const p = path.resolve(__dirname, filename);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function loadPrivateKeysFromFile(filename = 'private_keys.txt') {
  const p = path.resolve(__dirname, filename);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function formatStakingReport(token, amount, tx) {
  return `🚀🎉 *Staking Berhasil!* 🎉🚀\n*Token:* ${token}\n*Jumlah:* ${amount}\n*TxHash:* \`${tx}\``;
}

const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath: '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd: '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde: '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd: '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd: '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
    vnusd: '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath: '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd: '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },
  stakeContracts: {
    ausd: '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde: '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd: '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap: '0x1bf6318b',
    vnusdSwap: '0xa6d67510',
    stake: '0xa694fc3a'
  },
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei'),
  delayMs: 15000
};

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
  'function symbol() view returns (string)'  
];

class WalletBot {
  constructor(key, cfg, proxy) {
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy)) : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: cfg.rpc, fetch: (u, o) => fetch(u, { agent, ...o }) })
      : new ethers.providers.JsonRpcProvider(cfg.rpc);
    this.http = agent ? axios.create({ httpAgent: agent, httpsAgent: agent, timeout: 10000 }) : axios;
    this.wallet = new ethers.Wallet(key, this.provider);
    this.address = this.wallet.address;
    this.cfg = cfg;
    console.log(`🟢 Inited ${this.address} via proxy ${proxy || 'none'}`);
  }
  delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  async getTokenBalance(addr) {
    const contract = new ethers.Contract(addr, erc20Abi, this.wallet);
    const decimals = await contract.decimals();
    const balance = await contract.balanceOf(this.address);
    const symbol = await contract.symbol().catch(() => '?');
    return { balance, formatted: ethers.utils.formatUnits(balance, decimals), symbol, contract };
  }
  async swapToken(name) {
    try {
      const { balance, formatted, symbol } = await this.getTokenBalance(this.cfg.tokens[name]);
      if (balance.isZero()) return;
      const router = this.cfg.routers[name];
      const payload = this.cfg.methodIds[`${name}Swap`] + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      await this.provider.call({ to: router, data: payload });
      const approveTx = await new ethers.Contract(this.cfg.tokens[name], erc20Abi, this.wallet)
        .approve(router, balance, { gasLimit: this.cfg.gasLimit, gasPrice: this.cfg.gasPrice });
      await approveTx.wait();
      await this.delay(this.cfg.delayMs);
      const swapTx = await this.wallet.sendTransaction({ to: router, data: payload, gasLimit: this.cfg.gasLimit, gasPrice: this.cfg.gasPrice });
      await swapTx.wait();
      await this.delay(this.cfg.delayMs);
    } catch (e) {}
  }
  async stakeToken(name) {
    try {
      const { balance } = await this.getTokenBalance(this.cfg.tokens[name]);
      if (balance.isZero()) return;
      const contractAddr = this.cfg.stakeContracts[name];
      const payload = this.cfg.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      await this.provider.call({ to: contractAddr, data: payload });
      const approveTx = await new ethers.Contract(this.cfg.tokens[name], erc20Abi, this.wallet)
        .approve(contractAddr, balance, { gasLimit: this.cfg.gasLimit, gasPrice: this.cfg.gasPrice });
      await approveTx.wait();
      await this.delay(this.cfg.delayMs);
      const tx = await this.wallet.sendTransaction({ to: contractAddr, data: payload, gasLimit: this.cfg.gasLimit, gasPrice: this.cfg.gasPrice });
      await tx.wait();
      await this.delay(this.cfg.delayMs);
      await sendReport(formatStakingReport(name, ethers.utils.formatUnits(balance, await new ethers.Contract(this.cfg.tokens[name], erc20Abi, this.wallet).decimals()), tx.hash));
    } catch (e) {}
  }
  async claimFaucets() {
    const endpoints = {
      ath: 'https://app.x-network.io/maitrix-faucet/faucet',
      usde: 'https://app.x-network.io/maitrix-usde/faucet',
      lvlusd: 'https://app.x-network.io/maitrix-lvl/faucet',
      virtual: 'https://app.x-network.io/maitrix-virtual/faucet',
      vana: 'https://app.x-network.io/maitrix-vana/faucet',
      ai16z: 'https://app.x-network.io/maitrix-ai16z/faucet'
    };
    for (const url of Object.values(endpoints)) {
      try { await this.http.post(url, { address: this.address }); } catch {};
      await this.delay(this.cfg.delayMs);
    }
  }
  async runBot() {
    await this.claimFaucets();
    for (const name of Object.keys(this.cfg.tokens)) await this.swapToken(name);
    for (const name of Object.keys(this.cfg.stakeContracts)) await this.stakeToken(name);
  }
}
(async function main() {
  const keys = loadPrivateKeysFromFile();
  if (keys.length === 0) return;
  const proxies = loadProxiesFromFile();
  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies[i % proxies.length] || null;
    const bot = new WalletBot(keys[i], globalConfig, proxy);
    try { await bot.http.get('https://api.ipify.org?format=json'); } catch {};
    await bot.runBot();
    await bot.delay(globalConfig.delayMs);
  }
})();
