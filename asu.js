require('dotenv').config();
const { execSync } = require('child_process');
const fetch = require('node-fetch');
const { computeFees } = require('./utils');
const { ProxyAgent } = require('proxy-agent');
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
const { SocksProxyAgent } = require('socks-proxy-agent');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const dns = require('dns').promises;

const TOR_PROXY = process.env.TOR_PROXY || null;

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
    azusd:   '0x2d5a4f5634041f50180A25F26b2A8364452E3152',
    usd1:   '0x16a8A3624465224198d216b33E825BcC3B80abf7'
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
    azusd: '0xf45fde3f484c44cc35bdc2a7fca3ddde0c8f252e',
    usd1: '0x7799841734Ac448b8634F1c1d7522Bc8887A7bB9'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap:     '0x1bf6318b',
    vnusdSwap:   '0xa6d67510',
    azusdSwap:   '0xa6d67510',
    stake:       '0xa694fc3a'
  },
  gasLimit: 1000000,
  delayMs: 20000
};

// ======================== 🤖 WALLET BOT CLASS ========================
class WalletBot {
  constructor(privateKey, config, proxyUrl) {
    this._key      = privateKey;
    this._proxyUrl = proxyUrl;     // e.g. process.env.TOR_PROXY
    this.config    = config;
    this.axios     = axios;
    this.agent     = null;
    this._reportBuffer = [];
  }

  async rotateTorIdentity() {
    try {
      const cookie = execSync('xxd -ps /run/tor/control.authcookie').toString().trim();
      execSync(`printf "AUTHENTICATE ${cookie}\r\nSIGNAL NEWNYM\r\n" | nc localhost 9051`);
      console.log('🔄 Tor: requested new circuit');
    } catch (e) {
      console.warn('⚠️ rotateTorIdentity error:', e.message);
    }
  }

  async _setupProxy() {
    if (!this._proxyUrl) {
      console.log('🌐 No proxy configured');
      return;
    }
    this.agent = new SocksProxyAgent(this._proxyUrl);
    console.log(`🛡️ Using SOCKS proxy: ${this._proxyUrl}`);
    this.axios = axios.create({
      httpAgent: this.agent,
      httpsAgent: this.agent,
      proxy: false,
      timeout: 10000,
    });
  }

  async init() {
    await this._setupProxy();
    this.provider = new ethers.providers.JsonRpcProvider({
      url: this.config.rpc,
      fetch: (url, init) => fetch(url, { ...init, agent: this.agent })
    });
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
      ai16z:   'https://app.x-network.io/maitrix-ai16z/faucet',
      usd1:   'https://app.x-network.io/maitrix-usd1/faucet'
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
      if (balance.isZero()) return console.log('Skipping: Zero balance');
      const { maxFeePerGas: feeA, maxPriorityFeePerGas: priA } = await computeFees(this.provider);
      const approveData = new ethers.utils.Interface(erc20Abi).encodeFunctionData('approve', [router, balance]);
      const txA = await this.wallet.sendTransaction({
        to: tokenAddr,
        data: approveData,
        gasLimit: this.config.gasLimit,
        maxFeePerGas: feeA,
        maxPriorityFeePerGas: priA
      });
      console.log(`Approve TX: ${txA.hash}`);
      await txA.wait();
      await delay(this.config.delayMs);
      const { maxFeePerGas, maxPriorityFeePerGas } = await computeFees(this.provider);
      const tx = await this.wallet.sendTransaction({
        to: router,
        data: methodId + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2),
        gasLimit: this.config.gasLimit,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas
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
      const tokenAddr     = customAddr || this.config.tokens[tokenName];
      const stakeContract = this.config.stakeContracts[tokenName];
      if (!stakeContract) throw new Error('Invalid stake contract!');
      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) return console.log('Skipping: Zero balance');
      const { maxFeePerGas: feeA, maxPriorityFeePerGas: priA } = await computeFees(this.provider);
      const approveData = new ethers.utils.Interface(erc20Abi).encodeFunctionData('approve', [stakeContract, balance]);
      const txA = await this.wallet.sendTransaction({
        to: tokenAddr,
        data: approveData,
        gasLimit: this.config.gasLimit,
        maxFeePerGas: feeA,
        maxPriorityFeePerGas: priA
      });
      console.log(`Approve TX: ${txA.hash}`);
      await txA.wait();
      await delay(this.config.delayMs);
      const { maxFeePerGas, maxPriorityFeePerGas } = await computeFees(this.provider);
      const tx = await this.wallet.sendTransaction({
        to: stakeContract,
        data: this.config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2),
        gasLimit: this.config.gasLimit,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas
      });
      console.log(`TX Hash: ${tx.hash}`);
      await tx.wait();
      console.log(`Staked ${formatted} ${symbol}`);
      this._reportBuffer.push(
        `✅ Stake *${tokenName}* berhasil\n` +
        `Hash: \`${tx.hash}\`\n` +
        `Jumlah: ${formatted} ${symbol}`
      );
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
      await this.swapToken('azusd');
      await this.stakeToken('ausd');
      await this.stakeToken('usde');
      await this.stakeToken('lvlusd');
      await this.stakeToken('vusd');
      await this.stakeToken('vnusd', '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30');
      await this.stakeToken('azusd', '0x5966cd11aED7D68705C9692e74e5688C892cb162');
      await this.stakeToken('usd1');
      if (this._reportBuffer.length > 0) {
        const fullReport = this._reportBuffer.join('\n\n');
        await sendReport(fullReport);
        this._reportBuffer = [];
      }
      await this.checkWalletStatus();
      console.log(`✅ Finished ${this.address}`);
    } catch (e) {
      console.error(`Bot error: ${e.message}`);
      debugLog('BOT_ERROR', e);
    }
  }

  async getCurrentIp() {
    const services = [
      {
        url: 'https://api.ipify.org?format=json',
        parse: res => res.data.ip
      },
      {
        url: 'https://ifconfig.co/json',
        parse: res => res.data.ip
      },
      {
        url: 'https://ident.me',
        parse: res => res.data.trim()
      }
    ];

    for (const svc of services) {
      try {
        const res = await this.axios.get(svc.url);
        const ip  = svc.parse(res);
        console.log(`🌍 Proxy IP (via ${svc.url}): ${ip}`);
        return ip;
      } catch (err) {
        console.warn(`⚠️ IP fetch failed at ${svc.url}: ${err.response?.status || err.message}`);
      }
    }

    console.error('❌ Semua endpoint IP gagal, IP tetap null');
    return null;
  }
}

module.exports = WalletBot;


(async () => {
  console.log('🔌 Initializing bot...');

  const keys = getPrivateKeys();
  const torProxy = process.env.TOR_PROXY;
  for (let i = 0; i < keys.length; i++) {
    const bot = new WalletBot(keys[i], globalConfig, torProxy);
    await bot.rotateTorIdentity();
    await delay(65000);
    await bot.init();
    console.log(`🌍 Wallet ${i+1} IP:`, await bot.getCurrentIp());
    await bot.runBot();
    await delay(globalConfig.delayMs);
  }

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
