const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const dns = require('dns').promises;
require('dotenv').config();

// ======================== 🛠 HELPER FUNCTIONS ========================
const debugStream = fs.createWriteStream(
  path.join(__dirname, 'debugging.log'), 
  { flags: 'a' }
);

function debugLog(...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : arg
  ).join(' ');
  debugStream.write(`[${timestamp}] ${message}\n`);
}

function getPrivateKeys() {
  const keys = [];
  let idx = 1;
  while (process.env[`PRIVATE_KEY_${idx}`]) {
    keys.push(process.env[`PRIVATE_KEY_${idx}`]);
    idx++;
  }
  if (keys.length === 0 && process.env.PRIVATE_KEY) {
    keys.push(process.env.PRIVATE_KEY);
  }
  if (keys.length === 0) {
    throw new Error("No private keys found in .env!");
  }
  return keys;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================== ⚙️ CONFIGURATION ========================
const erc20Abi = [
  'function balanceOf(address) view returns (uint)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address, uint) returns (bool)'
];

const PROXIES = [
  'http://user1:pass1@proxy1.example.com:8080',
  'http://user2:pass2@proxy2.example.com:8080'
];

const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath:     '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd:    '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde:    '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd:  '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd:    '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
    vnusd:   '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8',
    azusd:   '0x2d5a4f5634041f50180A25F26b2A8364452E3152'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:   '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f',
    azusd:   '0xb0b53d8b4ef06f9bbe5db624113c6a5d35bb7522'
  },
  stakeContracts: {
    ausd:  '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:  '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd:'0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:  '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60',
    azusd: '0xf45fde3f484c44cc35bdc2a7fca3ddde0c8f252e'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap:     '0x1bf6318b',
    vnusdSwap:   '0xa6d67510',
    azusdSwap:   '0xa6d67510',
    stake:       '0xa694fc3a'
  },
  gasLimit: 1000000,
  maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
  maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
  delayMs: 17000
};

// ======================== 🤖 WALLET BOT CLASS ========================

class WalletBot {

constructor(privateKey, proxyUrl, config) {
  if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
    throw new Error("Invalid private key!");
  }
  // simpan untuk init nanti
  this._key      = privateKey;
  this._proxyUrl = proxyUrl;
  this._config   = config;
  // default sebelum init
  this.axios     = axios;
  this.agent     = null;
}

  // 3. Tambahkan method init() di dalam class, tepat setelah constructor:
async init() {
  try {
    // cek DNS & setup proxy
    await this._setupProxy(this._proxyUrl);
    this.provider = new ethers.providers.JsonRpcProvider({
      url: this._config.rpc,
      fetchOptions: this.agent ? { agent: this.agent } : undefined
    });
  } catch (e) {
    console.warn('⚠️ Proxy setup gagal, lanjut tanpa proxy:', e.message);
    this.provider = new ethers.providers.JsonRpcProvider(this._config.rpc);
  }
  this.wallet  = new ethers.Wallet(this._key, this.provider);
  this.address = this.wallet.address;
}

  async claimFaucets() {
    console.log(`\n=== Claim Faucets for ${this.address} ===`);
    const endpoints = {
      ath:     'https://app.x-network.io/maitrix-faucet/faucet',
      usde:    'https://app.x-network.io/maitrix-usde/faucet',
      lvlusd:  'https://app.x-network.io/maitrix-lvl/faucet',
      virtual: 'https://app.x-network.io/maitrix-virtual/faucet',
      vana:    'https://app.x-network.io/maitrix-vana/faucet',
      ai16z:    'https://app.x-network.io/maitrix-ai16z/faucet'
    };
    
    for (const [tk, url] of Object.entries(endpoints)) {
      try {
        const res = await this.axios.post(url, { address: this.address });
        if (res.status === 200) console.log(`✓ Claimed ${tk}`);
      } catch (e) {
        console.error(`✗ Claim ${tk} failed:`, e.response?.data || e.message);
      }
      await delay(this.config.delayMs);
    }
  }

  async getTokenBalance(tokenAddr) {
    try {
      const contract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
      const [balance, decimals, symbol] = await Promise.all([
        contract.balanceOf(this.address),
        contract.decimals(),
        contract.symbol().catch(() => 'UNKNOWN')
      ]);
      return {
        balance,
        formatted: ethers.utils.formatUnits(balance, decimals),
        symbol
      };
    } catch (e) {
      debugLog('BALANCE_ERROR', e);
      return { balance: ethers.constants.Zero, formatted: '0', symbol: 'ERR' };
    }
  }

  async getEthBalance() {
    const balance = await this.provider.getBalance(this.address);
    return { balance, formatted: ethers.utils.formatEther(balance) };
  }

  async checkWalletStatus() {
    console.log(`\n=== Wallet ${this.address.slice(0,8)}... ===`);
    try {
      const eth = await this.getEthBalance();
      console.log(`ETH: ${eth.formatted}`);
      for (const [name, addr] of Object.entries(this.config.tokens)) {
        const { formatted, symbol } = await this.getTokenBalance(addr);
        console.log(`${symbol.padEnd(6)}: ${formatted}`);
      }
    } catch (e) {
      console.error('Status check failed:', e.message);
    }
  }

  async swapToken(tokenName) {
    try {
      console.log(`\nSwapping ${tokenName}...`);
      const tokenAddr = this.config.tokens[tokenName];
      const router    = this.config.routers[tokenName];
      const methodId  = this.config.methodIds[`${tokenName}Swap`];

      if (!router || !methodId) throw new Error('Invalid router config!');

      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) {
        console.log('Skipping: Zero balance');
        return;
      }

      const approveTx = await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(router, balance, {
          gasLimit: this.config.gasLimit,
          maxFeePerGas: this.config.maxFeePerGas,
          maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
        });
      await approveTx.wait();
      await delay(this.config.delayMs);

      const data = methodId + ethers.utils.defaultAbiCoder
        .encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({
        to: router,
        data,
        gasLimit: this.config.gasLimit,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
      });
      console.log(`TX Hash: ${tx.hash}`);
      await tx.wait();
      console.log(`Swapped ${formatted} ${symbol}`);

    } catch (e) {
      console.error(`Swap failed: ${e.message}`);
      debugLog('SWAP_ERROR', e);
    }
  }

  async stakeToken(tokenName, customAddr = null) {
    try {
      console.log(`\nStaking ${tokenName}...`);
      const tokenAddr = customAddr || this.config.tokens[tokenName];
      const stakeContract = this.config.stakeContracts[tokenName];

      if (!stakeContract) throw new Error('Invalid stake contract!');

      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) {
        console.log('Skipping: Zero balance');
        return;
      }

      const approveTx = await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(stakeContract, balance, {
          gasLimit: this.config.gasLimit,
          maxFeePerGas: this.config.maxFeePerGas,
          maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
        });
      await approveTx.wait();
      await delay(this.config.delayMs);

      const data = this.config.methodIds.stake
        + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({
        to: stakeContract,
        data,
        gasLimit: this.config.gasLimit,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
      });
      console.log(`TX Hash: ${tx.hash}`);
      await tx.wait();
      console.log(`Staked ${formatted} ${symbol}`);
      await sendReport(`✅ Stake *${tokenName}* berhasil\nHash: \`${tx.hash}\`\nJumlah: ${formatted} ${symbol}`);

    } catch (e) {
      console.error(`Stake failed: ${e.message}`);
      debugLog('STAKE_ERROR', e);
    }
  }

  async runBot() {
    try {
      console.log(`\n🚀 Starting bot for ${this.address}`);
      await this.claimFaucets();
      await this.checkWalletStatus();
      await this.swapToken('virtual');
      await this.swapToken('ath');
      await this.swapToken('vnusd');
      await this.stakeToken('ausd');
      await this.stakeToken('usde');
      await this.stakeToken('lvlusd');
      await this.stakeToken('vusd');
      await this.stakeToken('vnusd', '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30');
      await this.stakeToken('azusd', '0x5966cd11aED7D68705C9692e74e5688C892cb162');
      await this.checkWalletStatus();
      console.log(`✅ Finished ${this.address}`);
    } catch (e) {
      console.error(`Bot error: ${e.message}`);
      debugLog('BOT_ERROR', e);
    }
  }

  async getCurrentIp() {
    try {
      const res = await this.axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
      return res.data.ip;
    } catch (e) {
      console.warn(`⚠️ Failed to fetch IP for ${this.address}:`, e.message);
      return null;
    }
  }
}

(async () => {
  console.log('🔌 Initializing bot...');

  const keys = getPrivateKeys();
  const proxies = PROXIES;
  console.log(`🛡️ Using ${proxies.length} hardcoded proxy(s)`);
  console.log(`🔑 Loaded ${keys.length} wallet(s)`);
  for (const [index, key] of keys.entries()) {
    const proxyUrl = proxies[index % proxies.length] || null;
    const bot = new WalletBot(key, proxyUrl, globalConfig);
    await bot.init();
    const ip = await bot.getCurrentIp();
    console.log(`🌍 Current IP: ${ip || 'No proxy detected'}`);
    await bot.runBot();
    await delay(globalConfig.delayMs);
  }

  console.log('\n🔄 Scheduling next run (24 hours)');
  setTimeout(() => process.exit(0), 24 * 60 * 60 * 1000);
})();

// ======================== 🛡 ERROR HANDLING ========================
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  debugLog('UNHANDLED_REJECTION', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  debugLog('UNCAUGHT_EXCEPTION', error);
  process.exit(1);
});
