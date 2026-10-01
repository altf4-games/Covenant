import { ethers } from "ethers";
// status-page/lib.mjs is a plain .mjs file, one directory outside `src`
// (deliberately: it's the same tested module test/status-page.live.ts
// covers in the main project's Node/Mocha suite, not a copy). TS's
// bundler-mode resolution won't type-check a relative ambient module
// declaration against it reliably, so this one import is suppressed and
// re-typed by hand just below - everything downstream of this file is
// fully typed.
// @ts-expect-error - see the comment above; types are supplied by hand just below
import { ABI, DENIAL_REASONS, fetchDecisionEvents, joinDecisions, resolveFromBlock, describeDecision, guardedVsUnguarded, bossFor, tokenName } from "../../../status-page/lib.mjs";
import type { Decision, Boss } from "./status-page-lib-types.ts";
import { computeTrackRecord, type TrackRecord } from "./rarity";

export type { Decision, Boss };
export { bossFor, tokenName, describeDecision, guardedVsUnguarded, DENIAL_REASONS };

export interface Mandate {
  active: boolean;
  maxNotionalPerTradeUsd: bigint;
  maxTradesPerDay: bigint;
  expiry: bigint;
}

export interface CovenantSnapshot {
  /** The contract this snapshot was read from (the input box can change afterward). */
  contractAddress: string;
  /** Where the numbers came from. The page shows only what this RPC said, so it says which one. */
  rpcHost: string;
  chainId: number;
  mandate: Mandate;
  tradesUsedToday: bigint;
  stalenessBound: bigint;
  decisionTtl: bigint;
  agent: string;
  maxDailyNotionalUsd: bigint;
  notionalUsedToday: bigint;
  /** The newest `maxDecisions` decisions, newest first - what the list and the replay show. */
  decisions: Decision[];
  /** Computed over every decision in the scanned range, not just the ones shown, so the card doesn't change tier when old decisions scroll off the list. */
  trackRecord: TrackRecord;
  /** How many decisions the scanned range held in total. */
  totalDecisions: number;
  latestBlock: number;
  /** "static" when read from the committed covenant-snapshot.json, "live" when read from an RPC just now. */
  source?: "live" | "static";
  /** When a static snapshot was taken from chain (ISO time). */
  generatedAt?: string;
}

/** The host of an RPC URL, without credentials or a path (an API key often sits in the path). */
export function rpcHostOf(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return "unknown RPC";
  }
}

/** BSC mainnet's chain id; a fork of it reports the same one. */
export const BSC_CHAIN_ID = 56;

/** wei -> a plain decimal string, 18 decimals - every token here uses 18 (verified-facts.md). */
export function fmtAmount(wei: bigint): string {
  return ethers.formatUnits(wei, 18);
}

/**
 * One real read of everything the app shows: the mandate, today's usage,
 * and every decision event since `fromBlock`. No mocked data path exists -
 * a bad RPC/contract address surfaces as a real thrown error, the same as
 * status-page/index.html.
 */
export async function fetchSnapshot(
  rpcUrl: string,
  contractAddress: string,
  fromBlockInput: string,
  maxDecisions = 50,
): Promise<CovenantSnapshot> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const covenant = new ethers.Contract(contractAddress, ABI, provider);

  const [mandateRaw, tradesUsedToday, stalenessBound, decisionTtl, agent, maxDailyNotionalUsd, notionalUsedToday, latestBlock] =
    await Promise.all([
      covenant.mandate(),
      covenant.tradesUsedToday(),
      covenant.stalenessBound(),
      covenant.decisionTtl(),
      covenant.agent(),
      covenant.maxDailyNotionalUsd(),
      covenant.notionalUsedToday(),
      provider.getBlockNumber(),
    ]);
  const chainId = Number((await provider.getNetwork()).chainId);

  const fromBlock = resolveFromBlock(fromBlockInput || undefined, latestBlock);
  const events = await fetchDecisionEvents(covenant, { fromBlock });
  const all = joinDecisions(events).reverse();
  const decisions = all.slice(0, maxDecisions);

  return {
    contractAddress,
    rpcHost: rpcHostOf(rpcUrl),
    chainId,
    mandate: {
      active: mandateRaw.active,
      maxNotionalPerTradeUsd: mandateRaw.maxNotionalPerTradeUsd,
      maxTradesPerDay: mandateRaw.maxTradesPerDay,
      expiry: mandateRaw.expiry,
    },
    tradesUsedToday,
    stalenessBound,
    decisionTtl,
    agent,
    maxDailyNotionalUsd,
    notionalUsedToday,
    decisions,
    trackRecord: computeTrackRecord(all),
    totalDecisions: all.length,
    latestBlock,
  };
}

// ---- Static snapshot ------------------------------------------------------
// Free BSC RPCs only serve logs a few days back, so a hosted page that scans
// live would show an empty ledger by judging time. `covenant-snapshot.json`
// holds one real read of everything the page shows, taken from chain with
// scripts/generate-frontend-snapshot.ts. It is chain data, not a mock, and the
// page says so and offers a live re-read.

/** JSON can't carry a bigint, so each one is written as {"$bigint": "123"}. */
export function serializeSnapshot(snapshot: CovenantSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) => (typeof value === "bigint" ? { $bigint: value.toString() } : value), 2);
}

export function reviveSnapshot(text: string): CovenantSnapshot {
  return JSON.parse(text, (_key, value) =>
    value !== null && typeof value === "object" && "$bigint" in value && typeof value.$bigint === "string" ? BigInt(value.$bigint) : value,
  ) as CovenantSnapshot;
}

/** The committed snapshot, or null when there isn't one (a fork-only checkout, say). */
export async function loadStaticSnapshot(url = "./covenant-snapshot.json"): Promise<CovenantSnapshot | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const snap = reviveSnapshot(await res.text());
    return { ...snap, source: "static" };
  } catch {
    return null;
  }
}
