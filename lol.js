// multiAccountBot.js
const { ethers } = require('ethers');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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

// ================================= PROXY LIST =================================
function getProxyUrls() {
  const filePath = path.join(__dirname, 'proxies.txt');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (e) {
    console.error('❌ Failed to read proxies.txt:', e.message);
    return [];
  }
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
  rpc: process.env.RPC_URL,
  chainId: 421614,
  tokens: {/* ... unchanged ... */},
  routers: {/* ... unchanged ... */},
  stakeContracts: {/* ... unchanged ... */},
  methodIds: {/* ... unchanged ... */},
  gasLimit: 1000000,
  maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
  maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
  delayMs: parseInt(process.env.DELAY_MS || '17000', 10)
};

// ======================== 🤖 WALLET BOT CLASS ========================
class WalletBot {
  constructor(privateKey, proxyUrl, config) {
    if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) throw new Error("Invalid private key!");
    this.config = config;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    this.provider = new ethers.providers.JsonRpcProvider({
      url: config.rpc,
      fetchOptions: agent ? { agent } : undefined
    });
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
    this.axios = proxyUrl ? axios.create({ httpsAgent: agent }) : axios;
  }
  // ... other methods unchanged ...
}

// ======================== 🚀 MAIN EXECUTION ========================
(async () => {
  try {
    console.log('🔌 Initializing bot...');
    const keys = getPrivateKeys();
    const proxies = getProxyUrls();

    if (proxies.length === 0) {
      console.warn('⚠️ No proxies found in proxies.txt, proceeding without proxy for all wallets');
    }

    console.log(`🔑 Loaded ${keys.length} wallet(s)` + (proxies.length ? ` and ${proxies.length} proxy(ies)` : ''));

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      // rotate only if proxies exist
      const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
      console.log(`\n💼 Processing wallet ${i + 1}/${keys.length}` + (proxy ? ` with proxy ${proxy}` : ''));
      const bot = new WalletBot(key, proxy, globalConfig);
      await bot.runBot();
      await delay(globalConfig.delayMs);
    }

    console.log('\n🔄 Scheduling next run (24 hours)');
    setTimeout(() => process.exit(0), 24 * 60 * 60 * 1000);
  } catch (e) {
    console.error('💀 Critical error:', e);
    process.exit(1);
  }
})();

// ======================== 🛡 ERROR HANDLING ========================
process.on('unhandledRejection', reason => {
  console.error('Unhandled Rejection:', reason);
  debugLog('UNHANDLED_REJECTION', reason);
});

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
  debugLog('UNCAUGHT_EXCEPTION', error);
  process.exit(1);
});
