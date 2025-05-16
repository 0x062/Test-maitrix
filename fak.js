const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

function loadProxiesFromFile(filename = 'proxies.txt') {
  const p = path.resolve(__dirname, filename);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function loadPrivateKeysFromFile(filename = 'private_keys.txt') {
  const p = path.resolve(__dirname, filename);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function formatStakingReport(token, amount, txHash) {
  return `🚀🎉 *Staking Berhasil!* 🎉🚀\n*Token:* ${token}\n*Jumlah:* ${amount}\n*TxHash:* \`${txHash}\``;
}

const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath:     '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    vnusd:   '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8',
    azusd:   '0x2d5a4f5634041f50180A25F26b2A8364452E3152',
    ausd:    '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde:    '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd:  '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd:    '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:   '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f',
    azusd:   '0xb0b53d8b4ef06f9bbe5db624113c6a5d35bb7522'
  },
  stakeContracts: {
    ausd:   '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:   '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:   '0x5bb9Fa02a3DCCDB4E9099b48eBa5841D2e59d51',
    vnusd:  '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60',
    azusd:  '0xf45fde3f484c44cc35bdc2a7fca3ddde0c8f252e'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap:     '0x1bf6318b',
    vnusdSwap:   '0xa6d67510',
    azusdSwap:   '0xa6d67510',
    stake:       '0xa694fc3a'
  },
  gasLimit:  1_000_000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei'),
  delayMs:  15_000
};

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function symbol() view returns (string)'
];

class WalletBot {
  constructor(key, proxy) {
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy)) : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: globalConfig.rpc, fetch: (u,o) => fetch(u,{agent,...o}) })
      : new ethers.providers.JsonRpcProvider(globalConfig.rpc);
    this.http = agent
      ? axios.create({ httpAgent: agent, httpsAgent: agent, timeout: 10_000 })
      : axios;
    this.wallet = new ethers.Wallet(key, this.provider);
    this.address = this.wallet.address;
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async getTokenBalance(addr) {
    const contract = new ethers.Contract(addr, erc20Abi, this.wallet);
    const decimals = await contract.decimals();
    const bal = await contract.balanceOf(this.address);
    const sym = await contract.symbol().catch(() => '?');
    return { balance: bal, formatted: ethers.utils.formatUnits(bal, decimals), symbol: sym };
  }

  async swapToken(name) {
    try {
      const ip = await this.http.get('https://api.ipify.org?format=json');
      console.log(`🚀 [${this.address}] IP:${ip.data.ip}`);
      const tokenAddr = globalConfig.tokens[name];
      const router = globalConfig.routers[name];
      const method = globalConfig.methodIds[`${name}Swap`];
      if (!router || !method) return;
      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) return;
      const c = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
      const tx1 = await c.approve(router, balance, { gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`🔏 Approving ${symbol}... TxHash:${tx1.hash}`);
      await tx1.wait(); await this.delay(globalConfig.delayMs);
      const data = method + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx2 = await this.wallet.sendTransaction({ to: router, data, gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`⚡ Swapping ${formatted} ${symbol}... TxHash:${tx2.hash}`);
      await tx2.wait(); await this.delay(globalConfig.delayMs);
      console.log(`✅ Swapped ${formatted} ${symbol}`);
    } catch(e) {
      const msg = e.message || '';
      if (msg.includes('execution reverted')) console.log(`⚠️ Skip swap ${name}: reverted`);
      else console.log(`❌ swap ${name} err:`, msg);
    }
  }

  async stakeToken(name, override) {
    try {
      const addr = override || globalConfig.tokens[name];
      const stakeCt = globalConfig.stakeContracts[name];
      const { balance, formatted, symbol } = await this.getTokenBalance(addr);
      if (balance.isZero()) { console.log(`⚠️ [${this.address}] Skip stake ${symbol}: 0`); return; }
      const c = new ethers.Contract(addr, erc20Abi, this.wallet);
      const tx1 = await c.approve(stakeCt, balance, { gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`🔏 Approving ${symbol}: TxHash:${tx1.hash}`);
      await tx1.wait(); await this.delay(globalConfig.delayMs);
      const allowance = await c.allowance(this.address, stakeCt);
      console.log(`➡️ Allowance for ${symbol}: ${ethers.utils.formatUnits(allowance)}`);
      const data = globalConfig.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx2 = await this.wallet.sendTransaction({ to: stakeCt, data, gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`⚡ Staking ${formatted} ${symbol}... TxHash:${tx2.hash}`);
      await tx2.wait(); await this.delay(globalConfig.delayMs);
      console.log(`✅ Staked ${formatted} ${symbol}`);
      await sendReport(formatStakingReport(symbol, formatted, tx2.hash));
    } catch(e) {
      const msg = e.message || '';
      if (msg.includes('execution reverted')) console.log(`⚠️ Skip stake ${name}: reverted`);
      else console.log(`❌ stake ${name} err:`, msg);
    }
  }

  async claimFaucets() {
    console.log('-- claimFaucets start');
    const eps = {
      ath: 'https://app.x-network.io/maitrix-faucet/faucet',
      usde:'https://app.x-network.io/maitrix-usde/faucet',
      lvlusd:'https://app.x-network.io/maitrix-lvl/faucet',
      virtual:'https://app.x-network.io/maitrix-virtual/faucet',
      vana:'https://app.x-network.io/maitrix-vana/faucet',
      ai16z:'https://app.x-network.io/maitrix-ai16z/faucet'
    };
    for (const [k,u] of Object.entries(eps)) {
 AI STOPPED DUE TO LENGTH
