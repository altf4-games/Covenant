/**
 * Phase 3 Day 1's throwaway gate-test contract, deployed for real to BSC
 * mainnet. See PLAN-PHASE3-V2-2026-09-24.md and contracts/Gate.sol for why
 * this exists: proving a real `baw contract-call preview/execute` round
 * trip works before building anything real on that assumption.
 *
 * Uses a raw ethers.Wallet + JsonRpcProvider, not hardhat-ethers's wrapped
 * signer (`network.getOrCreate("bsc")`) - that wrapper's post-broadcast
 * `checkTx` re-fetch throws on this RPC's `to: ""` (rather than `to: null`)
 * for contract-creation receipts, even though the deploy itself succeeds.
 * See docs/partner-feedback/friction-log.md C16. Confirms success by
 * independently re-reading the real receipt, not by trusting the ethers
 * promise chain alone - the same discipline used elsewhere in this project.
 *
 * Usage:
 *   npx tsx scripts/deploy-gate.ts
 *   (reads DEPLOYER_PRIVATE_KEY and BSC_RPC_URL from .env)
 */
import { ethers } from "ethers";
import { bscProvider } from "./lib/bsc-provider.js";
import gateArtifact from "../artifacts/contracts/Gate.sol/Gate.json" with { type: "json" };

try {
  process.loadEnvFile();
} catch {
  // no .env - real environment variables only
}


async function main() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("Set DEPLOYER_PRIVATE_KEY in .env");

  const provider = bscProvider(process.env.BSC_RPC_URL || undefined);
  const signer = new ethers.Wallet(privateKey, provider);
  console.log(`Deployer: ${signer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await provider.getBalance(signer.address))} BNB`);

  const factory = new ethers.ContractFactory(gateArtifact.abi, gateArtifact.bytecode, signer);
  const deployTx = await factory.getDeployTransaction();
  const sentTx = await signer.sendTransaction(deployTx);
  console.log(`Deploy tx sent: ${sentTx.hash}`);

  // Poll the real receipt directly, not signer.sendTransaction()'s own
  // resolved value or ContractFactory.deploy()'s wait() - both round-trip
  // through hardhat-ethers-style formatting elsewhere in this codebase, and
  // a raw receipt is the one thing that can't lie about what's on chain.
  let receipt = null;
  for (let i = 0; i < 30 && !receipt; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    receipt = await provider.getTransactionReceipt(sentTx.hash);
  }
  if (!receipt) throw new Error("Deploy tx not mined within 90s");
  if (receipt.status !== 1) throw new Error(`Deploy tx reverted (status=${receipt.status})`);
  if (!receipt.contractAddress) throw new Error("Receipt has no contractAddress");

  console.log(`Gate deployed at: ${receipt.contractAddress}`);
  console.log(`Block: ${receipt.blockNumber}`);

  const code = await provider.getCode(receipt.contractAddress);
  console.log(`Real bytecode present: ${code.length > 2} (${code.length} chars)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
