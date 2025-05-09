// Dependencies
const { ethers } = require('ethers');
const axios = require('axios');
require('dotenv').config();

// Konfigurasi untuk multiple accounts
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
    vana:    '0xBEbF4E25652e7F23CCdCCcaaCB32004501c4BfF8',
    vnusd:   '0x46a6585a0Ad1750d37B4e6810EB59cBDf591Dc30'
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath:     '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e',
    vana:    '0xefbae3a68b17a61f21c7809edfa8aa3ca7b2546f',
    vnusd:   '0xefbae3a68b17a61f21c7809edfa8aa3ca7b2546f'
  },
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei')
};

// ABI untuk ERC-20 dan UniswapV2-like router
const erc20Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)'
];
const routerAbi = [
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])'
];

// Ambil private keys dari .env
function getPrivateKeys() {
  const keys = [];
  let i = 1;
  while (process.env[`PRIVATE_KEY_${i}`]) {
    keys.push(process.env[`PRIVATE_KEY_${i}`]);
    i++;
  }
  if (keys.length === 0 && process.env.PRIVATE_KEY) {
    keys.push(process.env.PRIVATE_KEY);
  }
  return keys;
}

// WalletBot class
class WalletBot {
  constructor(privateKey) {
    this.provider = new ethers.providers.JsonRpcProvider(globalConfig.rpc);
    this.wallet   = new ethers.Wallet(privateKey, this.provider);
    this.address  = this.wallet.address;
  }

  async getTokenBalance(addr) {
    const c = new ethers.Contract(addr, erc20Abi, this.wallet);
    const [decimals, balance] = await Promise.all([
      c.decimals(),
      c.balanceOf(this.address)
    ]);
    let symbol;
    try { symbol = await c.symbol(); } catch { symbol = 'TOKEN'; }
    return { balance, decimals, symbol, formatted: ethers.utils.formatUnits(balance, decimals) };
  }

  async getEthBalance() {
    const bal = await this.provider.getBalance(this.address);
    return ethers.utils.formatEther(bal);
  }

  // Generic swap: tokenInName -> tokenOutName
  async swapToken(tokenInName, tokenOutName) {
    try {
      console.log(`\n=== [${this.address.substring(0,6)}] Swapping ${tokenInName} → ${tokenOutName}`);
      const inAddr  = globalConfig.tokens[tokenInName];
      const outAddr = globalConfig.tokens[tokenOutName];
      const router  = new ethers.Contract(globalConfig.routers[tokenInName], routerAbi, this.wallet);

      const { balance, symbol, formatted } = await this.getTokenBalance(inAddr);
      if (balance.isZero()) { console.log(`No ${symbol} to swap.`); return; }
      console.log(`Amount: ${formatted} ${symbol}`);

      // Approve
      await (await new ethers.Contract(inAddr, erc20Abi, this.wallet)
        .approve(router.address, balance, { gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice }))
        .wait();

      // Swap parameters
      const path = [inAddr, outAddr];
      const amountOutMin = 0; // atur slippage sesuai kebutuhan
      const deadline = Math.floor(Date.now()/1000) + 60*10;

      const tx = await router.swapExactTokensForTokens(
        balance, amountOutMin, path, this.address, deadline,
        { gasLimit: globalConfig.gasLimit, gasPrice: globalConfig.gasPrice }
      );
      await tx.wait();
      console.log(`Swap tx: ${tx.hash}`);

      const outBal = await this.getTokenBalance(outAddr);
      console.log(`Received: ${outBal.formatted} ${outBal.symbol}`);
    } catch (err) {
      console.error('Swap error:', err);
    }
  }

  async runBot() {
    console.log(`\n--- Starting bot for ${this.address}`);
    // Swap VANA → vnUSD
    await this.swapToken('vana', 'vnusd');
    console.log('--- Bot finished');
  }
}

// Main execution
(async () => {
  const keys = getPrivateKeys();
  if (!keys.length) return console.error('No private keys in .env');

  for (const pk of keys) {
    const bot = new WalletBot(pk);
    await bot.runBot();
  }
})();
