/**
 * Writes frontend/public/covenant-snapshot.json: one real read of everything
 * the hosted page shows (mandate, usage, every decision, the track record),
 * taken from chain now, so the page still has a ledger to show after free
 * RPCs stop serving logs that old. It is chain data, not a mock: the page
 * labels it as a snapshot and offers a live re-read.
 *
 * Usage:
 *   npx tsx scripts/generate-frontend-snapshot.ts <rpcUrl> <covenantAddress> <fromBlock>
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchSnapshot, serializeSnapshot } from "../frontend/src/lib/covenant.ts";

async function main() {
  const [rpcUrl, covenantAddress, fromBlock] = process.argv.slice(2);
  if (!rpcUrl || !covenantAddress || !fromBlock) {
    throw new Error("Usage: generate-frontend-snapshot.ts <rpcUrl> <covenantAddress> <fromBlock>");
  }
  const snap = await fetchSnapshot(rpcUrl, covenantAddress, fromBlock, 1000);
  const out = { ...snap, source: "static" as const, generatedAt: new Date().toISOString(), fromBlock: Number(fromBlock) };
  const outPath = fileURLToPath(new URL("../frontend/public/covenant-snapshot.json", import.meta.url));
  writeFileSync(outPath, serializeSnapshot(out as typeof snap) + "\n");
  console.log(`Wrote ${snap.decisions.length} decisions (block ${snap.latestBlock}, read from ${snap.rpcHost}) to frontend/public/covenant-snapshot.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
