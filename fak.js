// multiAccountBot.js
const { ethers } = require('ethers');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
require('dotenv').config();

// ======================== 🛠 HELPER FUNCTIONS ========================
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

function getProxyList() {
  const filePath = path.join(__dirname, 'proxies.txt');
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(/\r?\n/)          // split lines
    .map(l => l.trim())       // trim whitespace
    .filter(l => l && !l.startsWith('#'));
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
  rpc: process.env.RPC_URL || 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: { virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C', ath: '0x1428…', ausd: '0x78De…', usde: '0xf4BE…', lvlusd: '0x8802…', vusd: '0xc14A…', vnusd: '0xBEbF…' },
  routers: { virtual: '0x3dCA…', ath: '0x2cFD…', vnusd: '0xEfbA…' },
  stakeContracts: { ausd: '0x054d…', usde: '0x3988…', lvlusd: '0x5De3…', vusd: '0x5bb9…', vnusd: '0x2608…' },
  methodIds: { virtualSwap: '0xa6d67510', athSwap: '0x1bf6318b', vnusdSwap: '0xa6d67510', stake: '0xa694fc3a' },
  gasLimit: 1000000,
  maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
  maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
  delayMs: parseInt(process.env.DELAY_MS, 10) || 17000
};

// ======================== 🤖 WALLET BOT CLASS ========================
class WalletBot {
  constructor(privateKey, config, proxyUrl = null) {
    if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) throw new Error("Invalid private key!");
    this.config = config;
    const providerOptions = { url: config.rpc };
    if (proxyUrl) providerOptions.agent = new HttpsProxyAgent(proxyUrl);
    this.provider = new ethers.providers.JsonRpcProvider(providerOptions);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
  }

  async getTokenBalance(tokenAddr) { try { const contract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet); const [balance, decimals, symbol] = await Promise.all([contract.balanceOf(this.address), contract.decimals(), contract.symbol().catch(() => 'UNKNOWN')]); return { balance, formatted: ethers.utils.formatUnits(balance, decimals), symbol }; } catch { return { balance: ethers.constants.Zero, formatted: '0', symbol: 'ERR' }; }}
  async getEthBalance() { const balance = await this.provider.getBalance(this.address); return { balance, formatted: ethers.utils.formatEther(balance) }; }
  async checkWalletStatus() { console.log(`\n=== Wallet ${this.address.slice(0,8)}... ===`); try { const eth = await this.getEthBalance(); console.log(`ETH: ${eth.formatted}`); for (const addr of Object.values(this.config.tokens)) { const { formatted, symbol } = await this.getTokenBalance(addr); console.log(`${symbol.padEnd(6)}: ${formatted}`); } } catch (e) { console.error('Status check failed:', e.message); }}
  async swapToken(tokenName) { try { console.log(`\nSwapping ${tokenName}...`); const tokenAddr = this.config.tokens[tokenName]; const router = this.config.routers[tokenName]; const methodId = this.config.methodIds[`${tokenName}Swap`]; if (!router||!methodId) throw new Error('Invalid router config!'); const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr); if (balance.isZero()) { console.log('Skipping: Zero balance'); return; } await (await new ethers.Contract(tokenAddr, erc20Abi, this.wallet).approve(router, balance, this._txOptions())).wait(); await delay(this.config.delayMs); const data = methodId + ethers.utils.defaultAbiCoder.encode(['uint256'],[balance]).slice(2); const tx = await this.wallet.sendTransaction({ to:router,data,...this._txOptions() }); console.log(`TX Hash: ${tx.hash}`); await tx.wait(); console.log(`Swapped ${formatted} ${symbol}`); } catch (e) { console.error(`Swap failed: ${e.message}`); }}
  async stakeToken(tokenName, customAddr=null) { try { console.log(`\nStaking ${tokenName}...`); const tokenAddr = customAddr||this.config.tokens[tokenName]; const stakeContract=this.config.stakeContracts[tokenName]; if(!stakeContract) throw new Error('Invalid stake contract!'); const { balance,formatted,symbol }=await this.getTokenBalance(tokenAddr); if(balance.isZero()){ console.log('Skipping: Zero balance');return;} await (await new ethers.Contract(tokenAddr,erc20Abi,this.wallet).approve(stakeContract,balance,this._txOptions())).wait(); await delay(this.config.delayMs); const data=this.config.methodIds.stake+ethers.utils.defaultAbiCoder.encode(['uint256'],[balance]).slice(2); const tx=await this.wallet.sendTransaction({to:stakeContract,data,...this._txOptions()}); console.log(`TX Hash: ${tx.hash}`); await tx.wait(); console.log(`Staked ${formatted} ${symbol}`); } catch(e){ console.error(`Stake failed: ${e.message}`);} }
  _txOptions(){ return{ gasLimit:this.config.gasLimit, maxFeePerGas:this.config.maxFeePerGas, maxPriorityFeePerGas:this.config.maxPriorityFeePerGas }; }
  async runBot(){ try{ console.log(`\n🚀 Starting bot for ${this.address}`); await this.checkWalletStatus(); for(const t of['virtual','ath','vnusd']) await this.swapToken(t); for(const t of['ausd','usde','lvlusd','vusd']) await this.stakeToken(t); await this.stakeToken('vnusd','0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30'); await this.checkWalletStatus(); console.log(`✅ Finished ${this.address}`); }catch(e){console.error(`Bot error: ${e.message}`);} }
}

// ======================== 🚀 MAIN EXECUTION ========================
(async()=>{
  try{
    console.log('🔌 Initializing bot...');
    const keys=getPrivateKeys();
    const proxies=getProxyList();
    console.log(`🔑 Loaded ${keys.length} wallet(s) and ${proxies.length} proxy(ies)`);

    for(let i=0;i<keys.length;i++){
      const key=keys[i];
      const proxyUrl=proxies[i]||null;
      if(proxyUrl){
        const hostname=new URL(proxyUrl).hostname;
        dns.lookup(hostname,(err,address)=>{
          console.log(`\n💼 Wallet ${i+1}/${keys.length} using proxy ${proxyUrl} (IP: ${err? 'lookup error': address})`);
        });
      } else {
        console.log(`\n💼 Wallet ${i+1}/${keys.length} using proxy: none`);
      }
      const bot=new WalletBot(key,globalConfig,proxyUrl);
      await bot.runBot();
      await delay(globalConfig.delayMs);
    }

    console.log('\n🔄 Scheduling next run (24 hours)');
    setTimeout(()=>process.exit(0),24*60*60*1000);
  }catch(e){
    console.error('💀 Critical error:',e);
    process.exit(1);
  }
})();

// ======================== 🛡 ERROR HANDLING ========================
process.on('unhandledRejection',reason=>console.error('Unhandled Rejection:',reason));
process.on('uncaughtException',error=>{console.error('Uncaught Exception:',error);process.exit(1);});
