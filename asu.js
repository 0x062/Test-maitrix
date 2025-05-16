const fs = require('fs');
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
if (proxyAgent) {
  axios.defaults.proxy = false;
  axios.defaults.httpsAgent = proxyAgent;
}

const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: { virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C', ath: '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399', ausd: '0x78De28aABBD5198657B26A8dc9777f441551B477', usde: '0xf4BE938070f59764C85fAcE374F92A4670ff3877', lvlusd: '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83', vusd: '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802', vnusd: '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4Bf8' },
  routers: { virtual: '0x3dCACa90A714498624067948C092Dd0373f08265', ath: '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e', vnusd: '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f' },
  stakeContracts: { ausd: '0x054de909723ECda2d119E31583D40a52a332f85c', usde: '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb', lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A', vusd: '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51', vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60' },
  methodIds: { virtualSwap: '0xa6d67510', athSwap: '0x1bf6318b', vnusdSwap: '0xa6d67510', stake: '0xa694fc3a' },
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei'),
  delayMs: 17000
};

const erc20Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)'
];

function getPrivateKeys() {
  try {
    const data = fs.readFileSync('private_keys.txt', 'utf8');
    console.log(`🔑 Loaded ${data.split(/\r?\n/).filter(l => l).length} keys`);
    return data.split(/\r?\n/).map(l => l.trim()).filter(l => l);
  } catch (e) {
    console.error('❌ Failed to read private_keys.txt:', e);
    return [];
  }
}

class WalletBot {
  constructor(privateKey, config) {
    this.config = config;
    if (proxyAgent) {
      this.provider = new ethers.providers.JsonRpcProvider({ url: config.rpc, transport: { url: config.rpc, fetch: (url, opt) => fetch(url, { ...opt, agent: proxyAgent }) } });
      console.log(`🌐 Proxy: ${proxyUrl}`);
    } else {
      this.provider = new ethers.providers.JsonRpcProvider(config.rpc);
      console.log('🌐 No proxy');
    }
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
    console.log(`🤖 Wallet: ${this.address}`);
  }

  async fetchIP() {
    try {
      const res = await axios.get('https://api.ipify.org?format=json');
      console.log(`📡 IP: ${res.data.ip}`);
    } catch (e) {
      console.error('❌ IP lookup failed:', e.message);
    }
  }

  async delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async getTokenBalance(addr) {
    const c = new ethers.Contract(addr, erc20Abi, this.wallet);
    const dec = await c.decimals();
    const bal = await c.balanceOf(this.address);
    let sym;
    try { sym = await c.symbol(); } catch { sym = 'TOKEN'; }
    return { balance: bal, formatted: ethers.utils.formatUnits(bal, dec), symbol: sym };
  }

  async getEthBalance() {
    const w = await this.provider.getBalance(this.address);
    return { formatted: ethers.utils.formatEther(w) };
  }

  async swapToken(name) {
    try {
      const addr = this.config.tokens[name];
      const router = this.config.routers[name];
      const id = this.config.methodIds[`${name}Swap`];
      const { balance, formatted, symbol } = await this.getTokenBalance(addr);
      console.log(`↔️ Checking ${symbol}: ${formatted}`);
      if (balance.isZero()) { console.log(`⚠️ Skip swap ${symbol}, balance = 0`); return; }
      console.log(`✍️ Approving ${symbol}…`);
      const approveTx = await new ethers.Contract(addr, erc20Abi, this.wallet)
        .approve(router, balance, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
      console.log(`   Approve hash: ${approveTx.hash}`);
      await approveTx.wait();
      console.log('   ✅ Approved');
      await this.delay(this.config.delayMs);
      const data = id + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      console.log('📡 Swap tx data:', data);
      const tx = await this.wallet.sendTransaction({ to: router, data, gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
      console.log(`   Swap tx hash: ${tx.hash}`);
      await tx.wait();
      console.log(`✅ Swapped ${formatted} ${symbol}`);
    } catch (e) {
      console.error(`❌ swapToken error for ${name}:`, e.message || e);
    }
  }

  async stakeToken(name, customAddr = null) {
    const tokenAddr = customAddr || this.config.tokens[name];
    const stakeCt = this.config.stakeContracts[name];
    try {
      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      console.log(`🛡️ Preparing to stake ${symbol}: ${formatted} to ${stakeCt}`);
      if (balance.isZero()) { console.log(`⚠️ Skip stake ${symbol}, balance = 0`); return; }
      console.log(`✍️ Approving staking contract ${stakeCt}…`);
      const approveTx = await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(stakeCt, balance, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
      console.log(`   Approve hash: ${approveTx.hash}`);
      await approveTx.wait();
      console.log('   ✅ Approved for staking');
      await this.delay(this.config.delayMs);
      const data = this.config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      console.log('📡 Stake tx data:', data);
      const tx = await this.wallet.sendTransaction({ to: stakeCt, data, gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
      console.log(`   Stake tx hash: ${tx.hash}`);
      await tx.wait();
      console.log(`🎉 Staked ${formatted} ${symbol}`);
      await sendReport(`🚀 *Staked!* ${symbol} ${formatted} (${tx.hash})`);
    } catch (e) {
      console.error(`❌ stakeToken error for ${name}:`, e.message || e);
      if (e.error && e.error.data) console.error('   RPC revert data:', e.error.data);
    }
  }

  async checkStatus() {
    const eth = await this.getEthBalance();
    console.log(`💧 ETH: ${eth.formatted}`);
    for (let [n, a] of Object.entries(this.config.tokens)) {
      const { formatted, symbol } = await this.getTokenBalance(a);
      console.log(`🔹 ${symbol}: ${formatted}`);
    }
  }

  async claimFaucets() {
    const endpoints = { ath: 'https://app.x-network.io/maitrix-faucet/faucet', usde: 'https://app.x-network.io/maitrix-usde/faucet', lvlusd: 'https://app.x-network.io/maitrix-lvl/faucet', virtual: 'https://app.x-network.io/maitrix-virtual/faucet', vana: 'https://app.x-network.io/maitrix-vana/faucet' };
    for (let [k,u] of Object.entries(endpoints)) {
      try { await axios.post(u, { address: this.address }); console.log(`✔️ Faucet ${k}`); } catch { console.error(`❌ Faucet ${k} failed`); }
      await this.delay(this.config.delayMs);
    }
  }

  async runBot() {
    console.log(`🏃 Run ${this.address}`);
    await this.fetchIP();
    await this.checkStatus();
    await this.claimFaucets();
    for (let t of ['virtual','ath','vnusd']) await this.swapToken(t);
    for (let n of Object.keys(this.config.stakeContracts)) await this.stakeToken(n, n==='vnusd'? '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30': null);
    await this.checkStatus();
    console.log(`✅ Done ${this.address}`);
  }
}

(async()=>{
  console.log('🚀 Multi-bot start');
  const keys = getPrivateKeys();
  if (!keys.length) return console.error('❌ No keys');
  for (let k of keys) {
    const bot = new WalletBot(k, globalConfig);
    await bot.runBot();
    await bot.delay(globalConfig.delayMs);
  }
  console.log('🎉 All done');
  setInterval(async()=>{
    for (let k of getPrivateKeys()) {
      const bot = new WalletBot(k, globalConfig);
      await bot.runBot();
    }
  }, 24*60*60*1000);
})();
