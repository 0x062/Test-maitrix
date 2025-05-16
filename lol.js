const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

function loadList(filename) {
  const file = path.resolve(__dirname, filename);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

const privateKeys = loadList('private_keys.txt');
const proxyList = loadList('proxies.txt');

const config = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei'),
  delayMs: 15000,
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath:     '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    vnusd:   '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8',
    ausd:    '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde:    '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd:  '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd:    '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:   '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },
  stakes: {
    virtual: '0x<VIRTUAL_STAKE_CONTRACT>',
    ath:     '0x<ATH_STAKE_CONTRACT>',
    vnusd:   '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60',
    ausd:    '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:    '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd:  '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:    '0x5bb9Fa02a3DCCDB4E9099b48eBa5841D2e59d51'
  },
  methodIds: {
    virtual: '0xa6d67510',
    ath:     '0x1bf6318b',
    vnusd:   '0xa6d67510'
  },
  minStake: {
    virtual: '0.01',
    ath:     '0.01',
    vnusd:   '0.01',
    ausd:    '1',
    usde:    '1',
    lvlusd:  '1',
    vusd:    '1'
  }
};

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address,uint256) returns (bool)'
];
// ABI for stake contracts (assumes stake(uint256) exists)
const stakeAbi = [ 'function stake(uint256) returns (bool)' ];

class WalletBot {
  constructor(key, proxyUrl) {
    const agent = proxyUrl
      ? (proxyUrl.startsWith('socks')
          ? new SocksProxyAgent(proxyUrl)
          : new HttpsProxyAgent(proxyUrl))
      : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: config.rpc, fetch: (u, o) => fetch(u, { agent, ...o }) })
      : new ethers.providers.JsonRpcProvider(config.rpc);
    this.http = agent
      ? axios.create({ httpAgent: agent, httpsAgent: agent, timeout: 10000 })
      : axios;
    this.wallet = new ethers.Wallet(key, this.provider);
    this.address = this.wallet.address;
    console.log(`\n🟢 Wallet: ${this.address}`);
    if (agent) console.log(`🌐 Proxy: ${proxyUrl}`);
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async logProxyIp() {
    if (this.http !== axios) {
      try { const { data } = await this.http.get('https://api.ipify.org?format=json'); console.log(`🌐 IP: ${data.ip}`); }
      catch (e) { console.log(`⚠️ IP error: ${e.message}`); }
    }
  }

  async getToken(name) {
    const addr = config.tokens[name];
    const contract = new ethers.Contract(addr, erc20Abi, this.wallet);
    const decimals = await contract.decimals();
    const balance = await contract.balanceOf(this.address);
    const symbol = await contract.symbol().catch(() => name);
    return { contract, balance, formatted: ethers.utils.formatUnits(balance, decimals), symbol, decimals };
  }

  async run() {
    console.log(`🌟 Run start`);
    await this.logProxyIp();

    for (const name of Object.keys(config.tokens)) {
      try {
        const { contract, balance, formatted, symbol, decimals } = await this.getToken(name);
        console.log(`🔍 ${symbol}: ${formatted}`);

        // Swap all-in
        const router = config.routers[name];
        if (router && balance.gt(0)) {
          console.log(`-- swap ${symbol} all-in`);
          await contract.approve(router, balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
          const data = config.methodIds[name] + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
          await this.wallet.sendTransaction({ to: router, data, gasLimit: config.gasLimit, gasPrice: config.gasPrice });
          console.log(`✅ Swapped ${symbol}`);
          await this.delay(config.delayMs);
        }

        // Stake all-in if meets minimum
        const stakeCt = config.stakes[name];
        const min = ethers.utils.parseUnits(config.minStake[name] || '0', decimals);
        if (stakeCt && balance.gte(min)) {
          console.log(`-- stake ${symbol} all-in`);
          // Use ethers Contract to call stake(), avoiding manual encoding
          const stakeContract = new ethers.Contract(stakeCt, stakeAbi, this.wallet);
          await stakeContract.stake(balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
          console.log(`✅ Staked ${symbol}`);
          await this.delay(config.delayMs);
        }

      } catch (e) {
        console.log(`❌ ${name} error: ${e.message}`);
      }
    }

    console.log(`🌟 Run completed`);
  }
}

(async () => {
  for (let i = 0; i < privateKeys.length; i++) {
    const key = privateKeys[i];
    const proxyUrl = proxyList[i] || null;
    const bot = new WalletBot(key, proxyUrl);
    await bot.run();
    await bot.delay(config.delayMs);
  }
})();
