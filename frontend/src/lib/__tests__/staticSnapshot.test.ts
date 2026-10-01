import { describe, expect, it, vi } from "vitest";
import { loadStaticSnapshot, reviveSnapshot, serializeSnapshot, type CovenantSnapshot } from "../covenant";

const snap: CovenantSnapshot = {
  contractAddress: "0x90F642be72b5aD815B924AB3CFFd5f241Dc656aa",
  rpcHost: "rpc-bsc.48.club",
  chainId: 56,
  mandate: { active: true, maxNotionalPerTradeUsd: 250000000000000000n, maxTradesPerDay: 5n, expiry: 1793372197n },
  tradesUsedToday: 0n,
  stalenessBound: 900n,
  decisionTtl: 600n,
  agent: "0xaa963e1b4f913975ee81139f4ba2953951e45844",
  maxDailyNotionalUsd: 750000000000000000n,
  notionalUsedToday: 0n,
  decisions: [
    {
      id: "2",
      cancelled: false,
      commit: {
        token: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
        side: "buy",
        allowed: true,
        reason: "None",
        amountIn: 200000000000000000n,
        quotedOut: 867232392938195n,
        minOut: 862896230973504n,
        expiresAt: 1,
        mandateMaxNotionalPerTradeUsd: 250000000000000000n,
        mandateMaxTradesPerDay: 5n,
        mandateExpiry: 1793372197,
        oracleUpdatedAt: 1,
        blockNumber: 124929963,
        txHash: "0x837d",
      },
      settle: null,
    },
  ],
  trackRecord: { total: 1, denied: 0, settled: 0, longestDenialStreak: 0, sawFlagshipDenial: false },
  totalDecisions: 1,
  latestBlock: 125059687,
};

describe("static snapshot", () => {
  it("round-trips every bigint exactly, including values past 2^53", () => {
    const back = reviveSnapshot(serializeSnapshot(snap));
    expect(back).toEqual(snap);
    expect(typeof back.decisions[0].commit!.amountIn).toBe("bigint");
    expect(back.decisions[0].commit!.quotedOut).toBe(867232392938195n);
  });

  it("leaves ordinary numbers and strings alone", () => {
    const back = reviveSnapshot(serializeSnapshot(snap));
    expect(back.chainId).toBe(56);
    expect(typeof back.decisions[0].commit!.blockNumber).toBe("number");
    expect(back.contractAddress).toBe(snap.contractAddress);
  });

  it("marks a loaded snapshot as static", async () => {
    vi.stubGlobal("fetch", async () => new Response(serializeSnapshot(snap)));
    const loaded = await loadStaticSnapshot("x");
    expect(loaded?.source).toBe("static");
    expect(loaded?.mandate.maxTradesPerDay).toBe(5n);
    vi.unstubAllGlobals();
  });

  it("returns null when there is no snapshot or it isn't JSON, so the page falls back to the empty start screen", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    expect(await loadStaticSnapshot("x")).toBeNull();
    vi.stubGlobal("fetch", async () => new Response("<html>"));
    expect(await loadStaticSnapshot("x")).toBeNull();
    vi.unstubAllGlobals();
  });
});
