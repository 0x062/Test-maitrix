// multiAccountBot.js
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ======================== ✅ VALIDASI AWAL ========================
// 1. Cek environment variables
if (!process.env.PRIVATE_KEY && !process.env.PRIVATE_KEY_1) {
  console.error("🚨 ERROR: Tidak ada private key di .env file!");
  process.exit(1);
}

// 2. Cek dependency modules
try {
  require.resolve('ethers');
  require.resolve('axios');
} catch (e) {
  console.error("🚨 ERROR: Module belum diinstall!", e.message);
  console.log("Jalankan: npm install ethers axios dotenv");
  process.exit(1);
}

// ======================== 🛠 KONFIGURASI UTAMA ========================
const debugStream = fs.createWriteStream(
  path.join(__dirname, 'debugging.log'), 
  { flags: 'a' }
);

// ======================== 🚀 CLASS WALLET BOT ========================
class WalletBot {
  constructor(privateKey, config) {
    // ✅ Validasi private key
    if (!privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
      throw new Error("Format private key tidak valid!");
    }
    
    this.config = config;
    
    // ✅ Validasi RPC connection
    try {
      this.provider = new ethers.providers.JsonRpcProvider(config.rpc);
    } catch (e) {
      console.error("🚨 ERROR: Gagal terkoneksi ke RPC");
      throw e;
    }
    
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
    console.log(`✔️ Wallet ${this.address.slice(0,8)}... initialized`);
  }

  // ... (method lainnya tetap sama, tambahkan try-catch di tiap method) ...
}

// ======================== 🏃♀️ MAIN EXECUTION ========================
async function runAllBots() {
  console.log("🔄 Memulai proses...");
  
  try {
    const keys = getPrivateKeys();
    console.log(`🔑 Ditemukan ${keys.length} private key`);
    
    for (let i = 0; i < keys.length; i++) {
      console.log(`\n👉 Memproses wallet ${i+1}/${keys.length}`);
      try {
        const bot = new WalletBot(keys[i], globalConfig);
        await bot.runBot();
      } catch (e) {
        console.error(`💥 Error di wallet ${i+1}:`, e.message);
        await sendReport(`Wallet ${i+1} error: ${e.message}`);
      }
      await delay(2000);
    }
    
    console.log("✅ Semua proses selesai");
  } catch (e) {
    console.error("💥 ERROR GLOBAL:", e);
    await sendReport(`Bot crashed: ${e.message}`);
    process.exit(1);
  }
}

// ======================== 🚨 ERROR TRACKING ========================
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection:', reason);
  debugStream.write(`UNHANDLED REJECTION: ${reason}\n`);
});

process.on('uncaughtException', (error) => {
  console.error('⚠️ Uncaught Exception:', error);
  debugStream.write(`UNCAUGHT EXCEPTION: ${error.stack}\n`);
  process.exit(1);
});

// ======================== 🎬 START SCRIPT ========================
(async () => {
  try {
    console.log("🪄 Script dimulai...");
    await runAllBots();
    console.log("⏳ Next run:", new Date(Date.now() + INTERVAL_MS).toLocaleString());
  } catch (e) {
    console.error("💥 Initialization error:", e);
    process.exit(1);
  }
})();
