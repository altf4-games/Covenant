/**
 * Judge-runnable verification: given a deployed Covenant and a list of
 * transaction hashes, re-fetch each real receipt from chain, find
 * Covenant's own event in it, and decode it - without trusting anything
 * this project says about the transaction.
 *
 * A judge doesn't have this project's Agentic Wallet, developer mode, or
 * bStock jurisdiction clearance, so they can't reproduce a trade. They can
 * check that each claimed decision really happened and really decoded to
 * what the README says. For the stronger check - that every real trade in
 * the wallet maps to a decision - see scripts/verify.ts, which builds on
 * the decoders here.
 *
 * Usage:
 *   COVENANT_ADDRESS=0x... npm run judge
 *   (tx hashes from JUDGE_TX_HASHES, comma-separated, or data/judge-tx-hashes.json)
 *
 * RPC failover: BSC_RPC_URL, if set, is tried first, then cli.mjs's
 * DEFAULT_BSC_RPCS. A judge shouldn't depend on one free endpoint staying
 * up (friction-log.md B12-B14).
 */
import { readFile } from "node:fs/promises";
import { SELECTORS, DENIAL_REASONS, jsonRpcWithFailover, ethCallWithFailover, DEFAULT_BSC_RPCS } from "../skills/covenant-mandate/scripts/cli.mjs";

const slot = (data: string, i: number) => "0x" + data.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const asBool = (data: string, i: number) => BigInt(slot(data, i)) !== 0n;
const asUint = (data: string, i: number) => BigInt(slot(data, i));

// Event topic hashes, taken from the compiled ABI (ethers' Interface
// getEvent().topicHash) rather than typed by hand, and cross-checked
// against real logs in test/judge.live.ts.
export const TOPICS = {
  // Changed by red-team fix H11 (2026-09-25): DecisionCommitted's signature
  // grew four fields, which changes its topic hash even though none of the
  // original fields moved.
  DecisionCommitted: "0x85599ed59c2ad36a18a94f574384c38fa73f727980f79081420b0e6a1ffbd6ce",
  DecisionSettled: "0x5f5f16943bfa53515eb2d5089225b2c96b0e1a906fe47635ec6da118af7992b9",
  DecisionCancelled: "0xf825ba484bb648876e5bc189a2b67360ce0c51019c4f271f406cf58ddcc4961d",
};

export const SIDE_NAMES = ["buy", "sell"];
export const EXECUTION_MODE_NAMES = ["unknown", "pool", "rfq", "aggregator"];

const TX_HASHES_FILE = new URL("../data/judge-tx-hashes.json", import.meta.url).pathname;

export type RpcTarget = string | string[];
export const asRpcList = (target: RpcTarget): string[] => (Array.isArray(target) ? target : [target]);

type Log = { address: string; topics: string[]; data: string };

export interface CommittedDecision {
  kind: "commit";
  id: string;
  token: string;
  side: string;
  allowed: boolean;
  reason: string;
  amountIn: string;
  quotedOut: string;
  minOut: string;
  quoteRef: string;
  researchRef: string;
  expiresAt: number;
  /** Red-team H11: what was in force at commit time, no history replay needed. */
  mandateMaxNotionalPerTradeUsd: string;
  mandateMaxTradesPerDay: string;
  mandateExpiry: number;
  oracleUpdatedAt: number;
}

export interface SettledDecision {
  kind: "settle";
  id: string;
  swapTxHash: string;
  amountOut: string;
  executionMode: string;
  belowMin: boolean;
}

export interface CancelledDecision {
  kind: "cancel";
  id: string;
}

export type DecodedEvent = CommittedDecision | SettledDecision | CancelledDecision;

/** Decodes one of Covenant's decision events from a raw log, or null. */
export function decodeCovenantLog(log: Log): DecodedEvent | null {
  const topic = log.topics[0]?.toLowerCase();
  const data = log.data;
  if (topic === TOPICS.DecisionCommitted) {
    const reasonIndex = Number(asUint(data, 2));
    return {
      kind: "commit",
      id: BigInt(log.topics[1]).toString(),
      token: "0x" + log.topics[2].slice(-40),
      side: SIDE_NAMES[Number(asUint(data, 0))] ?? "unknown",
      allowed: asBool(data, 1),
      reason: DENIAL_REASONS[reasonIndex] ?? `UNKNOWN(${reasonIndex})`,
      amountIn: asUint(data, 3).toString(),
      quotedOut: asUint(data, 4).toString(),
      minOut: asUint(data, 5).toString(),
      quoteRef: slot(data, 6),
      researchRef: slot(data, 7),
      expiresAt: Number(asUint(data, 8)),
      mandateMaxNotionalPerTradeUsd: asUint(data, 9).toString(),
      mandateMaxTradesPerDay: asUint(data, 10).toString(),
      mandateExpiry: Number(asUint(data, 11)),
      oracleUpdatedAt: Number(asUint(data, 12)),
    };
  }
  if (topic === TOPICS.DecisionSettled) {
    return {
      kind: "settle",
      id: BigInt(log.topics[1]).toString(),
      swapTxHash: log.topics[2],
      amountOut: asUint(data, 0).toString(),
      executionMode: EXECUTION_MODE_NAMES[Number(asUint(data, 1))] ?? "unknown",
      belowMin: asBool(data, 2),
    };
  }
  if (topic === TOPICS.DecisionCancelled) {
    return { kind: "cancel", id: BigInt(log.topics[1]).toString() };
  }
  return null;
}

export interface VerifiedTx {
  txHash: string;
  ok: boolean;
  detail: string;
  blockNumber?: string;
  events?: DecodedEvent[];
}

/**
 * Re-fetches a transaction's real receipt and decodes every Covenant
 * decision event in it. Trusts nothing but the receipt the RPC returns.
 */
export async function verifyTx(rpcTarget: RpcTarget, covenantAddress: string, txHash: string): Promise<VerifiedTx> {
  const { result: receipt } = await jsonRpcWithFailover("eth_getTransactionReceipt", [txHash], { rpcUrls: asRpcList(rpcTarget) });
  if (!receipt) return { txHash, ok: false, detail: "no receipt found - transaction does not exist on this chain" };
  if (receipt.status !== "0x1") return { txHash, ok: false, detail: `transaction reverted (status=${receipt.status})` };

  const events = (receipt.logs as Log[])
    .filter((l) => l.address.toLowerCase() === covenantAddress.toLowerCase())
    .map(decodeCovenantLog)
    .filter((e): e is DecodedEvent => e !== null);
  if (events.length === 0) {
    return { txHash, ok: false, detail: "no Covenant decision event from this contract in this receipt", blockNumber: receipt.blockNumber };
  }
  return { txHash, ok: true, detail: "verified", blockNumber: receipt.blockNumber, events };
}

export async function readTxHashList(): Promise<string[]> {
  if (process.env.JUDGE_TX_HASHES) {
    return process.env.JUDGE_TX_HASHES.split(",").map((h) => h.trim()).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(await readFile(TX_HASHES_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function readMandate(rpcTarget: RpcTarget, covenantAddress: string) {
  const rpcUrls = asRpcList(rpcTarget);
  const { result: raw } = await ethCallWithFailover(covenantAddress, SELECTORS.mandate, { rpcUrls });
  return {
    active: asBool(raw, 0),
    maxNotionalPerTradeUsd: asUint(raw, 1).toString(),
    maxTradesPerDay: asUint(raw, 2).toString(),
    expiry: asUint(raw, 3).toString(),
  };
}

export async function runJudge(rpcTarget: RpcTarget, covenantAddress: string, txHashes: string[]) {
  const rpcUrls = asRpcList(rpcTarget);
  const mandate = await readMandate(rpcUrls, covenantAddress);
  const results = await Promise.all(txHashes.map((h) => verifyTx(rpcUrls, covenantAddress, h)));
  return { mandate, results, allVerified: results.length > 0 && results.every((r) => r.ok) };
}

function describeEvent(e: DecodedEvent): string {
  if (e.kind === "commit") {
    return `commit #${e.id} ${e.side} ${e.token} -> ${e.allowed ? "ALLOWED" : `DENIED (${e.reason})`} amountIn=${e.amountIn} minOut=${e.minOut}`;
  }
  if (e.kind === "settle") {
    return `settle #${e.id} swap=${e.swapTxHash} amountOut=${e.amountOut} mode=${e.executionMode}${e.belowMin ? " BELOW MINIMUM" : ""}`;
  }
  return `cancel #${e.id}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const rpcUrls = [process.env.BSC_RPC_URL, ...DEFAULT_BSC_RPCS].filter((u): u is string => Boolean(u));
    const covenantAddress = process.env.COVENANT_ADDRESS;
    if (!covenantAddress) {
      console.error("Set COVENANT_ADDRESS to the deployed Covenant contract to judge.");
      process.exitCode = 1;
      return;
    }

    console.log(`Covenant judge report`);
    console.log(`  contract: ${covenantAddress}`);
    console.log(`  rpc candidates: ${rpcUrls.join(", ")}\n`);

    const txHashes = await readTxHashList();
    if (txHashes.length === 0) console.log("No transactions listed in data/judge-tx-hashes.json or JUDGE_TX_HASHES - showing mandate state only.\n");

    const { mandate, results, allVerified } = await runJudge(rpcUrls, covenantAddress, txHashes);
    console.log("Mandate (read live from chain):");
    console.log(`  active:                 ${mandate.active}`);
    console.log(`  maxNotionalPerTradeUsd: ${mandate.maxNotionalPerTradeUsd}`);
    console.log(`  maxTradesPerDay:        ${mandate.maxTradesPerDay}`);
    console.log(`  expiry:                 ${mandate.expiry}\n`);

    for (const r of results) {
      console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.txHash}`);
      if (r.ok) for (const e of r.events!) console.log(`    block=${r.blockNumber} ${describeEvent(e)}`);
      else console.log(`    ${r.detail}`);
    }
    if (results.length > 0) console.log(`\n${results.filter((r) => r.ok).length}/${results.length} transactions independently verified.`);

    process.exitCode = allVerified || txHashes.length === 0 ? 0 : 1;
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
