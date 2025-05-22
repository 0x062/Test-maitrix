const { ethers } = require('ethers');

async function computeFees(provider, priorityGwei = 1, bufferPct = 0.1) {
  const latest = await provider.getBlock('latest');
  const baseFee = latest.baseFeePerGas;
  const priorityFee = ethers.utils.parseUnits(String(priorityGwei), 'gwei');
  const buffer = baseFee.mul(Math.floor(bufferPct * 100)).div(100);
  return {
    maxFeePerGas: baseFee.add(priorityFee).add(buffer),
    maxPriorityFeePerGas: priorityFee
  };
}

module.exports = { computeFees };
