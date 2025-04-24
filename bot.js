const { ethers } = require('ethers');
require('dotenv').config();

// Configuration
const config = {
  rpc: 'https://arbitrum-sepolia.gateway.tenderly.co',
  chainId: 421614,
  privateKey: process.env.PRIVATE_KEY, // Store your private key in .env file
  tokens: {
    virtual: '0xFF27D611ab162d7827bbbA59F140C1E7aE56e95C',
    ath: '0x1428444Eacdc0Fd115dd4318FcE65B61Cd1ef399',
    ausd: '0x78De28aABBD5198657B26A8dc9777f441551B477',
    usde: '0xf4BE938070f59764C85fAcE374F92A4670ff3877',
    lvlusd: '0x8802b7bcF8EedCc9E1bA6C20E139bEe89dd98E83',
    vusd: '0xc14A8E2Fc341A97a57524000bF0F7F1bA4de4802',
  },
  routers: {
    virtual: '0x3dCACa90A714498624067948C092Dd0373f08265',
    ath: '0x2cFDeE1d5f04dD235AEA47E1aD2fB66e3A61C13e'
  },
  stakeContracts: {
    ausd: '0x054de909723ECda2d119E31583D40a52a332f85c',
    usde: '0x07f8ec2B79B7A1998Fd0B21a4668B0Cf1cA72C02',
    lvlusd: '0x5De3fBd40D4c3892914c3b67b5B529D776A1483A',
    vusd: '0x5bb9Fa02a3DCCDB4E9099b48e8Ba5841D2e59d51'
  },
  methodIds: {
    virtualSwap: '0xa6d67510',
    athSwap: '0x1bf6318b',
    stake: '0xa694fc3a'
  },
  gasLimit: 1000000,
  gasPrice: ethers.utils.parseUnits('0.1', 'gwei')
};

// ABI for ERC20 token
const erc20Abi = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function symbol() view returns (string)'
];

// Initialize provider and signer
const provider = new ethers.providers.JsonRpcProvider(config.rpc);
const wallet = new ethers.Wallet(config.privateKey, provider);

// Function to get token balance
async function getTokenBalance(tokenAddress) {
  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  const decimals = await tokenContract.decimals();
  const balance = await tokenContract.balanceOf(wallet.address);
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

// Function to get ETH balance
async function getEthBalance() {
  const balanceWei = await provider.getBalance(wallet.address);
  return {
    balance: balanceWei,
    formatted: ethers.utils.formatEther(balanceWei)
  };
}

// Function to swap token using direct amount encoding (Method 1)
async function swapToken(tokenName) {
  try {
    console.log(`\n=== Processing ${tokenName.toUpperCase()} Swap ===`);
    
    const tokenAddress = config.tokens[tokenName];
    const routerAddress = config.routers[tokenName];
    const methodId = config.methodIds[`${tokenName}Swap`];
    
    if (!routerAddress || !methodId) {
      console.error(`Missing configuration for ${tokenName}`);
      return false;
    }
    
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
    const { balance, decimals, formatted, symbol } = await getTokenBalance(tokenAddress);
    console.log(`Current ${symbol} balance: ${formatted}`);
    
    if (balance.isZero()) {
      console.log(`No ${symbol} tokens available to swap.`);
      return false;
    }
    
    console.log(`Swapping ${formatted} ${symbol}`);
    
    // Check ETH balance for gas
    const ethBalance = await getEthBalance();
    console.log(`ETH balance for gas: ${ethBalance.formatted} ETH`);
    
    // Approve router to spend tokens
    console.log(`Approving ${formatted} ${symbol} for swap...`);
    
    const approveTx = await tokenContract.approve(routerAddress, balance, {
      gasLimit: config.gasLimit,
      gasPrice: config.gasPrice
    });
    await approveTx.wait();
    console.log(`Approved ${symbol} for swap. Tx hash: ${approveTx.hash}`);
    
    // Using Method 1: Direct amount encoding
    const data = methodId + 
                ethers.utils.defaultAbiCoder.encode(
                  ['uint256'], 
                  [balance]
                ).slice(2);
    
    const swapTx = await wallet.sendTransaction({
      to: routerAddress,
      data: data,
      gasLimit: config.gasLimit,
      gasPrice: config.gasPrice
    });
    
    const receipt = await swapTx.wait();
    console.log(`Swap completed for ${symbol}. Tx hash: ${swapTx.hash}`);
    
    // Check balance after swap
    const afterBalance = await getTokenBalance(tokenAddress);
    console.log(`${symbol} balance after swap: ${afterBalance.formatted}`);
    
    return true;
  } catch (error) {
    console.error(`Error swapping ${tokenName}:`, error.message);
    return false;
  }
}

// Function to stake tokens using MAX balance
async function stakeToken(tokenName) {
  try {
    console.log(`\n=== Processing ${tokenName.toUpperCase()} Staking ===`);
    
    const tokenAddress = config.tokens[tokenName];
    const stakeContractAddress = config.stakeContracts[tokenName];
    
    if (!stakeContractAddress) {
      console.error(`No stake contract found for token: ${tokenName}`);
      return false;
    }
    
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
    const { balance, decimals, formatted, symbol } = await getTokenBalance(tokenAddress);
    console.log(`Current ${symbol} balance: ${formatted}`);
    
    if (balance.isZero()) {
      console.log(`No ${symbol} tokens available to stake.`);
      return false;
    }
    
    console.log(`Staking ${formatted} ${symbol}`);
    
    // Check ETH balance for gas
    const ethBalance = await getEthBalance();
    console.log(`ETH balance for gas: ${ethBalance.formatted} ETH`);
    
    // Approve staking contract to spend tokens
    console.log(`Approving ${formatted} ${symbol} for staking...`);
    
    const approveTx = await tokenContract.approve(stakeContractAddress, balance, {
      gasLimit: config.gasLimit,
      gasPrice: config.gasPrice
    });
    await approveTx.wait();
    console.log(`Approved ${symbol} for staking. Tx hash: ${approveTx.hash}`);
    
    // Build stake transaction (using direct amount encoding like Method 1)
    console.log(`Executing stake for ${formatted} ${symbol}...`);
    const data = config.methodIds.stake + 
                ethers.utils.defaultAbiCoder.encode(
                  ['uint256'], 
                  [balance]
                ).slice(2);
    
    const stakeTx = await wallet.sendTransaction({
      to: stakeContractAddress,
      data: data,
      gasLimit: config.gasLimit,
      gasPrice: config.gasPrice
    });
    
    const receipt = await stakeTx.wait();
    console.log(`Staking completed for ${symbol}. Tx hash: ${stakeTx.hash}`);
    
    // Check balance after staking
    const afterBalance = await getTokenBalance(tokenAddress);
    console.log(`${symbol} balance after staking: ${afterBalance.formatted}`);
    
    return true;
  } catch (error) {
    console.error(`Error staking ${tokenName}:`, error.message);
    return false;
  }
}

// Function to check wallet status
async function checkWalletStatus() {
  console.log('\n=== Wallet Status ===');
  console.log(`Address: ${wallet.address}`);
  
  const ethBalance = await getEthBalance();
  console.log(`ETH Balance: ${ethBalance.formatted} ETH`);
  
  for (const [name, address] of Object.entries(config.tokens)) {
    const { formatted, symbol } = await getTokenBalance(address);
    console.log(`${symbol} (${name.toUpperCase()}) Balance: ${formatted}`);
  }
  console.log('====================\n');
}

// Main function to run the bot
async function runBot() {
  console.log('Starting auto swap and stake bot...');
  
  try {
    // Check wallet status before operations
    await checkWalletStatus();
    
    // 1. Try to swap Virtual tokens
    if (config.routers.virtual) {
      await swapToken('virtual');
    }
    
    // 2. Try to swap ATH tokens
    if (config.routers.ath) {
      await swapToken('ath');
    }
    
    // 3. Try to stake tokens
    for (const tokenName of Object.keys(config.stakeContracts)) {
      await stakeToken(tokenName);
    }
    
    // Check wallet status after operations
    await checkWalletStatus();
    
    console.log('Bot execution completed');
  } catch (error) {
    console.error('Error running bot:', error);
  }
}

// Run the bot once
runBot()
  .then(() => console.log('Bot execution finished'))
  .catch(error => console.error('Failed to run bot:', error));

// Uncomment to run the bot on a schedule (e.g., every hour)
/*
const INTERVAL_MS = 3600000; // 1 hour
setInterval(runBot, INTERVAL_MS);
*/
