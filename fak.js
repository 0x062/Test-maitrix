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
  return fs.readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

function formatStakingReport(token, amount, tx) {
  return `🚀🎉 *Staking Berhasil!* 🎉🚀\n*Token:* ${token}\n*Jumlah:* ${amount}\n*TxHash:* \`${tx}\``;
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
  delayMs: 15000
};

const erc20Abi = [ /* ... */ ];

function getPrivateKeys() {
  const keys = [];
  let i = 1;
  while (process.env[`PRIVATE_KEY_${i}`]) {
    keys.push(process.env[`PRIVATE_KEY_${i}`]);
    i++;
  }
  if (keys.length === 0 && process.env.PRIVATE_KEY) keys.push(process.env.PRIVATE_KEY);
  return keys;
}

class WalletBot {
  /* ... constructor and methods ... */
}

(async function main() {
  const keys = getPrivateKeys();
  console.log(`🔑 Found ${keys.length} private key(s)`);
  if (keys.length === 0) {
    console.error('❌ No private keys found. Please set PRIVATE_KEY or PRIVATE_KEY_1 in your .env file');
    return;
  }

  const proxies = loadProxiesFromFile();
  console.log(`🛡️ Loaded ${proxies.length} proxy entries`);

  for (let i = 0; i < keys.length; i++) {
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    console.log(`🚀 Starting bot for account ${i + 1}`);
    const bot = new WalletBot(keys[i], globalConfig, proxy);

    try {
      const ip = await bot.http.get('https://api.ipify.org?format=json');
      console.log(`🌐 Account ${i + 1}/${keys.length} IP: ${ip.data.ip}`);
    } catch (e) {
      console.warn(`⚠️ Could not fetch IP for account ${i + 1}: ${e.message}`);
    }

    await bot.runBot();
    await bot.delay(globalConfig.delayMs);
  }

  console.log('✨ All done');
})();
