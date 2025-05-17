const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent;
require('dotenv').config();

// ======================== 🛠 KONFIGURASI ========================
const CONFIG = {
  RPC: 'https://arbitrum-sepolia.gateway.tenderly.co',
  CHAIN_ID: 421614,
  
  // Gas Settings
  GAS: {
    gasLimit: 1000000,
    maxFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits('1', 'gwei')
  },
  
  // Delay Settings
  DELAY: {
    BETWEEN_TX: 17000,    // 17 detik antar transaksi
    BETWEEN_ACCOUNTS: 30000 // 30 detik antar akun
  },

  // Token Contracts
  TOKENS: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath: '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd: '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde: '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd: '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd: '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
    vnusd: '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8'
  },

  // Router Contracts
  ROUTERS: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath: '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vnusd: '0xEfbAE3A68b17a61f21C7809Edfa8Aa3CA7B2546f'
  },

  // Stake Contracts
  STAKE: {
    ausd: '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde: '0x3988053b7c748023a1ae19a8ed4c1bf217932bdb',
    lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd: '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51',
    vnusd: '0x2608A88219BFB34519f635Dd9Ca2Ae971539ca60'
  },

  // Method IDs
  METHODS: {
    virtualSwap: '0xa6d67510',
    athSwap: '0x1bf6318b',
    vnusdSwap: '0xa6d67510',
    stake: '0xa694fc3a'
  },

  // Faucet Endpoints
  FAUCETS: {
    ath: 'https://app.x-network.io/maitrix-faucet/faucet',
    usde: 'https://app.x-network.io/maitrix-usde/faucet',
    lvlusd: 'https://app.x-network.io/maitrix-lvl/faucet',
    virtual: 'https://app.x-network.io/maitrix-virtual/faucet',
    vana: 'https://app.x-network.io/maitrix-vana/faucet'
  }
};

// ======================== 🤖 KELAS UTAMA BOT ========================
class DexBot {
  constructor(privateKey, proxyString) {
    this.privateKey = privateKey;
    this.provider = new ethers.providers.JsonRpcProvider(CONFIG.RPC);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.proxyString = proxyString;
    this.httpsAgent = this.createProxyAgent();
  }

  createProxyAgent() {
    if (!this.proxyString) return null;
    
    try {
      const proxyUrl = this.proxyString.includes('://') 
        ? this.proxyString 
        : `http://${this.proxyString}`;
      
      console.log('🔧 Menggunakan proxy:', proxyUrl);
      return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      console.error('❌ Gagal membuat proxy agent:', e.message);
      return null;
    }
  }

  async checkRpcConnection() {
    try {
      const network = await this.provider.getNetwork();
      console.log(`⛓ Terhubung ke jaringan (Chain ID: ${network.chainId})`);
      return network.chainId === CONFIG.CHAIN_ID;
    } catch (e) {
      throw new Error(`Gagal terhubung ke RPC: ${e.message}`);
    }
  }

  async checkBalances() {
    console.log('\n💰 Cek Saldo:');
    
    // ETH Balance
    const ethBalance = await this.provider.getBalance(this.wallet.address);
    console.log(`- ETH: ${ethers.utils.formatEther(ethBalance)}`);

    // ERC20 Balances
    for (const [name, address] of Object.entries(CONFIG.TOKENS)) {
      try {
        const contract = new ethers.Contract(address, erc20Abi, this.wallet);
        const [balance, decimals, symbol] = await Promise.all([
          contract.balanceOf(this.wallet.address),
          contract.decimals(),
          contract.symbol().catch(() => name.toUpperCase())
        ]);
        console.log(`- ${symbol}: ${ethers.utils.formatUnits(balance, decimals)}`);
      } catch (e) {
        console.log(`- ${name}: Gagal mengambil saldo`);
      }
      await delay(1000);
    }
  }

  async httpRequest(url, data) {
    if (!this.httpsAgent) throw new Error('Proxy tidak terkonfigurasi');
    
    try {
      return await axios.post(url, data, {
        httpsAgent: this.httpsAgent,
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
    } catch (e) {
      throw new Error(`Gagal request ke ${url}: ${e.message}`);
    }
  }

  async claimFaucets() {
    if (!this.httpsAgent) {
      console.log('⚠️ Proxy tidak aktif, skip faucet');
      return;
    }
    
    console.log('\n🚰 Mengklaim Faucet:');
    for (const [token, url] of Object.entries(CONFIG.FAUCETS)) {
      try {
        await this.httpRequest(url, { address: this.wallet.address });
        console.log(`✅ ${token.toUpperCase()}: Klaim berhasil`);
        await delay(CONFIG.DELAY.BETWEEN_TX);
      } catch (e) {
        console.log(`❌ ${token.toUpperCase()}: Gagal klaim - ${e.message}`);
      }
    }
  }

  async processTokenSwap(tokenName) {
    console.log(`\n🔄 Memproses Swap ${tokenName.toUpperCase()}`);
    const tokenAddress = CONFIG.TOKENS[tokenName];
    const router = CONFIG.ROUTERS[tokenName];
    const methodId = CONFIG.METHODS[`${tokenName}Swap`];

    const contract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
    
    // 1. Cek Balance
    const balance = await contract.balanceOf(this.wallet.address);
    if (balance.isZero()) throw new Error('Saldo kosong');

    // 2. Approve
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
      ...CONFIG.GAS
    });
    
    await tx.wait();
    console.log(`✅ ${tokenName.toUpperCase()}: Swap berhasil`);
  }

  async processStaking(tokenName) {
    console.log(`\n🔒 Memproses Staking ${tokenName.toUpperCase()}`);
    const stakeContract = CONFIG.STAKE[tokenName];
    const tokenAddress = CONFIG.TOKENS[tokenName];
    
    const contract = new ethers.Contract(tokenAddress, erc20Abi, this.wallet);
    
    // 1. Cek Balance
    const balance = await contract.balanceOf(this.wallet.address);
    if (balance.isZero()) throw new Error('Saldo kosong');

    // 2. Approve
    const approveTx = await contract.approve(
      stakeContract,
      balance,
      {
        gasLimit: CONFIG.GAS.gasLimit,
        maxFeePerGas: CONFIG.GAS.maxFeePerGas,
        maxPriorityFeePerGas: CONFIG.GAS.maxPriorityFeePerGas
      }
    );
    await approveTx.wait();
    
    // 3. Execute Stake
    const txData = CONFIG.METHODS.stake + ethers.utils.defaultAbiCoder.encode(['uint256'], [balance]).slice(2);
    const tx = await this.wallet.sendTransaction({
      to: stakeContract,
      data: txData,
      ...CONFIG.GAS
    });
    
    await tx.wait();
    console.log(`✅ ${tokenName.toUpperCase()}: Staking berhasil`);
  }

  async run() {
    console.log(`\n🚀 Memulai Wallet: ${this.wallet.address.slice(0, 8)}...`);
    
    try {
      // 1. Verifikasi koneksi RPC
      if (!(await this.checkRpcConnection())) return;

      // 2. Tampilkan saldo awal
      await this.checkBalances();

      // 3. Klaim faucet
      await this.claimFaucets();

      // 4. Proses semua swap
      for (const token of Object.keys(CONFIG.TOKENS)) {
        await this.processTokenSwap(token);
        await delay(CONFIG.DELAY.BETWEEN_TX);
      }

      // 5. Tampilkan saldo setelah swap
      await this.checkBalances();

      // 6. Proses semua staking
      for (const token of Object.keys(CONFIG.STAKE)) {
        await this.processStaking(token);
        await delay(CONFIG.DELAY.BETWEEN_TX);
      }

      // 7. Tampilkan saldo akhir
      await this.checkBalances();

      console.log('\n🎉 Operasi selesai untuk wallet ini');
    } catch (e) {
      console.error(`💀 Error: ${e.message}`);
    }
  }
}

// ======================== 🛠 FUNGSI UTILITAS ========================
const erc20Abi = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================== 🚀 EKSEKUSI UTAMA ========================
async function main() {
  try {
    console.log('🚀 Starting Multi-Wallet Bot');
    console.log('=============================');

    // 1. Load proxy
    const proxy = fs.existsSync('proxies.txt')
      ? fs.readFileSync('proxies.txt', 'utf-8').trim()
      : null;
    console.log(proxy ? `🔧 Proxy: ${proxy}` : '⚠️ Tanpa proxy');

    // 2. Load semua private keys
    const keys = [];
    let index = 1;
    while (process.env[`PRIVATE_KEY_${index}`]) {
      keys.push(process.env[`PRIVATE_KEY_${index}`]);
      index++;
    }

    if (keys.length === 0) {
      throw new Error(`
        Tidak ada private key yang ditemukan!
        Format .env yang benar:
        PRIVATE_KEY_1=0x...
        PRIVATE_KEY_2=0x...
      `);
    }
    console.log(`🔑 Ditemukan ${keys.length} wallet`);

    // 3. Proses semua wallet
    for (const [idx, key] of keys.entries()) {
      console.log(`\n💼 Wallet ${idx + 1}/${keys.length}`);
      const bot = new DexBot(key, proxy);
      await bot.run();
      
      // Delay antar wallet kecuali wallet terakhir
      if (idx < keys.length - 1) {
        console.log(`⏳ Menunggu ${CONFIG.DELAY.BETWEEN_ACCOUNTS/1000} detik...`);
        await delay(CONFIG.DELAY.BETWEEN_ACCOUNTS);
      }
    }

    console.log('\n✅ Semua wallet selesai diproses');
  } catch (e) {
    console.error(`💥 Error utama: ${e.message}`);
    process.exit(1);
  }
}

// Penanganan error global
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('⚠️ Uncaught Exception:', error);
  process.exit(1);
});

// Jalankan aplikasi
main();
