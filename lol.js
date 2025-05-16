// multiAccountBot.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // gunakan v2 untuk CommonJS
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

// Utility: load proxies from file\ nfunction loadProxiesFromFile(filename = 'proxies.txt') {
  const filePath = path.resolve(__dirname, filename);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line);
  console.log('[loadProxiesFromFile] proxies loaded:', lines);
  return lines;
}

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
  tokens: { /* ... isi seperti sebelumnya ... */ },
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
  while (process.env[`PRIVATE_KEY_${idx}`]) {
    privateKeys.push(process.env[`PRIVATE_KEY_${idx}`]);
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

    // Setup agent jika perlu
    const agent = proxyUrl
      ? (proxyUrl.startsWith('socks')
          ? new SocksProxyAgent(proxyUrl)
          : new HttpsProxyAgent(proxyUrl))
      : null;

    // Provider dengan fetch override jika agent
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: config.rpc, fetch: (url, opts) => fetch(url, { agent, ...opts }) })
      : new ethers.providers.JsonRpcProvider(config.rpc);

    // HTTP client (faucets, IP check)
    this.http = agent
      ? axios.create({ httpAgent: agent, httpsAgent: agent })
      : axios;

    // Wallet
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;

    console.log(`[WalletBot] Initialized ${this.address}, proxy: ${proxyUrl}`);
  }

  async delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async getTokenBalance(addr) {
    const c = new ethers.Contract(addr, erc20Abi, this.wallet);
    const decimals = await c.decimals();
    const bal = await c.balanceOf(this.address);
    const symbol = await c.symbol().catch(() => 'TOKEN');
    return { balance: bal, decimals, formatted: ethers.utils.formatUnits(bal, decimals), symbol };
  }

  async getEthBalance() {
    const w = await this.provider.getBalance(this.address);
    return { balance: w, formatted: ethers.utils.formatEther(w) };
  }

  async swapToken(name) {
    try {
      // Debug IP via proxy
      const { data } = await this.http.get('https://api.ipify.org?format=json');
      console.log(`[swapToken] ${this.address} uses IP: ${data.ip}`);

      const tokenAddr = this.config.tokens[name];
      const router = this.config.routers[name];
      const methodId = this.config.methodIds[`${name}Swap`];
      if (!router || !methodId) return;

      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) return;

      await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(router, balance, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice })
        .then(tx => tx.wait());
      await this.delay(this.config.delayMs);

      const dataPayload = methodId + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      await this.wallet.sendTransaction({ to: router, data: dataPayload, gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice })
        .then(tx => tx.wait());
      await this.delay(this.config.delayMs);
      console.log(`Swapped ${formatted} ${symbol}`);
    } catch (e) {
      console.error(`swapToken error ${name}:`, e.message);
    }
  }

  async stakeToken(name, custom) {
    try {
      const tokenAddr = custom || this.config.tokens[name];
      const stakeCt = this.config.stakeContracts[name];
      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (!stakeCt || balance.isZero()) return;

      await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(stakeCt, balance, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice })
        .then(tx => tx.wait());
      await this.delay(this.config.delayMs);

      const dataPayload = this.config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const receipt = await this.wallet.sendTransaction({ to: stakeCt, data: dataPayload, gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice })
        .then(tx => tx.wait());
      await this.delay(this.config.delayMs);

      console.log(`Staked ${formatted} ${symbol}`);
      await sendReport(formatStakingReport(symbol, formatted, receipt.transactionHash));
    } catch (e) {
      console.error(`stakeToken error ${name}:`, e.message);
    }
  }

  async claimFaucets() {
    const endpoints = { /* ... */ };
    for (const [tk, url] of Object.entries(endpoints)) {
      try {
        const { data } = await this.http.post(url, { address: this.address });
        console.log(`[claimFaucets] ${tk} status: ${data.status || 'success'}`);
      } catch (e) {
        console.error(`claimFaucets error ${tk}:`, e.message);
      }
      await this.delay(this.config.delayMs);
    }
  }

  async checkWalletStatus() {
    const eth = await this.getEthBalance();
    console.log(`\n=== Status ${this.address} ===`);
    console.log(`ETH: ${eth.formatted}`);
    for (const [name, addr] of Object.entries(this.config.tokens)) {
      const { formatted, symbol } = await this.getTokenBalance(addr);
      console.log(`${symbol} (${name}): ${formatted}`);
    }
  }

  async runBot() {
    console.log(`\n>>> Running bot for ${this.address}`);
    await this.checkWalletStatus();
    await this.claimFaucets();
    for (const name of ['virtual', 'ath', 'vnusd', 'azusd']) {
      await this.swapToken(name);
    }
    for (const name of Object.keys(this.config.stakeContracts)) {
      const override = name === 'vnusd'
        ? '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30'
        : name === 'azusd'
          ? '0x5966cd11aED7D68705C9692e74e5688C892cb162'
          : null;
      await this.stakeToken(name, override);
    }
    await this.checkWalletStatus();
    console.log(`<<< Finished ${this.address}`);
  }
}

async function runAllBots() {
  console.log('=== Starting multi-account bot ===');

  const keys = getPrivateKeys();
  const proxiesList = loadProxiesFromFile('proxies.txt');

  for (let i = 0; i < keys.length; i++) {
    const proxy = proxiesList.length > 0 ? proxiesList[i % proxiesList.length] : null;
    console.log(`\n--- Account ${i+1}/${keys.length} ---`);
    const bot = new WalletBot(keys[i], globalConfig, proxy);

    // Print IP before operations
    try {
      const { data } = await bot.http.get('https://api.ipify.org?format=json');
      console.log(`Account ${i+1} (${bot.address}) using IP: ${data.ip}`);
    } catch (e) {
      console.error(`Error fetching IP for account ${i+1}:`, e.message);
    }

    await bot.runBot();
    await bot.delay(globalConfig.delayMs);
  }

  console.log('=== All accounts done ===');
}

runAllBots()
  .then(() => console.log('Execution finished'))
  .catch(e => console.error('Error:', e));

setInterval(runAllBots, 24 * 60 * 60 * 1000);
