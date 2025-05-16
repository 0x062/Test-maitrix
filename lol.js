// multiAccountBot.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // node-fetch v2 for CommonJS
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

// Format staking report message
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
    const agent = proxyUrl
      ? (proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl))
      : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: config.rpc, fetch: (url, opts) => fetch(url, { agent, ...opts }) })
      : new ethers.providers.JsonRpcProvider(config.rpc);
    this.http = agent ? axios.create({ httpAgent: agent, httpsAgent: agent }) : axios;
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
    console.log(`[WalletBot] Initialized ${this.address}, proxy: ${proxyUrl}`);
  }

  async delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async getTokenBalance(addr) {
    const contract = new ethers.Contract(addr, erc20Abi, this.wallet);
    const decimals = await contract.decimals();
    const balance = await contract.balanceOf(this.address);
    const symbol = await contract.symbol().catch(() => 'TOKEN');
    return { balance, decimals, formatted: ethers.utils.formatUnits(balance, decimals), symbol };
  }

  async getEthBalance() {
    const balance = await this.provider.getBalance(this.address);
    return { balance, formatted: ethers.utils.formatEther(balance) };
  }

  async swapToken(name) {
    try {
      const ipRes = await this.http.get('https://api.ipify.org?format=json');
      console.log(`[swapToken] ${this.address} uses IP: ${ipRes.data.ip}`);
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
      const payload = methodId + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      await this.wallet.sendTransaction({ to: router, data: payload, gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice })
        .then(tx => tx.wait());
      await this.delay(this.config.delayMs);
      console.log(`Swapped ${formatted} ${symbol}`);
    } catch (e) {
      console.error(`swapToken error ${name}:`, e.message);
    }
  }

  async stakeToken(name, customAddr = null) {
    try {
      const tokenAddr = customAddr || this.config.tokens[name];
      const stakeCt = this.config.stakeContracts[name];
      if (!stakeCt) return;
      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) return;
      await new ethers.Contract(tokenAddr, erc20Abi, this.wallet)
        .approve(stakeCt, balance, { gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice })
        .then(tx => tx.wait());
      await this.delay(this.config.delayMs);
      const payload = this.config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const receipt = await this.wallet.sendTransaction({ to: stakeCt, data: payload, gasLimit: this.config.gasLimit, gasPrice: this.config.gasPrice })
        .then(tx => tx.wait());
      await this.delay(this.config.delayMs);
      console.log(`Staked ${formatted} ${symbol}`);
      await sendReport(formatStakingReport(symbol, formatted, receipt.transactionHash));
    } catch (e) {
      console.error(`stakeToken error ${name}:`, e.message);
    }
  }

  async claimFaucets() {
    const endpoints = {
      ath: 'https://app.x-network.io/maitrix-faucet/faucet',
      usde: 'https://app.x-network.io/maitrix-usde/faucet',
      lvlusd: 'https://app.x-network.io/maitrix-lvl/faucet',
      virtual: 'https://app.x-network.io/maitrix-virtual/faucet',
      vana: 'https://app.x-network.io/maitrix-vana/faucet',
      ai16z: 'https://app.x-network.io/maitrix-ai16z/faucet'
    };
    for (const [tk, url] of Object.entries(endpoints)) {
      try {
        const res = await this.http.post(url, { address: this.address });
        console.log(`[claimFaucets] ${tk} status: ${res.status}`);
      } catch (e) {
        console.error(`claimFaucets error ${tk}:`, e.message);
      }
      await this.delay(this.config.delayMs);
    }
  }

  async checkWalletStatus() {
    const { formatted: ethBal } = await this.getEthBalance();
    console.log(`\n=== Status ${this.address} ===`);
    console.log(`ETH: ${ethBal}`);
    for (const [name, addr] of Object.entries(this.config.tokens)) {
      const { formatted, symbol } = await this.getTokenBalance(addr);
      console.log(`${symbol} (${name}): ${formatted}`);
    }
  }

  async runBot() {
    console.log(`\n>>> Running bot for ${this.address}`);
    await this.checkWalletStatus();
    await this.claimFaucets();
    for (const name of ['virtual', 'ath', 'vnusd', 'azusd']) await this.swapToken(name);
    for (const name of Object.keys(this.config.stakeContracts)) {
      const override = name === 'vnusd' ? '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30' : name === 'azusd' ? '0x5966cd11aED7D68705C9692e74e5688C892cb162' : null;
