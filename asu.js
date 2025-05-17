const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
require('dotenv').config();

const CONFIG = {
  RPC: 'https://arbitrum-sepolia.gateway.tenderly.co',
  CHAIN_ID: 421614,
  
  // Gas Configuration (Diperbaiki)
  GAS: {
    gasLimit: 1000000,
    maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei')
  },
  
  // Delay Configuration
  DELAY: {
    BETWEEN_TX: 17000,
    BETWEEN_ACCOUNTS: 30000
  },

  // Daftar Token
  TOKENS: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath: '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd: '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde: '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd: '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd: '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
    vnusd: '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8'
  },

  ROUTERS: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath: '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd: '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },

  STAKE: {
    ausd: '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde: '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd: '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60'
  },

  METHODS: {
    virtualSwap: '0xa6d67510',
    athSwap: '0x1bf6318b',
    vnusdSwap: '0xa6d67510',
    stake: '0xa694fc3a'
  },

  FAUCETS: {
    ath: 'https://app.x-network.io/maitrix-faucet/faucet',
    usde: 'https://app.x-network.io/maitrix-usde/faucet',
    lvlusd: 'https://app.x-network.io/maitrix-lvl/faucet',
    virtual: 'https://app.x-network.io/maitrix-virtual/faucet',
    vana: 'https://app.x-network.io/maitrix-vana/faucet'
  }
};

class DexBot {
  constructor(privateKey, proxyString) {
    this.privateKey = privateKey;
    this.provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.proxyString = proxyString?.trim();
    this.httpsAgent = this.createProxyAgent();
  }

  // [Bagian proxy dan fungsi helper lainnya tetap sama...]

  async checkBalances() {
    console.log('\n💰 Token Balances:');
    
    // Cek ETH Balance
    const ethBalance = await this.provider.getBalance(this.wallet.address);
    console.log(`- ETH: ${ethers.utils.formatEther(ethBalance)}`);

    // Cek ERC20 Balances
    for (const [tokenName, tokenAddress] of Object.entries(CONFIG.TOKENS)) {
      try {
        const contract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
        
        const [balance, decimals, symbol] = await Promise.all([
          contract.balanceOf(this.wallet.address),
          contract.decimals(),
          contract.symbol().catch(() => tokenName.toUpperCase())
        ]);
        
        const formatted = ethers.utils.formatUnits(balance, decimals);
        console.log(`- ${symbol}: ${formatted}`);
      } catch (e) {
        console.log(`- ${tokenName}: Error fetching balance (${e.message})`);
      }
      await new Promise(r => setTimeout(r, 1000)); // Delay antar token
    }
  }

  async processTokenSwap(tokenName) {
    const tokenAddress = CONFIG.TOKENS[tokenName];
    const router = CONFIG.ROUTERS[tokenName];
    const methodId = CONFIG.METHODS[`${tokenName}Swap`];

    return this.executeWithRetry(async () => {
      const contract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
      
      // 1. Cek Balance
      const balance = await contract.balanceOf(this.wallet.address);
      if (balance.isZero()) throw new Error('Zero balance');
      
      // 2. Approve dengan gas settings yang benar
      const approveTx = await contract.approve(
        router, 
        balance, 
        {
          gasLimit: CONFIG.GAS.gasLimit,
          maxFeePerGas: CONFIG.GAS.maxFeePerGas,
          maxPriorityFeePerGas: CONFIG.GAS.maxPriorityFeePerGas
        }
      );
      await approveTx.wait();

      // 3. Execute Swap
      const txData = methodId + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({
        to: router,
        data: txData,
        gasLimit: CONFIG.GAS.gasLimit,
        maxFeePerGas: CONFIG.GAS.maxFeePerGas,
        maxPriorityFeePerGas: CONFIG.GAS.maxPriorityFeePerGas
      });
      
      await tx.wait();
      console.log(`🔄 Successfully swapped ${tokenName}`);
    }, `Swap-${tokenName}`);
  }

  async executeOperations() {
    console.log(`\n🚀 Starting operations for ${this.wallet.address.slice(0, 8)}...`);
    
    try {
      // Tampilkan balance awal
      await this.checkBalances();

      // Klaim faucet
      await this.claimFaucets();
      await new Promise(r => setTimeout(r, CONFIG.DELAY.BETWEEN_TX));

      // Lakukan swap
      for (const token of Object.keys(CONFIG.TOKENS)) {
        await this.processTokenSwap(token);
        await new Promise(r => setTimeout(r, CONFIG.DELAY.BETWEEN_TX));
      }

      // Tampilkan balance setelah swap
      await this.checkBalances();
      await new Promise(r => setTimeout(r, CONFIG.DELAY.BETWEEN_TX));

      // Lakukan staking
      for (const token of Object.keys(CONFIG.STAKE)) {
        await this.processStaking(token);
        await new Promise(r => setTimeout(r, CONFIG.DELAY.BETWEEN_TX));
      }

      // Tampilkan balance akhir
      await this.checkBalances();
      
      console.log(`✅ All operations completed successfully`);
    } catch (e) {
      await sendReport(`🔥 Critical error: ${e.message}`);
      throw e;
    }
  }
}

const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

// [Bagian main dan fungsi lainnya tetap sama...]
