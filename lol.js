const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

function loadProxiesFromFile(filename = 'proxies.txt') {
  const p = path.resolve(__dirname, filename);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
}

function formatStakingReport(token, amount, tx) {
  return `🚀🎉 *Staking Berhasil!* 🎉🚀\n*Token:* ${token}\n*Jumlah:* ${amount}\n*TxHash:* \`${tx}\``;
}

const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: {
    virtual:'0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath:'0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd:'0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde:'0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd:'0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd:'0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
    vnusd:'0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8',
    azusd:'0x2d5a4f5634041f50180A25F26b2A8364452E3152'
  },
  routers: {
    virtual:'0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:'0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:'0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f',
    azusd:'0xb0b53d8b4ef06f9bbe5db624113c6a5d35bb7522'
  },
  stakeContracts: {
    ausd:'0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:'0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd:'0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:'0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd:'0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60',
    azusd:'0xf45fde3f484c44cc35bdc2a7fca3ddde0c8f252e'
  },
  methodIds: {
    virtualSwap:'0xa6d67510',
    athSwap:'0x1bf6318b',
    vnusdSwap:'0xa6d67510',
    azusdSwap:'0xa6d67510',
    stake:'0xa694fc3a'
  },
  gasLimit:1000000,
  gasPrice:ethers.utils.parseUnits('0.1','gwei'),
  delayMs:17000
};

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
  'function symbol() view returns (string)'
];

function getPrivateKeys() {
  const a = [];
  let i = 1;
  while (process.env[`PRIVATE_KEY_${i}`]) {
    a.push(process.env[`PRIVATE_KEY_${i}`]);
    i++;
  }
  if (a.length===0 && process.env.PRIVATE_KEY) a.push(process.env.PRIVATE_KEY);
  return a;
}

class WalletBot {
  constructor(key, cfg, proxy) {
    const agent = proxy
      ? (proxy.startsWith('socks')? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy))
      : null;
    this.provider = agent
      ? new ethers.providers.JsonRpcProvider({url:cfg.rpc,fetch:(u,o)=>fetch(u,{agent,...o})})
      : new ethers.providers.JsonRpcProvider(cfg.rpc);
    this.http = agent? axios.create({httpAgent:agent,httpsAgent:agent}) : axios;
    this.wallet = new ethers.Wallet(key,this.provider);
    this.address = this.wallet.address;
    this.cfg = cfg;
  }
  delay(ms){return new Promise(r=>setTimeout(r,ms));}
  async getTokenBalance(addr){
    const c=new ethers.Contract(addr,erc20Abi,this.wallet);
    const d=await c.decimals(),b=await c.balanceOf(this.address),s=await c.symbol().catch(()=>'?');
    return {balance:b,decimals:d,formatted:ethers.utils.formatUnits(b,d),symbol:s};
  }
  async getEthBalance(){
    const b=await this.provider.getBalance(this.address);
    return {formatted:ethers.utils.formatEther(b)};
  }
  async swapToken(n){
    try{
      const pi=await this.http.get('https://api.ipify.org?format=json');
      console.log(this.address,'IP:',pi.data.ip);
      const t=this.cfg.tokens[n],r=this.cfg.routers[n],m=this.cfg.methodIds[`${n}Swap`];
      if(!r||!m)return;
      const {balance,formatted,symbol}=await this.getTokenBalance(t);
      if(balance.isZero())return;
      await new ethers.Contract(t,erc20Abi,this.wallet).approve(r,balance,{gasLimit:this.cfg.gasLimit,gasPrice:this.cfg.gasPrice}).then(tx=>tx.wait());
      await this.delay(this.cfg.delayMs);
      const d=m+ethers.utils.defaultAbiCoder.encode(['uint256'],[balance]).slice(2);
      await this.wallet.sendTransaction({to:r,data:d,gasLimit:this.cfg.gasLimit,gasPrice:this.cfg.gasPrice}).then(tx=>tx.wait());
      await this.delay(this.cfg.delayMs);
      console.log('Swapped',formatted,symbol);
    }catch(e){console.error('swap error',e.message);}
  }
  async stakeToken(n,c){
    try{
      const a=c||this.cfg.tokens[n],sC=this.cfg.stakeContracts[n];
      if(!sC)return;
      const {balance,formatted,symbol}=await this.getTokenBalance(a);
      if(balance.isZero())return;
      await new ethers.Contract(a,erc20Abi,this.wallet).approve(sC,balance,{gasLimit:this.cfg.gasLimit,gasPrice:this.cfg.gasPrice}).then(tx=>tx.wait());
      await this.delay(this.cfg.delayMs);
      const d=this.cfg.methodIds.stake+ethers.utils.defaultAbiCoder.encode(['uint256'],[balance]).slice(2);
      const rc=await this.wallet.sendTransaction({to:sC,data:d,gasLimit:this.cfg.gasLimit,gasPrice:this.cfg.gasPrice}).then(tx=>tx.wait());
      await this.delay(this.cfg.delayMs);
      console.log('Staked',formatted,symbol);
      await sendReport(formatStakingReport(symbol,formatted,rc.transactionHash));
    }catch(e){console.error('stake error',e.message);}
  }
  async claimFaucets(){
    const e=this.cfg;const u={ath:'https://app.x-network.io/maitrix-faucet/faucet',usde:'https://app.x-network.io/maitrix-usde/faucet',lvlusd:'https://app.x-network.io/maitrix-lvl/faucet',virtual:'https://app.x-network.io/maitrix-virtual/faucet',vana:'https://app.x-network.io/maitrix-vana/faucet',ai16z:'https://app.x-network.io/maitrix-ai16z/faucet'};
    for(const [k,endpoint] of Object.entries(u)){
      try{const r=await this.http.post(endpoint,{address:this.address});console.log(k,'faucet',r.status);}catch(e){console.error('faucet err',e.message);}
      await this.delay(this.cfg.delayMs);
    }
  }
  async checkWalletStatus(){
    const e=await this.getEthBalance();console.log('\nStatus',this.address,'ETH',e.formatted);
    for(const [n,a] of Object.entries(this.cfg.tokens)){
      const b=await this.getTokenBalance(a);console.log(b.symbol,`(${n})`,b.formatted);
    }
  }
  async runBot(){
    console.log('\nRun',this.address);
    await this.checkWalletStatus();
    await this.claimFaucets();
    for(const n of ['virtual','ath','vnusd','azusd'])await this.swapToken(n);
    for(const n of Object.keys(this.cfg.stakeContracts)){
      const o=n==='vnusd'?'0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30':n==='azusd'?'0x5966cd11aED7D68705C9692e74e5688C892cb162':null;
      await this.stakeToken(n,o);
    }
    await this.checkWalletStatus();
    console.log('Done',this.address);
  }
}

async function runAllBots(){
  const keys=getPrivateKeys(),proxies=loadProxiesFromFile();
  for(let i=0;i<keys.length;i++){
    const p=proxies.length?proxies[i%proxies.length]:null;
    const bot=new WalletBot(keys[i],globalConfig,p);
    try{const pi=await bot.http.get('https://api.ipify.org?format=json');console.log('Account',i+1,bot.address,'IP',pi.data.ip);}catch(e){console.error('IP err',e.message);}
    await bot.runBot();
    await bot.delay(globalConfig.delayMs);
  }
}

runAllBots().then(()=>console.log('Finished')).catch(e=>console.error(e));
setInterval(runAllBots,24*60*60*1000);
