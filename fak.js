const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch').default;
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ethers } = require('ethers');
const axios = require('axios');
const { sendReport } = require('./telegramReporter');
require('dotenv').config();

// Load list helper
function loadList(filename) {
  const file = path.resolve(__dirname, filename);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}
const rotatingProxy = process.env.ROTATING_PROXY_URL || null;

(async()=>{
  if (!privateKeys.length) return console.error('No private_keys.txt');
  for (let i = 0; i < privateKeys.length; i++) {
    const key = privateKeys[i];
    const bot = new WalletBot(key, rotatingProxy);
    await bot.run();
    await bot.delay(config.delayMs);
  }
})(); console.log(`💧 ${url}`); } catch {};
      await this.delay(config.delayMs);
    }
    console.log('-- claimFaucets done');
  }

  async swap(name) {
    const router = config.routers[name];
    const method = config.methodIds[name];
    if (!router || !method) return;
    console.log(`🔄 Swap ${name}`);
    const { contract, balance, formatted, symbol } = await this.getToken(name);
    if (balance.isZero()) return;
    const tx1 = await contract.approve(router, balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`🔏 Approve ${symbol}: ${tx1.hash}`);
    await tx1.wait(); await this.delay(config.delayMs);
    const data = method + ethers.utils.defaultAbiCoder.encode(['uint256'],[balance]).slice(2);
    const tx2 = await this.wallet.sendTransaction({ to: router, data, gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`⚡ Swap ${symbol}: ${tx2.hash}`);
    await tx2.wait(); await this.delay(config.delayMs);
  }

  async stake(name, overrideAddr) {
    console.log(`🏦 Stake ${name}`);
    const { contract, balance, formatted, symbol } = await (async()=> { const tname=overrideAddr? overrideAddr: config.tokens[name]; return this.getToken(name); })();
    if (balance.isZero()) return;
    const stakeCt = config.stakes[name];
    const tx1 = await contract.approve(stakeCt, balance, { gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`🔏 Approve stake ${symbol}: ${tx1.hash}`);
    await tx1.wait(); await this.delay(config.delayMs);
    const allow = await contract.allowance(this.address, stakeCt);
    console.log(`➡️ Allowance ${symbol}: ${ethers.utils.formatUnits(allow)}`);
    const data = config.methodIds.stake + ethers.utils.defaultAbiCoder.encode(['uint256'],[balance]).slice(2);
    const tx2 = await this.wallet.sendTransaction({ to: stakeCt, data, gasLimit: config.gasLimit, gasPrice: config.gasPrice });
    console.log(`⚡ Stake ${symbol}: ${tx2.hash}`);
    await tx2.wait(); await this.delay(config.delayMs);
    await sendReport(formatStakingReport(symbol, formatted, tx2.hash));
  }

  async run() {
    console.log(`\n🌟 Processing ${this.address}`);
    await this.claimFaucets();
    for (const name of Object.keys(config.routers)) await this.swap(name);
    for (const name of Object.keys(config.stakes)) {
      const override = name === 'vnusd'
        ? '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30'
        : name === 'azusd'
          ? '0x5966cd11aED7D68705C9692e74e5688C892cb162'
          : null;
      await this.stake(name, override);
    }
  }
}

(async()=>{
  if (!privateKeys.length) return console.error('No private_keys.txt');
  for (let i = 0; i < privateKeys.length; i++) {
    const key = privateKeys[i];
    const proxy = proxies.length ? proxies[i % proxies.length] : null;
    const bot = new WalletBot(key, proxy);
    await bot.run();
    await bot.delay(config.delayMs);
  }
})();
