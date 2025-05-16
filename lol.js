// multiAccountBot.js
const fs = require('fs');
const path = require('path');
// Pastikan menggunakan node-fetch v2 untuk CommonJS
const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

// Utility: load proxies from file
function loadProxiesFromFile(filename = 'proxies.txt') {
  const filePath = path.resolve(__dirname, filename);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line);
  console.log('[loadProxiesFromFile] proxies loaded:', lines);
  return lines;
}

// Format message untuk Telegram
function formatStakingReport(token, amount, txHash) {
  return (
    `🚀🎉 *Staking Berhasil!* 🎉🚀\n` +
    `*Token:* ${token}\n` +
    `*Jumlah:* ${amount}\n` +
    `*TxHash:* \`${txHash}\``
  );
}

const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: { /* ... */ },
  routers: { /* ... */ },
  stakeContracts: { /* ... */ },
  methodIds: { /* ... */ },
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
  const privateKeys = [];
  let idx = 1;
  while (true) {
    const key = process.env[`PRIVATE_KEY_${idx}`];
    if (!key) break;
    privateKeys.push(key);
    idx++;
  }
  if (privateKeys.length === 0 && process.env.PRIVATE_KEY) {
    privateKeys.push(process.env.PRIVATE_KEY);
  }
  return privateKeys;
}

class WalletBot {
  constructor(privateKey, config, proxyUrl = null) {
    this.config = config;
    this.proxyUrl = proxyUrl;
    console.log(`[WalletBot] Creating bot for ${privateKey.slice(-4)}, proxy: ${proxyUrl}`);

    if (proxyUrl) {
      const agent = proxyUrl.startsWith('socks')
        ? new SocksProxyAgent(proxyUrl)
        : new HttpsProxyAgent(proxyUrl);

      this.provider = new ethers.providers.JsonRpcProvider({
        url: config.rpc,
        fetch: (url, opts) => fetch(url, { agent, ...opts })
      });
      this.http = axios.create({ httpAgent: agent, httpsAgent: agent });
    } else {
      this.provider = new ethers.providers.JsonRpcProvider(config.rpc);
      this.http = axios;
    }

    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
  }

  async delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async getTokenBalance(tokenAddr) { /* unchanged */ }
  async getEthBalance() { /* unchanged */ }

  async swapToken(tokenName) {
    try {
      // Debug IP via proxy before actions
      const ipInfo = await this.http.get('https://api.ipify.org?format=json');
      console.log(`[swapToken] Using IP: ${ipInfo.data.ip}`);

      // existing swap logic...
    } catch (e) {
      console.error(`swapToken error for ${tokenName}:`, e);
      return false;
    }
  }

  async stakeToken(tokenName, customAddr = null) { /* unchanged */ }

  async checkWalletStatus() { /* unchanged */ }

  async claimFaucets() {
    // use this.http for all axios calls
    const endpoints = { /* ... */ };
    for (const [tk, url] of Object.entries(endpoints)) {
      console.log(`[claimFaucets] Claiming ${tk} via proxy: ${this.proxyUrl}`);
      try {
        const res = await this.http.post(url, { address: this.address });
        console.log(`status ${res.status}`);
      } catch (e) {
        console.error(`claimFaucets ${tk} error:`, e.message);
      }
      await this.delay(this.config.delayMs);
    }
  }

  async runBot() {
    console.log(`\n>>> Running bot for ${this.address}`);
    await this.checkWalletStatus();
    await this.claimFaucets();
    // ... rest of logic ...
    console.log(`<<< Finished ${this.address}`);
  }
}

// Main loop: load keys & proxies, then run
async function runAllBots() {
  console.log('=== Starting multi-account bot ===');

  const keys    = getPrivateKeys();
  let proxies   = loadProxiesFromFile('proxies.txt');
  while (proxies.length < keys.length) proxies.push(null);
  if (proxies.length > keys.length) proxies.length = keys.length;

  console.log('Proxies array:', proxies);

  for (let i = 0; i < keys.length; i++) {
    console.log(`\n--- Account ${i+1}/${keys.length}, proxy: ${proxies[i]} ---`);
    const bot = new WalletBot(keys[i], globalConfig, proxies[i]);
    await bot.runBot();
    await bot.delay(globalConfig.delayMs);
  }

  console.log('=== All accounts done ===');
}

// Jalankan sekarang dan setiap 24 jam
runAllBots()
  .then(() => console.log('Execution finished'))
  .catch(e => console.error('Error:', e));

setInterval(runAllBots, 24 * 60 * 60 * 1000);
