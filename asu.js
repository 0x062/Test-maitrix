const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

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

class DexBot {
  constructor(privateKey, proxies) {
    this.privateKey = privateKey;
    this.proxies = proxies;
    this.provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.currentProxy = this.getRandomProxy();
  }

  getRandomProxy() {
    const proxy = this.proxies[Math.floor(Math.random() * this.proxies.length)];
    const [host, port] = proxy.split(':');
    return { host, port };
  }

  async showProxyIP() {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        proxy: {
          host: this.currentProxy.host,
          port: this.currentProxy.port
        }
      });
      console.log(`Using Proxy IP: ${response.data.ip}`);
    } catch (e) {
      console.log('Failed to get proxy IP');
    }
  }

  async httpRequest(url, data) {
    try {
      await this.showProxyIP();
      return await axios.post(url, data, {
        proxy: {
          host: this.currentProxy.host,
          port: this.currentProxy.port
        },
        timeout: 15000
      });
    } catch (e) {
      this.currentProxy = this.getRandomProxy();
      throw e;
    }
  }

  async withRetry(fn, operationName) {
    for (let attempt = 1; attempt <= CONFIG.RETRY.MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt === CONFIG.RETRY.MAX_ATTEMPTS) throw e;
        await delay(CONFIG.RETRY.DELAY);
      }
    }
  }

  async claimFaucets() {
    for (const [token, url] of Object.entries(CONFIG.FAUCETS)) {
      await this.withRetry(async () => {
        await this.httpRequest(url, { address: this.wallet.address });
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
      
      const approveTx = await contract.approve(router, balance, {
        gasLimit: CONFIG.GAS.LIMIT,
        maxFeePerGas: CONFIG.GAS.MAX_FEE,
        maxPriorityFeePerGas: CONFIG.GAS.MAX_PRIORITY
      });
      await approveTx.wait();

      const txData = methodId + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({
        to: router,
        data: txData,
        ...CONFIG.GAS
      });
      await tx.wait();
    }, `swap-${tokenName}`);
  }

  async stakeToken(tokenName) {
    const stakeContract = CONFIG.STAKE[tokenName];
    
    return this.withRetry(async () => {
      const contract = new ethers.Contract(CONFIG.TOKENS[tokenName], erc20Abi, this.wallet);
      const balance = await contract.balanceOf(this.wallet.address);
      if (balance.isZero()) throw new Error('Zero balance');
      
      const approveTx = await contract.approve(stakeContract, balance, {
        gasLimit: CONFIG.GAS.LIMIT,
        maxFeePerGas: CONFIG.GAS.MAX_FEE,
        maxPriorityFeePerGas: CONFIG.GAS.MAX_PRIORITY
      });
      await approveTx.wait();

      const txData = CONFIG.METHODS.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({
        to: stakeContract,
        data: txData,
        ...CONFIG.GAS
      });
      await tx.wait();
    }, `stake-${tokenName}`);
  }

  async run() {
    console.log(`\nAddress: ${this.wallet.address.slice(0,8)}...`);
    
    try {
      const ethBalance = await this.provider.getBalance(this.wallet.address);
      console.log(`ETH Balance: ${ethers.utils.formatEther(ethBalance)}`);

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
      await sendReport(`Error: ${e.message}`);
    }
  }
}

const erc20Abi = [
  'function balanceOf(address) view returns (uint)',
  'function approve(address, uint) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const proxies = fs.readFileSync('proxies.txt', 'utf-8').split('\n').filter(p => p.trim());
  const keys = [];
  let idx = 1;
  while (process.env[`PRIVATE_KEY_${idx}`]) {
    keys.push(process.env[`PRIVATE_KEY_${idx}`]);
    idx++;
  }
  if (process.env.PRIVATE_KEY) keys.push(process.env.PRIVATE_KEY);

  for (const [index, key] of keys.entries()) {
    const bot = new DexBot(key, proxies);
    await bot.run();
    if (index < keys.length - 1) await delay(30000);
  }
}

main().catch(console.error);
