const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default; // compatible import
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

function formatStakingReport(token, amount, tx) {
  return `🚀🎉 *Staking Berhasil!* 🎉🚀\n*Token:* ${token}\n*Jumlah:* ${amount}\n*TxHash:* \`${tx}\``;
}

const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: { virtual:'0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C', ath:'0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399', ausd:'0x78De28aABBD5198657B26A8dc9777f441551B477', usde:'0xf4BE938070f59764C85fAcE374F92A4670ff3877', lvlusd:'0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83', vusd:'0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802', vnusd:'0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8', azusd:'0x2d5a4f5634041f50180A25F26b2A8364452E3152' },
  routers: { virtual:'0x3dCACa90A714498624067948C092Dd0373f08265', ath:'0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e', vnusd:'0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f', azusd:'0xb0b53d8b4ef06f9bbe5db624113c6a5d35bb7522' },
  stakeContracts: { ausd:'0x054de909723ECda2d119E31583D40a52a332f85c', usde:'0x3988053b7c748023a1ae19a8ed4c1bf217932bdb', lvlusd:'0x5De3fBd40D4c3892914c3b67b5B529D776A1483A', vusd:'0x5bb9Fa02a3DCCDB4E9099b48eBa5841D2e59d51', vnusd:'0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60', azusd:'0xf45fde3f484c44cc35bdc2a7fca3ddde0c8f252e' },
  methodIds: { virtualSwap:'0xa6d67510', athSwap:'0x1bf6318b', vnusdSwap:'0xa6d67510', azusdSwap:'0xa6d67510', stake:'0xa694fc3a' },
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1','gwei'),
  delayMs: 15000
};

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function symbol() view returns (string)'
];

class WalletBot {
  constructor(key, cfg, proxy) {
    const agent = proxy ? (proxy.startsWith('socks') ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy)) : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({ url: cfg.rpc, fetch: (u,o) => fetch(u,{agent,...o}) })
      : new ethers.providers.JsonRpcProvider(cfg.rpc);
    this.http = agent ? axios.create({ httpAgent: agent, httpsAgent: agent, timeout: 10000 }) : axios;
    this.wallet = new ethers.Wallet(key, this.provider);
    this.address = this.wallet.address;
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async getTokenBalance(addr) {
    const contract = new ethers.Contract(addr, erc20Abi, this.wallet);
    const decimals = await contract.decimals();
    const balance = await contract.balanceOf(this.address);
    const symbol = await contract.symbol().catch(() => '?');
    return { balance, formatted: ethers.utils.formatUnits(balance, decimals), symbol };
  }

  async getEthBalance() {
    const balance = await this.provider.getBalance(this.address);
    return ethers.utils.formatEther(balance);
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
      const contract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
      const approveTx = await contract.approve(router, balance, { gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`🔏 Approving ${symbol}... TxHash: ${approveTx.hash}`);
      await approveTx.wait();
      await this.delay(globalConfig.delayMs);
      const data = method + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const swapTx = await this.wallet.sendTransaction({ to: router, data, gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`⚡ Swapping ${formatted} ${symbol}... TxHash: ${swapTx.hash}`);
      await swapTx.wait();
      await this.delay(globalConfig.delayMs);
      console.log(`✅ Swapped ${formatted} ${symbol}`);
    } catch (e) {
      console.log(`❌ swap ${name} err:`, e.message);
    }
  }

  async stakeToken(name, overrideAddr) {
    try {
      const tokenAddr = overrideAddr || globalConfig.tokens[name];
      const stakeCt = globalConfig.stakeContracts[name];
      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) {
        console.log(`⚠️ [${this.address}] Skip stake ${symbol}: balance=0`);
        return;
      }
      const contract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
      const approveTx = await contract.approve(stakeCt, balance, { gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`🔏 Approving ${symbol}: TxHash ${approveTx.hash}`);
      await approveTx.wait();
      await this.delay(globalConfig.delayMs);
      const allowance = await contract.allowance(this.address, stakeCt);
      console.log(`➡️ Allowance for ${symbol}: ${ethers.utils.formatUnits(allowance)}`);
      const data = globalConfig.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const stakeTx = await this.wallet.sendTransaction({ to: stakeCt, data, gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice });
      console.log(`⚡ Staking ${formatted} ${symbol}: TxHash ${stakeTx.hash}`);
      await stakeTx.wait();
      await this.delay(globalConfig.delayMs);
      console.log(`✅ Staked ${formatted} ${symbol}`);
      await sendReport(formatStakingReport(symbol, formatted, stakeTx.hash));
    } catch (e) {
      console.log(`
