// multiAccountBot.js
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
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
    throw new Error("No private keys found in .env file!");
  }
  return keys;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================== ⚙️ CONFIGURATION ========================
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
    vnusd:   '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:   '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },
  stakeContracts: {
    ausd:  '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde:  '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd:'0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd:  '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap:     '0x1bf6318b',
    vnusdSwap:   '0xa6d67510',
    stake:       '0xa694fc3a'
  },
  gasLimit: 1000000,
  maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
  maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
  delayMs: 17000
};

// ======================== 🤖 WALLET BOT CLASS ========================
class WalletBot {
  constructor(privateKey, config) {
    if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
      throw new Error("Invalid private key format!");
    }
    
    this.config = config;
    this.provider = new ethers.providers.JsonRpcProvider(config.rpc);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
  }

  async getTokenBalance(tokenAddr) {
    const tokenContract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
    try {
      const decimals = await tokenContract.decimals();
      const balance = await tokenContract.balanceOf(this.address);
      const symbol = await tokenContract.symbol();
      return {
        balance,
        decimals,
        formatted: ethers.utils.formatUnits(balance, decimals),
        symbol
      };
    } catch (e) {
      console.error(`Error getting balance: ${e.message}`);
      return { balance: ethers.constants.Zero, formatted: '0', symbol: 'UNKNOWN' };
    }
  }

  async executeTransaction(to, data) {
    try {
      const tx = await this.wallet.sendTransaction({
        to,
        data,
        gasLimit: this.config.gasLimit,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
      });
      return tx.wait();
    } catch (e) {
      console.error(`Transaction failed: ${e.message}`);
      throw e;
    }
  }

  // ... (Tambahkan method lainnya di sini)

}

// ======================== 🚀 MAIN EXECUTION ========================
async function runAllBots() {
  try {
    const keys = getPrivateKeys();
    console.log(`Found ${keys.length} wallet(s)`);

    for (const [index, key] of keys.entries()) {
      console.log(`\nProcessing wallet ${index + 1}/${keys.length}`);
      try {
        const bot = new WalletBot(key, globalConfig);
        await bot.runBot();
        await delay(globalConfig.delayMs);
      } catch (e) {
        console.error(`Wallet ${index + 1} error: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`Fatal error: ${e.message}`);
    process.exit(1);
  }
}

// ======================== 🏁 START SCRIPT ========================
(async () => {
  try {
    await runAllBots();
    console.log('Initial run completed');
    setInterval(runAllBots, 24 * 60 * 60 * 1000); // Jalankan setiap 24 jam
  } catch (e) {
    console.error('Critical failure:', e);
  }
})();
