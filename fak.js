// multiAccountBot.js
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
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

function getProxyUrls() {
  const filePath = path.join(__dirname, 'proxies.txt');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const proxies = content
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    if (!proxies.length) console.warn('⚠️ proxies.txt kosong, lanjut tanpa proxy');
    return proxies;
  } catch (e) {
    console.warn('⚠️ Gagal baca proxies.txt, lanjut tanpa proxy:', e.message);
    return [];
  }
}

// ======================== ⚙️ CONFIGURATION ========================
const erc20Abi = [
  'function balanceOf(address) view returns (uint)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address, uint) returns (bool)'
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
    vnusd:   '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:   '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },
  stakeContracts: {
    ausd:  '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:  '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd:'0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:  '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap:     '0x1bf6318b',
    vnusdSwap:   '0xa6d67510',
    stake:       '0xa694fc3a'
  },
  gasLimit: 1000000,
  maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
  maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
  delayMs: 17000
};

// ======================== 🤖 WALLET BOT CLASS ========================
// ======================== 🤖 WALLET BOT CLASS ========================
class WalletBot {
  constructor(privateKey, proxyUrl, config) {
    if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
      throw new Error("Invalid private key!");
    }

    this.config = config;

    // Setup HTTP(S) proxy agent if proxyUrl is provided
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    // JSON-RPC provider (with proxy)
    this.provider = new ethers.providers.JsonRpcProvider({
      url: config.rpc,
      fetchOptions: agent ? { agent } : undefined
    });

    // Wallet instance
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;

    // Axios instance for faucet requests (with proxy)
    this.axios = proxyUrl
      ? axios.create({ httpsAgent: agent })
      : axios;
  }

  async claimFaucets() {
    console.log(`\n=== Claim Faucets for ${this.address} ===`);
    const endpoints = {
      ath:     'https://app.x-network.io/maitrix-faucet/faucet',
      usde:    'https://app.x-network.io/maitrix-usde/faucet',
      lvlusd:  'https://app.x-network.io/maitrix-lvl/faucet',
      virtual: 'https://app.x-network.io/maitrix-virtual/faucet',
      vana:    'https://app.x-network.io/maitrix-vana/faucet'
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

      // Approve
      const approveTx = await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(router, balance, {
          gasLimit: this.config.gasLimit,
          maxFeePerGas: this.config.maxFeePerGas,
          maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
        });
      await approveTx.wait();
      await delay(this.config.delayMs);

      // Execute swap
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
      const tokenAddr    = customAddr || this.config.tokens[tokenName];
      const stakeContract = this.config.stakeContracts[tokenName];

      if (!stakeContract) throw new Error('Invalid stake contract!');

      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) {
        console.log('Skipping: Zero balance');
        return;
      }

      // Approve
      const approveTx = await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(stakeContract, balance, {
          gasLimit: this.config.gasLimit,
          maxFeePerGas: this.config.maxPriorityFeePerGas,
          maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
        });
      await approveTx.wait();
      await delay(this.config.delayMs);

      // Execute stake
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
      console.warn(`⚠️ Gagal fetch IP untuk ${this.address}:`, e.message);
      return null;
    }
  }
}

// ======================== 🚀 MAIN EXECUTION ========================
(async () => {
  // …
  for (let i = 0; i < keys.length; i++) {
    const key   = keys[i];
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    console.log(
      `\n💼 Processing wallet ${i + 1}/${keys.length}` +
      (proxy ? ` using proxy ${proxy}` : '')
    );

    const bot = new WalletBot(key, proxy, globalConfig);

    // ← Tambahan: fetch dan tampilkan IP
    const ip = await bot.getCurrentIp();
    if (ip) console.log(`🌐 IP untuk wallet ${bot.address}: ${ip}`);

    await bot.runBot();
    await delay(globalConfig.delayMs);
  }
  // …
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
