const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();
const HttpsProxyAgentModule = require('https-proxy-agent');

const CONFIG = {
  RPC: 'https://arbitrum-sepolia.gateway.tenderly.co',
  CHAIN_ID: 421614,
  GAS: {
    LIMIT: 1000000,
    MAX_FEE: ethers.utils.parseUnits('2', 'gwei'),
    MAX_PRIORITY: ethers.utils.parseUnits('1', 'gwei'),
    DELAY: 17000
  },
  RETRY: {
    MAX_ATTEMPTS: 3,
    DELAY: 10000
  },
  TOKENS: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath: '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd: '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde: '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd: '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd: '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
    vnusd: '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8'
  },
  ROUTERS: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath: '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd: '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },
  STAKE: {
    ausd: '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde: '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd: '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60'
  },
  METHODS: {
    virtualSwap: '0xa6d67510',
    athSwap: '0x1bf6318b',
    vnusdSwap: '0xa6d67510',
    stake: '0xa694fc3a'
  },
  FAUCETS: {
    ath: 'https://app.x-network.io/maitrix-faucet/faucet',
    usde: 'https://app.x-network.io/maitrix-usde/faucet',
    lvlusd: 'https://app.x-network.io/maitrix-lvl/faucet',
    virtual: 'https://app.x-network.io/maitrix-virtual/faucet',
    vana: 'https://app.x-network.io/maitrix-vana/faucet'
  }
};


class DexBot {constructor(privateKey, proxyString) {
  this.privateKey  = privateKey;
  this.provider    = new ethers.providers.JsonRpcProvider(CONFIG.RPC);
  this.wallet      = new ethers.Wallet(privateKey, this.provider);
  this.proxyString = proxyString?.trim() || null;
  this.httpsAgent  = this.createProxyAgent();
}
              
  createProxyAgent() {
  if (!this.proxyString) return null;

  // Tambahkan schema jika perlu
  let proxyUrl = this.proxyString;
  if (!/^https?:\/\//i.test(proxyUrl)) {
    proxyUrl = 'http://' + proxyUrl;
  }
  console.log('▶️ Using proxy URL:', proxyUrl);

  // Ambil class HttpsProxyAgent dari modul yang benar
  const AgentClass = HttpsProxyAgentModule.HttpsProxyAgent;
  return new AgentClass(proxyUrl);
}

  async verifyProxy() {
    if (!this.httpsAgent) return false;
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        httpsAgent: this.httpsAgent,
        timeout: 10000,
        rejectUnauthorized: false
      });
      console.log(`✅ Proxy Active | IP: ${response.data.ip}`);
      return true;
    } catch (e) {
      console.log('❌ Proxy verification failed:', e.message);
      return false;
    }
  }

  async httpRequest(url, data) {
    if (!this.httpsAgent) throw new Error('No proxy configured');
    
    try {
      return await axios.post(url, data, {
        httpsAgent: this.httpsAgent,
        timeout: 15000,
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
    } catch (e) {
      console.log(`⚠️ Proxy error: ${e.message}`);
      throw e;
    }
  }

  async withRetry(fn, operationName) {
    for (let attempt = 1; attempt <= CONFIG.RETRY.MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (e) {
        console.log(`[${operationName}] Attempt ${attempt} failed: ${e.message}`);
        if (attempt === CONFIG.RETRY.MAX_ATTEMPTS) throw e;
        await delay(CONFIG.RETRY.DELAY);
      }
    }
  }

  async claimFaucets() {
    if (!await this.verifyProxy()) return;
    
    for (const [token, url] of Object.entries(CONFIG.FAUCETS)) {
      await this.withRetry(async () => {
        await this.httpRequest(url, { address: this.wallet.address });
        console.log(`✅ Claimed ${token} faucet`);
      }, `faucet-${token}`);
      await delay(CONFIG.GAS.DELAY);
    }
  }

  async processToken(tokenName) {
    const tokenAddress = CONFIG.TOKENS[tokenName];
    const router = CONFIG.ROUTERS[tokenName];
    const methodId = CONFIG.METHODS[`${tokenName}Swap`];

    return this.withRetry(async () => {
      const contract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
      const balance = await contract.balanceOf(this.wallet.address);
      if (balance.isZero()) throw new Error('Zero balance');
      
      const approveTx = await contract.approve(router, balance, CONFIG.GAS);
      await approveTx.wait();

      const txData = methodId + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({
        to: router,
        data: txData,
        ...CONFIG.GAS
      });
      await tx.wait();
      console.log(`🔄 Swapped ${tokenName}`);
    }, `swap-${tokenName}`);
  }

  async stakeToken(tokenName) {
    const stakeContract = CONFIG.STAKE[tokenName];
    
    return this.withRetry(async () => {
      const contract = new ethers.Contract(CONFIG.TOKENS[tokenName], erc20Abi, this.wallet);
      const balance = await contract.balanceOf(this.wallet.address);
      if (balance.isZero()) throw new Error('Zero balance');
      
      const approveTx = await contract.approve(stakeContract, balance, CONFIG.GAS);
      await approveTx.wait();

      const txData = CONFIG.METHODS.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({
        to: stakeContract,
        data: txData,
        ...CONFIG.GAS
      });
      await tx.wait();
      console.log(`🔒 Staked ${tokenName}`);
    }, `stake-${tokenName}`);
  }

  async run() {
    console.log(`\n🔷 Starting ${this.wallet.address.slice(0,8)}...`);
    
    try {
      const ethBalance = await this.provider.getBalance(this.wallet.address);
      console.log(`💎 ETH Balance: ${ethers.utils.formatEther(ethBalance)}`);

      await this.claimFaucets();

      for (const token of Object.keys(CONFIG.TOKENS)) {
        await this.processToken(token);
        await delay(CONFIG.GAS.DELAY);
      }

      for (const token of Object.keys(CONFIG.STAKE)) {
        await this.stakeToken(token);
        await delay(CONFIG.GAS.DELAY);
      }

    } catch (e) {
      await sendReport(`❌ Error: ${e.message}`);
    }
  }
}

const erc20Abi = [
  'function balanceOf(address) view returns (uint)',
  'function approve(address, uint) returns (bool)'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  let proxyString = fs.readFileSync('proxies.txt', 'utf-8').trim();
  if (!proxyString) {
    console.warn('⚠️ proxies.txt kosong, semua request akan langsung ke RPC tanpa proxy');
    proxyString = null;
  }
  // Kumpulkan private keys dari environment variables
  const keys = [];
  if (process.env.PRIVATE_KEY) {
    keys.push(process.env.PRIVATE_KEY);
  }
  let idx = 1;
  while (process.env[`PRIVATE_KEY_${idx}`]) {
    keys.push(process.env[`PRIVATE_KEY_${idx}`]);
    idx++;
  }

  // Jalankan bot untuk setiap key
  for (const key of keys) {
    const bot = new DexBot(key, proxyString);
    await bot.run();

    // Jika ada lebih dari satu key, beri jeda 30 detik antar bot
    if (keys.length > 1) {
      await delay(30000);
    }
  }
}

// Helper delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Eksekusi main dan tangani error
main().catch(console.error);
