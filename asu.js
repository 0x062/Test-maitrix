// multiAccountBot.js
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
require('dotenv').config();

// 🐞 DEBUG: Tambahkan header laporan error global
async function globalErrorHandler(error) {
  const msg = `🆘 *Critical Error*:\n\`\`\`${error.message}\`\`\``;
  console.error('Global Error:', error);
  await sendReport(msg);
  process.exit(1);
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
  // 🐞 DEBUG: Naikkan gas price dan tambahkan parameter EIP-1559
  gasLimit: 1000000,
  maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
  maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei'),
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
  while (true) {
    const key = process.env[`PRIVATE_KEY_${idx}`];
    if (!key) break;
    privateKeys.push(key);
    idx++;
  }
  if (privateKeys.length === 0 && process.env.PRIVATE_KEY) {
    privateKeys.push(process.env.PRIVATE_KEY);
  }
  return privateKeys;
}

class WalletBot {
  constructor(privateKey, config) {
    this.config = config;
    // 🐞 DEBUG: Tambahkan logger untuk provider
    this.provider = new ethers.providers.JsonRpcProvider(config.rpc);
    this.provider.on('debug', (data) => {
      console.log('[RPC DEBUG]', data.action, data.request);
    });
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getTokenBalance(tokenAddr) {
    try {
      const c = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
      const decimals = await c.decimals();
      const bal = await c.balanceOf(this.address);
      let symbol;
      try { 
        symbol = await c.symbol(); 
      } catch { 
        symbol = 'TOKEN'; 
      }
      return {
        balance: bal,
        decimals,
        formatted: ethers.utils.formatUnits(bal, decimals),
        symbol
      };
    } catch (e) {
      console.error(`getTokenBalance error:`, e);
      await sendReport(`⚠️ Balance check failed for ${tokenAddr.slice(0,8)}...`);
      throw e;
    }
  }

  async getEthBalance() {
    const w = await this.provider.getBalance(this.address);
    return { balance: w, formatted: ethers.utils.formatEther(w) };
  }

  async swapToken(tokenName) {
    try {
      console.log(`\n--- Swap ${tokenName} for ${this.address} ---`);
      const tokenAddr = this.config.tokens[tokenName];
      const router    = this.config.routers[tokenName];
      const methodId  = this.config.methodIds[`${tokenName}Swap`];
      
      // 🐞 DEBUG: Validasi method ID
      if (!methodId || methodId.length !== 10) {
        throw new Error(`Invalid method ID for ${tokenName}Swap: ${methodId}`);
      }

      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) {
        console.log(`Skipping swap: Zero balance for ${symbol}`);
        return false;
      }

      console.log(`Approving ${symbol}...`);
      const tokenContract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
      const approveTx = await tokenContract.approve(router, balance, {
        gasLimit: this.config.gasLimit,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
      });
      
      // 🐞 DEBUG: Pastikan approve sukses
      const approveReceipt = await approveTx.wait();
      if (approveReceipt.status !== 1) {
        throw new Error(`Approve failed for ${symbol}`);
      }
      
      await this.delay(this.config.delayMs);

      const data = methodId + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({ 
        to: router, 
        data, 
        gasLimit: this.config.gasLimit,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
      });
      
      // 🐞 DEBUG: Tambahkan tracking TX
      console.log(`TX pending: ${tx.hash}`);
      await sendReport(`⏳ *Swap TX Sent*:\n\`${tx.hash}\``);
      
      const receipt = await tx.wait();
      console.log(`Swapped ${formatted} ${symbol} (${receipt.status ? 'Success' : 'Failed'})`);
      return receipt.status === 1;
    } catch (e) {
      const errMsg = `🔴 Swap ${tokenName} failed: ${e.message}`;
      console.error(errMsg);
      await sendReport(errMsg);
      return false;
    }
  }

  async stakeToken(tokenName, customAddr = null) {
    try {
      const tokenAddr = customAddr || this.config.tokens[tokenName];
      console.log(`▶️ Using tokenAddress ${tokenAddr} for staking ${tokenName}`);
      const stakeCt = this.config.stakeContracts[tokenName];
      
      if (!stakeCt) {
        throw new Error(`No stake contract for ${tokenName}`);
      }

      const { balance, formatted, symbol } = await this.getTokenBalance(tokenAddr);
      if (balance.isZero()) {
        console.log(`Skipping stake: Zero balance for ${symbol}`);
        return false;
      }

      console.log(`Approving staking for ${symbol}...`);
      const tokenContract = new ethers.Contract(tokenAddr, erc20Abi, this.wallet);
      const approveTx = await tokenContract.approve(stakeCt, balance, {
        gasLimit: this.config.gasLimit,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
      });
      
      const approveReceipt = await approveTx.wait();
      if (approveReceipt.status !== 1) {
        throw new Error(`Stake approve failed for ${symbol}`);
      }
      
      await this.delay(this.config.delayMs);

      const data = this.config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
      const tx = await this.wallet.sendTransaction({ 
        to: stakeCt, 
        data, 
        gasLimit: this.config.gasLimit,
        maxFeePerGas: this.config.maxFeePerGas,
        maxPriorityFeePerGas: this.config.maxPriorityFeePerGas
      });
      
      console.log(`TX pending: ${tx.hash}`);
      await sendReport(`⏳ *Stake TX Sent*:\n\`${tx.hash}\``);
      
      const receipt = await tx.wait();
      console.log(`Staked ${formatted} ${symbol} (${receipt.status ? 'Success' : 'Failed'})`);
      
      if (receipt.status === 1) {
        const reportMsg = formatStakingReport(symbol, formatted, tx.hash);
        await sendReport(reportMsg);
      }
      return receipt.status === 1;
    } catch (e) {
      const errMsg = `🔴 Stake ${tokenName} failed: ${e.message}`;
      console.error(errMsg);
      await sendReport(errMsg);
      return false;
    }
  }

  async checkWalletStatus() {
    console.log(`\n=== Status ${this.address} ===`);
    try {
      const eth = await this.getEthBalance();
      console.log(`ETH: ${eth.formatted}`);
      for (const [name, addr] of Object.entries(this.config.tokens)) {
        const { formatted, symbol } = await this.getTokenBalance(addr);
        console.log(`${symbol} (${name}): ${formatted}`);
      }
    } catch (e) {
      await sendReport(`📊 Status check failed: ${e.message}`);
      throw e;
    }
  }

  async runBot() {
    try {
      console.log(`\n>>> Running bot for ${this.address}`);
      await this.checkWalletStatus();
      
      // 🐞 DEBUG: Faucet dimatikan sesuai permintaan
      // await this.claimFaucets();

      if (this.config.routers.virtual) await this.swapToken('virtual');
      if (this.config.routers.ath)     await this.swapToken('ath');
      if (this.config.routers.vnusd)   await this.swapToken('vnusd');

      for (const name of Object.keys(this.config.stakeContracts)) {
        if (name === 'vnusd') {
          await this.stakeToken(name, '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30');
        } else {
          await this.stakeToken(name);
        }
      }

      await this.checkWalletStatus();
      console.log(`<<< Finished ${this.address}`);
    } catch (e) {
      await sendReport(`🤖 Bot run failed for ${this.address}:\n\`${e.message}\``);
      throw e;
    }
  }
}

// 🐞 DEBUG: Handle interval lebih aman
async function runWithInterval() {
  try {
    await runAllBots();
  } catch (e) {
    await globalErrorHandler(e);
  } finally {
    setTimeout(runWithInterval, INTERVAL_MS);
  }
}

async function runAllBots() {
  console.log('=== Starting multi-account bot ===');
  const keys = getPrivateKeys();
  if (!keys.length) {
    throw new Error('No private keys found!');
  }
  for (let i = 0; i < keys.length; i++) {
    console.log(`\n--- Processing account ${i+1}/${keys.length} ---`);
    const bot = new WalletBot(keys[i], globalConfig);
    await bot.runBot();
    await bot.delay(bot.config.delayMs);
  }
  console.log('=== All accounts done ===');
}

// 🐞 DEBUG: Tambahkan handler error global
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  sendReport(`💥 Unhandled Rejection:\n\`\`\`${reason}\`\`\``);
});

// Jalankan pertama kali
runWithInterval().catch(globalErrorHandler);
