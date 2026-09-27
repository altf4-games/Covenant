/**
 * Writes frontend/public/decisions-snapshot.json - a committed, re-verified
 * list of every real Covenant decision (commit/settle/cancel txHashes), so
 * the frontend can show real judging evidence even if the live RPC it's
 * pointed at is slow, rate-limited, or refuses the block range (public BSC
 * RPCs cap eth_getLogs and prune old receipts - docs/partner-feedback/
 * friction-log.md B16, and the "archive RPC" row in README.md's table).
 *
 * This is a re-verification pass, not a second data source: every decision
 * still comes from the real, already-deployed Covenant via the same
 * fetchDecisionEvents()/joinDecisions() path status-page/lib.mjs's live
 * code uses. What this script adds on top is confirming each event's
 * transaction really is mined with status success, read back independently
 * via eth_getTransactionReceipt against the RPCs verified live to serve old
 * receipts (bsc-dataseed, 1rpc - publicnode does not, same friction-log
 * entry) - so a snapshot entry is never just "an event fetchDecisionEvents
 * returned" but "an event, and a receipt independently confirming that
 * exact tx really happened."
 *
 * Deliberately NOT run against a Hardhat fork's throwaway deployment - only
 * meaningful once run against the real mainnet Covenant deployment, over
 * real transaction history (PLAN.md: the mainnet deploy is the last step,
 * after which this generates real judging evidence, not fork noise).
 *
 * Usage:
 *   npx tsx scripts/generate-decisions-snapshot.ts <rpcUrl> <covenantAddress> <fromBlock>
 */
import { ethers } from "ethers";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ABI, fetchDecisionEvents, joinDecisions } from "../status-page/lib.mjs";

// Verified live (docs/partner-feedback/friction-log.md) to serve old
// receipts, unlike publicnode, which refuses archive ranges and old
// receipts outright.
const ARCHIVE_RPCS = ["https://bsc-dataseed.binance.org", "https://1rpc.io/bnb"];

async function confirmReceipt(txHash: string): Promise<{ blockNumber: number; status: number }> {
  let lastError: unknown;
  for (const url of ARCHIVE_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) throw new Error(`${url} has no receipt for ${txHash} (pruned, or never mined)`);
      if (receipt.status !== 1) throw new Error(`${txHash} reverted on chain (status ${receipt.status})`);
      return { blockNumber: receipt.blockNumber, status: receipt.status };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Could not independently confirm ${txHash} against any archive RPC: ${String(lastError)}`);
}

async function main() {
  const [rpcUrl, covenantAddress, fromBlockArg] = process.argv.slice(2);
  if (!rpcUrl || !covenantAddress || !fromBlockArg) {
    throw new Error("Usage: generate-decisions-snapshot.ts <rpcUrl> <covenantAddress> <fromBlock>");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const covenant = new ethers.Contract(covenantAddress, ABI, provider);
  const events = await fetchDecisionEvents(covenant, { fromBlock: Number(fromBlockArg) });
  const decisions = joinDecisions(events);

  const snapshot: {
    covenantAddress: string;
    generatedAt: string;
    decisions: Array<{ id: string; commitTxHash?: string; settleTxHash?: string; cancelled: boolean; confirmedBlock?: number }>;
  } = { covenantAddress, generatedAt: new Date().toISOString(), decisions: [] };

  for (const d of decisions) {
    const entry: (typeof snapshot.decisions)[number] = { id: d.id, cancelled: d.cancelled };
    if (d.commit?.txHash) {
      console.log(`Confirming decision #${d.id}'s commit (${d.commit.txHash})...`);
      const receipt = await confirmReceipt(d.commit.txHash);
      entry.commitTxHash = d.commit.txHash;
      entry.confirmedBlock = receipt.blockNumber;
    }
    if (d.settle?.txHash) {
      console.log(`Confirming decision #${d.id}'s settle (${d.settle.txHash})...`);
      await confirmReceipt(d.settle.txHash);
      entry.settleTxHash = d.settle.txHash;
    }
    snapshot.decisions.push(entry);
  }

  const outPath = fileURLToPath(new URL("../frontend/public/decisions-snapshot.json", import.meta.url));
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`\nWrote ${snapshot.decisions.length} re-verified decisions to frontend/public/decisions-snapshot.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
