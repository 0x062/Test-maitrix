const { ethers } = require('ethers');
const axios = require('axios');
require('dotenv').config();

// Konfigurasi untuk multiple accounts
const globalConfig = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath: '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd: '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde: '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd: '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd: '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
    vnusd: '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath: '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd:'0x3dCACa90A714498624067948C092Dd0373f08265'
  },
  stakeContracts: {
    ausd: '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde: '0x07f8ec2B79B7A1998Fd0B21a4668B0Cf1cA72C02',
    lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd: '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap: '0x1bf6318b',
    stake: '0xa694fc3a'
  },
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei')
};

// ABI untuk token ERC20
const erc20Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)'
];

// Daftar private key dari file .env
// Format di .env: PRIVATE_KEY_1=abc123..., PRIVATE_KEY_2=def456..., dst.
function getPrivateKeys() {
  const privateKeys = [];
  let index = 1;
  
  while (true) {
    const key = process.env[`PRIVATE_KEY_${index}`];
    if (!key) break;
    privateKeys.push(key);
    index++;
  }
  
  // Jika tidak ada private key dengan format di atas, gunakan format lama
  if (privateKeys.length === 0 && process.env.PRIVATE_KEY) {
    privateKeys.push(process.env.PRIVATE_KEY);
  }
  
  return privateKeys;
}

// Buat class untuk wallet bot
class WalletBot {
  constructor(privateKey, config) {
    this.config = config;
    this.provider = new ethers.providers.JsonRpcProvider(config.rpc);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
  }
  
  // Function untuk mendapatkan token balance
  async getTokenBalance(tokenAddress) {
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
    const decimals = await tokenContract.decimals();
    const balance = await tokenContract.balanceOf(this.wallet.address);
    let symbol = '';
    
    try {
      symbol = await tokenContract.symbol();
    } catch (error) {
      symbol = 'TOKEN';
    }
    
    return {
      balance,
      decimals,
      formatted: ethers.utils.formatUnits(balance, decimals),
      symbol
    };
  }
  
  // Function untuk mendapatkan ETH balance
  async getEthBalance() {
    const balanceWei = await this.provider.getBalance(this.wallet.address);
    return {
      balance: balanceWei,
      formatted: ethers.utils.formatEther(balanceWei)
    };
  }
  
  // Function untuk swap token
  async swapToken(tokenName) {
    try {
      console.log(`\n=== [${this.address.substring(0, 6)}...] Processing ${tokenName.toUpperCase()} Swap ===`);
      
      const tokenAddress = this.config.tokens[tokenName];
      const routerAddress = this.config.routers[tokenName];
      const methodId = this.config.methodIds[`${tokenName}Swap`];
      
      if (!routerAddress || !methodId) {
        console.error(`Missing configuration for ${tokenName}`);
        return false;
      }
      
      const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
      const { balance, decimals, formatted, symbol } = await this.getTokenBalance(tokenAddress);
      console.log(`Current ${symbol} balance: ${formatted}`);
      
      if (balance.isZero()) {
        console.log(`No ${symbol} tokens available to swap.`);
        return false;
      }
      
      console.log(`Swapping ${formatted} ${symbol}`);
      
      // Cek ETH balance untuk gas
      const ethBalance = await this.getEthBalance();
      console.log(`ETH balance for gas: ${ethBalance.formatted} ETH`);
      
      // Approve router untuk menggunakan tokens
      console.log(`Approving ${formatted} ${symbol} for swap...`);
      
      const approveTx = await tokenContract.approve(routerAddress, balance, {
        gasLimit: this.config.gasLimit,
        gasPrice: this.config.gasPrice
      });
      await approveTx.wait();
      console.log(`Approved ${symbol} for swap. Tx hash: ${approveTx.hash}`);
      
      // Menggunakan Method 1: Direct amount encoding
      const data = methodId + 
                  ethers.utils.defaultAbiCoder.encode(
                    ['uint256'], 
                    [balance]
                  ).slice(2);
      
      const swapTx = await this.wallet.sendTransaction({
        to: routerAddress,
        data: data,
        gasLimit: this.config.gasLimit,
        gasPrice: this.config.gasPrice
      });
      
      const receipt = await swapTx.wait();
      console.log(`Swap completed for ${symbol}. Tx hash: ${swapTx.hash}`);
      
      // Cek balance setelah swap
      const afterBalance = await this.getTokenBalance(tokenAddress);
      console.log(`${symbol} balance after swap: ${afterBalance.formatted}`);
      
      return true;
    } catch (error) {
      console.error(`Error swapping ${tokenName}:`, error.message);
      return false;
    }
  }
  
  // Function untuk stake token
  async stakeToken(tokenName) {
    try {
      console.log(`\n=== [${this.address.substring(0, 6)}...] Processing ${tokenName.toUpperCase()} Staking ===`);
      
      const tokenAddress = this.config.tokens[tokenName];
      const stakeContractAddress = this.config.stakeContracts[tokenName];
      
      if (!stakeContractAddress) {
        console.error(`No stake contract found for token: ${tokenName}`);
        return false;
      }
      
      const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
      const { balance, decimals, formatted, symbol } = await this.getTokenBalance(tokenAddress);
      console.log(`Current ${symbol} balance: ${formatted}`);
      
      if (balance.isZero()) {
        console.log(`No ${symbol} tokens available to stake.`);
        return false;
      }
      
      console.log(`Staking ${formatted} ${symbol}`);
      
      // Cek ETH balance untuk gas
      const ethBalance = await this.getEthBalance();
      console.log(`ETH balance for gas: ${ethBalance.formatted} ETH`);
      
      // Approve staking contract untuk menggunakan tokens
      console.log(`Approving ${formatted} ${symbol} for staking...`);
      
      const approveTx = await tokenContract.approve(stakeContractAddress, balance, {
        gasLimit: this.config.gasLimit,
        gasPrice: this.config.gasPrice
      });
      await approveTx.wait();
      console.log(`Approved ${symbol} for staking. Tx hash: ${approveTx.hash}`);
      
      // Build stake transaction (menggunakan direct amount encoding)
      console.log(`Executing stake for ${formatted} ${symbol}...`);
      const data = this.config.methodIds.stake + 
                  ethers.utils.defaultAbiCoder.encode(
                    ['uint256'], 
                    [balance]
                  ).slice(2);
      
      const stakeTx = await this.wallet.sendTransaction({
        to: stakeContractAddress,
        data: data,
        gasLimit: this.config.gasLimit,
        gasPrice: this.config.gasPrice
      });
      
      const receipt = await stakeTx.wait();
      console.log(`Staking completed for ${symbol}. Tx hash: ${stakeTx.hash}`);
      
      // Cek balance setelah staking
      const afterBalance = await this.getTokenBalance(tokenAddress);
      console.log(`${symbol} balance after staking: ${afterBalance.formatted}`);
      
      return true;
    } catch (error) {
      console.error(`Error staking ${tokenName}:`, error.message);
      return false;
    }
  }
  
  // Function untuk cek status wallet
  async checkWalletStatus() {
    console.log(`\n=== Wallet Status [${this.address}] ===`);
    
    const ethBalance = await this.getEthBalance();
    console.log(`ETH Balance: ${ethBalance.formatted} ETH`);
    
    for (const [name, address] of Object.entries(this.config.tokens)) {
      const { formatted, symbol } = await this.getTokenBalance(address);
      console.log(`${symbol} (${name.toUpperCase()}) Balance: ${formatted}`);
    }
    console.log('====================\n');
  }

  async claimFaucets() {
    console.log(`\n=== [${this.address.substring(0, 6)}...] Claiming Faucet Tokens ===`);
    
    // Konfigurasi endpoint faucet
    const faucetEndpoints = {
      ath: "https://app.x-network.io/maitrix-faucet/faucet",
      usde: "https://app.x-network.io/maitrix-usde/faucet",
      lvlusd: "https://app.x-network.io/maitrix-lvl/faucet",
      virtual: "https://app.x-network.io/maitrix-virtual/faucet",
      vana: "https://app.x-network.io/maitrix-vana/faucet"
    };
    
    
    
    // Claim setiap jenis token
    for (const [tokenName, endpoint] of Object.entries(faucetEndpoints)) {
      try {
        console.log(`Claiming ${tokenName.toUpperCase()} tokens...`);
        
        const response = await axios.post(endpoint, {
          address: this.address
        });
        
        if (response.status === 200) {
          console.log(`✅ Successfully claimed ${tokenName.toUpperCase()} tokens`);
        }
      } catch (error) {
        // Tampilkan pesan error
        if (error.response && error.response.data) {
          console.log(`❌ ${tokenName.toUpperCase()} claim failed: ${JSON.stringify(error.response.data)}`);
        } else {
          console.log(`❌ Error claiming ${tokenName.toUpperCase()}: ${error.message}`);
        }
      }
      
      // Tunggu 3 detik sebelum request berikutnya untuk menghindari rate limiting
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    console.log(`Completed claiming tokens for wallet: ${this.address}`);
  }
  
  // Function untuk menjalankan bot
  async runBot() {
    console.log(`\nStarting auto swap and stake bot for wallet: ${this.address}`);
    
    try {
      // Cek status wallet sebelum operasi
      await this.checkWalletStatus();

      await this.claimFaucets();
      
      // 1. Try to swap Virtual tokens
      if (this.config.routers.virtual) {
        await this.swapToken('virtual');
      }
      
      // 2. Try to swap ATH tokens
      if (this.config.routers.ath) {
        await this.swapToken('ath');
      }

      if (this.config.routers.vnusd) {
        await this.swapToken('vnusd');
      }
      
      // 3. Try to stake tokens
      for (const tokenName of Object.keys(this.config.stakeContracts)) {
        await this.stakeToken(tokenName);
      }
      
      // Cek status wallet setelah operasi
      await this.checkWalletStatus();
      
      console.log(`Bot execution completed for wallet: ${this.address}`);
    } catch (error) {
      console.error(`Error running bot for wallet ${this.address}:`, error);
    }
  }
}

// Main function untuk menjalankan semua bot
async function runAllBots() {
  console.log('Starting multi-account swap and stake bot...');
  
  const privateKeys = getPrivateKeys();
  
  if (privateKeys.length === 0) {
    console.error('No private keys found in .env file!');
    console.log('Please add PRIVATE_KEY_1, PRIVATE_KEY_2, etc. to your .env file');
    return;
  }
  
  console.log(`Found ${privateKeys.length} accounts to process`);
  
  // Jalankan bot untuk setiap private key (secara berurutan)
  // Ini untuk menghindari rate limiting dari RPC provider
  for (let i = 0; i < privateKeys.length; i++) {
    console.log(`\n============================================`);
    console.log(`Processing account ${i+1} of ${privateKeys.length}`);
    console.log(`============================================`);
    
    const bot = new WalletBot(privateKeys[i], globalConfig);
    await bot.runBot();
  }
  
  console.log('\nAll accounts processed successfully!');
}

// Fungsi untuk menjalankan bot secara parallel (lebih cepat tapi bisa kena rate limit)
async function runAllBotsParallel() {
  console.log('Starting multi-account swap and stake bot in parallel mode...');
  
  const privateKeys = getPrivateKeys();
  
  if (privateKeys.length === 0) {
    console.error('No private keys found in .env file!');
    console.log('Please add PRIVATE_KEY_1, PRIVATE_KEY_2, etc. to your .env file');
    return;
  }
  
  console.log(`Found ${privateKeys.length} accounts to process simultaneously`);
  
  // Buat array dari semua promise bot
  const botPromises = privateKeys.map(pk => {
    const bot = new WalletBot(pk, globalConfig);
    return bot.runBot();
  });
  
  // Jalankan semua bot secara bersamaan
  await Promise.all(botPromises);
  
  console.log('\nAll accounts processed simultaneously!');
}

// Run bot secara berurutan (default dan lebih aman)
runAllBots()
  .then(() => console.log('Multi-account bot execution finished'))
  .catch(error => console.error('Failed to run multi-account bot:', error));

  const INTERVAL_MS = 86400000; // 24 jam (24 * 60 * 60 * 1000)
  console.log(`Bot akan dijalankan lagi secara otomatis setiap ${INTERVAL_MS/3600000} jam`);
  console.log(`Eksekusi berikutnya pada: ${new Date(Date.now() + INTERVAL_MS).toLocaleString()}`);
  setInterval(runAllBots, INTERVAL_MS);
