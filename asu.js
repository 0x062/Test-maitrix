const fs = require('fs');
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

// Setup proxy if provided
const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
if (proxyAgent) {
  axios.defaults.proxy = false;
  axios.defaults.httpsAgent = proxyAgent;
}

// Global configuration
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
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei'),
  delayMs: 17000
};

// Minimal ERC20 ABI
const erc20Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

// Read private keys
function getPrivateKeys() {
  try {
    const data = fs.readFileSync('private_keys.txt', 'utf8');
    console.log(`🔑 Loaded ${data.split(/\r?\n/).filter(Boolean).length} keys`);
    return data.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch (e) {
    console.error('❌ Failed to read private_keys.txt:', e);
    return [];
  }
}

class WalletBot {
  constructor(privateKey, config) {
    this.config = config;
    // Provider
    if (proxyAgent) {
      this.provider = new ethers.providers.JsonRpcProvider({
        url: config.rpc,
        transport: {
          url: config.rpc,
          fetch: (u, o) => fetch(u, { ...o, agent: proxyAgent })
        }
      });
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

  async delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async getTokenBalance(tokenAddr) {
    const c = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
    const dec = await c.decimals();
    const bal = await c.balanceOf(this.address);
    let sym;
    try { sym = await c.symbol(); } catch { sym = 'TOKEN'; }
    return { raw: bal, formatted: ethers.utils.formatUnits(bal, dec), symbol: sym };
  }

  async getEthBalance() {
    const bal = await this.provider.getBalance(this.address);
    return ethers.utils.formatEther(bal);
  }

  async swapToken(name) {
    const tokenAddr = this.config.tokens[name];
    const routerAddr = this.config.routers[name];
    if (!routerAddr) return;

    const { raw, formatted, symbol } = await this.getTokenBalance(tokenAddr);
    console.log(`↔️ Checking ${symbol}: ${formatted}`);
    if (raw.isZero()) return console.log(`⚠️ Skip swap ${symbol}, balance=0`);

    console.log(`🔁 Swapping ${formatted} ${symbol}`);
    const tokenContract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);

    // Reset allowance to 0 if existing
    try {
      const allowance = await tokenContract.allowance(this.address, routerAddr);
      if (!allowance.isZero()) {
        const tx0 = await tokenContract.approve(routerAddr, 0, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
        await tx0.wait();
        console.log('   🔄 Reset allowance');
      }
    } catch {}

    // Approve
    const approveTx = await tokenContract.approve(routerAddr, raw, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
    console.log(`   Approve hash: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('   ✅ Approved');

    await this.delay(this.config.delayMs);
    const swapAbi = [`function ${name}Swap(uint256)`];
    const swapCt = new ethers.Contract(routerAddr, swapAbi, this.wallet);
    const swapTx = await swapCt[`${name}Swap`](raw, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
    console.log(`   Swap hash: ${swapTx.hash}`);
    await swapTx.wait();
    console.log(`✅ Swapped ${formatted} ${symbol}`);
  }

  async stakeToken(name, customAddr) {
    const tokenAddr = customAddr || this.config.tokens[name];
    const stakeAddr = this.config.stakeContracts[name];
    const { raw, formatted, symbol } = await this.getTokenBalance(tokenAddr);
    console.log(`🛡️ Stake ${symbol}: ${formatted}`);
    if (raw.isZero()) return console.log(`⚠️ Skip stake ${symbol}, balance=0`);

    const c = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
    const txA = await c.approve(stakeAddr, raw, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
    await txA.wait();
    console.log('   ✅ Approved for staking');

    await this.delay(this.config.delayMs);
    const stakeAbi = ['function stake(uint256)'];
    const sc = new ethers.Contract(stakeAddr, stakeAbi, this.wallet);
    const txS = await sc.stake(raw, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice });
    console.log(`   Stake hash: ${txS.hash}`);
    await txS.wait();
    console.log(`🎉 Staked ${formatted} ${symbol}`);
    await sendReport(`🚀 *Staked!* ${symbol} ${formatted} (${txS.hash})`);
  }

  async checkStatus() {
    console.log(`💧 ETH: ${await this.getEthBalance()}`);
    for (const addr of Object.values(this.config.tokens)) {
      const { formatted, symbol } = await this.getTokenBalance(addr);
      console.log(`🔹 ${symbol}: ${formatted}`);
    }
  }

  async claimFaucets() {
    const endpoints = { ath: 'https://app.x-network.io/maitrix-faucet/faucet', usde: 'https://app.x-network.io/maitrix-usde/faucet', lvlusd: 'https://app.x-network.io/maitrix-lvl/faucet', virtual: 'https://app.x-network.io/maitrix-virtual/faucet', vana: 'https://app.x-network.io/maitrix-vana/faucet' };
    console.log('🚰 Faucets start');
    for (const [k, url] of Object.entries(endpoints)) {
      try { await axios.post(url, { address: this.address }); console.log(`✔️ ${k}`); } catch { console.error(`❌ ${k}`); }
      await this.delay(this.config.delayMs);
    }
    console.log('🚰 Faucets done');
  }

  async runBot() {
    console.log(`🏃 Bot: ${this.address}`);
    await this.fetchIP();
    await this.checkStatus();
    await this.claimFaucets();
    for (const name of Object.keys(this.config.tokens)) {
      if (this.config.routers[name]) {
        await this.swapToken(name);
      } else {
        const custom = name === 'vnusd' ? '0x46a658a0Ad1750d37B4e6810EB59cBDf591Dc30' : null;
        await this.stakeToken(name, custom);
      }
      await this.delay(this.config.delayMs);
    }
    await this.checkStatus();
    console.log(`✅ Done ${this.address}`);
  }
}

// Execute bots
(async () => {
  const keys = getPrivateKeys();
  for (const pk of keys) {
    await new WalletBot(pk, globalConfig).runBot();
  }
})();
