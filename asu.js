// multiAccountBot.js
const { ethers } = require('ethers');
const { sendReport } = require('./telegramReporter');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// 1️⃣ Setup debug logging ke file
const debugStream = fs.createWriteStream(
  path.join(__dirname, 'debugging.log'), 
  { flags: 'a' } // append mode
);

function debugLog(...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : arg
  ).join(' ');
  debugStream.write(`[${timestamp}] ${message}\n`);
}

// 2️⃣ Redirect console.debug ke file
console.debug = (...args) => {
  debugLog('[CONSOLE.DEBUG]', ...args);
};

// 3️⃣ Hapus semua console.log yang terkait debug
// ... (di dalam class WalletBot) ...

class WalletBot {
  constructor(privateKey, config) {
    this.config = config;
    this.provider = new ethers.providers.JsonRpcProvider(config.rpc);
    
    // Redirect debug provider ke file
    this.provider.on('debug', (data) => {
      debugLog('[RPC DEBUG]', {
        action: data.action,
        request: data.request
      });
    });
    
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
  }

  async swapToken(tokenName) {
    try {
      // Tetap tampilkan log utama di console
      console.log(`\n--- Swap ${tokenName} for ${this.address} ---`);
      
      // Log debug ke file
      debugLog(`Memulai swap ${tokenName}`, {
        address: this.address,
        token: this.config.tokens[tokenName]
      });

      // ... kode swap yang sama ...
      
      // Contoh log debug transaksi
      debugLog(`TX swap dibuat`, {
        hash: tx.hash,
        nonce: tx.nonce
      });

    } catch (e) {
      debugLog(`Error swap: ${e.message}`, e.stack);
      throw e;
    }
  }

  async stakeToken(tokenName, customAddr = null) {
    try {
      debugLog(`Memulai stake ${tokenName}`, {
        customAddress: customAddr
      });
      
      // ... kode stake yang sama ...

    } catch (e) {
      debugLog(`Error stake: ${e.message}`, {
        token: tokenName,
        stack: e.stack
      });
      throw e;
    }
  }

  // ... method lainnya tetap sama ...
}

// 4️⃣ Handle shutdown untuk close stream
process.on('SIGINT', () => {
  debugLog('Aplikasi dimatikan');
  debugStream.end(() => process.exit());
});

process.on('exit', () => {
  debugStream.end();
});

// ... kode lainnya tetap sama tanpa perubahan ...
