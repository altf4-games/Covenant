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
}

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

  const fromBlock = resolveFromBlock(fromBlockInput || undefined, latestBlock);
  const events = await fetchDecisionEvents(covenant, { fromBlock });
  const all = joinDecisions(events).reverse();
  const decisions = all.slice(0, maxDecisions);

  return {
    contractAddress,
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
