import { describe, expect, it } from "vitest";
import { computeTrackRecord, classifyRarity } from "../rarity";
import type { Decision } from "../covenant";

function commit(overrides: Partial<NonNullable<Decision["commit"]>>): Decision["commit"] {
  return {
    token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
    side: "buy",
    allowed: true,
    reason: "None",
    amountIn: 1n,
    quotedOut: 1n,
    minOut: 1n,
    expiresAt: 0,
    mandateMaxNotionalPerTradeUsd: 1n,
    mandateMaxTradesPerDay: 1n,
    mandateExpiry: 0,
    oracleUpdatedAt: 0,
    blockNumber: 1,
    txHash: "0xabc",
    ...overrides,
  };
}

function decision(id: string, overrides: Partial<NonNullable<Decision["commit"]>>, settled = false): Decision {
  return {
    id,
    commit: commit(overrides),
    settle: settled ? { swapTxHash: "0xdef", amountOut: 1n, executionMode: "aggregator", belowMin: false, txHash: "0xdef" } : null,
    cancelled: false,
  };
}

describe("computeTrackRecord", () => {
  it("counts denials, settles, and the longest denial streak in chronological order", () => {
    // App.tsx hands decisions newest-first; compute must reverse internally.
    const newestFirst: Decision[] = [
      decision("4", { allowed: true }, true), // most recent: a settle, streak breaks
      decision("3", { allowed: false, reason: "NotionalExceeded" }),
      decision("2", { allowed: false, reason: "TokenNotAllowed" }),
      decision("1", { allowed: true }, true), // oldest: a settle
    ];
    const record = computeTrackRecord(newestFirst);
    expect(record.total).toBe(4);
    expect(record.denied).toBe(2);
    expect(record.settled).toBe(2);
    expect(record.longestDenialStreak).toBe(2); // decisions #2 and #3 back to back
    expect(record.sawFlagshipDenial).toBe(false);
  });

  it("flags a real ClosedMarketDrift denial as the flagship catch", () => {
    const record = computeTrackRecord([decision("1", { allowed: false, reason: "ClosedMarketDrift" })]);
    expect(record.sawFlagshipDenial).toBe(true);
  });

  it("ignores a decision whose commit fell outside the scanned block range", () => {
    const settleOnly: Decision = { id: "9", commit: null, settle: { swapTxHash: "0x1", amountOut: 1n, executionMode: "pool", belowMin: false, txHash: "0x1" }, cancelled: false };
    const record = computeTrackRecord([settleOnly]);
    expect(record.total).toBe(0);
  });
});

describe("classifyRarity", () => {
  it("is Legendary whenever the flagship ClosedMarketDrift denial was caught, regardless of other stats", () => {
    expect(classifyRarity({ total: 1, denied: 1, settled: 0, longestDenialStreak: 1, sawFlagshipDenial: true })).toBe("Legendary");
  });

  it("is Gold with at least one denial and one settle, short of the flagship", () => {
    expect(classifyRarity({ total: 2, denied: 1, settled: 1, longestDenialStreak: 1, sawFlagshipDenial: false })).toBe("Gold");
  });

  it("is Silver with real activity but no denial-plus-settle combination yet", () => {
    expect(classifyRarity({ total: 3, denied: 0, settled: 3, longestDenialStreak: 0, sawFlagshipDenial: false })).toBe("Silver");
  });

  it("is Bronze for a fresh identity with little or no real activity", () => {
    expect(classifyRarity({ total: 0, denied: 0, settled: 0, longestDenialStreak: 0, sawFlagshipDenial: false })).toBe("Bronze");
  });
});
