// utils.js
async function computeFees(provider, priorityGwei=1, bufferPct=0.1) { … }

async function sendEip1559Tx({ wallet, provider, to, data, gasLimit }) {
  const { maxFeePerGas, maxPriorityFeePerGas } = await computeFees(provider);
  console.log(`▶️ Sending tx to ${to}, fees: maxFee ${maxFeePerGas}, priority ${maxPriorityFeePerGas}`);
  const tx = await wallet.sendTransaction({ to, data, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
  const receipt = await tx.wait();
  return receipt.transactionHash;
}

module.exports = { computeFees, sendEip1559Tx };
