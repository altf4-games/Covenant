import { expect } from "chai";
import { buildPrompt } from "../scripts/generate-narration.js";

// Pure-logic test - no real Gemini call (that needs a real API key, see
// GAMIFICATION-PLAN-2026-09-25.md item 4's day-of check). What's testable
// without one: that every prompt this script would actually send stays
// grounded in the decision's own real fields and never fabricates a reason,
// amount, or outcome for the model to embellish.
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

function commit(overrides: Partial<any>): any {
  return {
    token: NVDAB,
    side: "buy",
    allowed: true,
    reason: "None",
    amountIn: 1_000_000_000_000_000_000n,
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

describe("generate-narration.ts's buildPrompt (pure, no live Gemini call)", () => {
  it("returns null for a decision whose commit fell outside the scanned range - nothing to narrate honestly", () => {
    expect(buildPrompt({ id: "9", commit: null, settle: null, cancelled: false })).to.equal(null);
  });

  it("grounds a denial's prompt in the real reason and the real boss name, and asks the model to treat the denial as the good outcome", () => {
    const prompt = buildPrompt({ id: "1", commit: commit({ allowed: false, reason: "NotionalExceeded" }), settle: null, cancelled: false });
    expect(prompt).to.include("DENIED");
    expect(prompt).to.include("NotionalExceeded");
    expect(prompt).to.include("The Spending Cap"); // bossFor's real name for this reason
    expect(prompt).to.include("$1.0"); // the real amountIn, formatted
    expect(prompt).to.include("NVIDIA (NVDAB)"); // the real pinned token name
    expect(prompt).to.match(/good outcome/);
  });

  it("grounds a settled fill's prompt in the real execution mode and flags a real below-minimum fill honestly", () => {
    const belowMin = buildPrompt({
      id: "2",
      commit: commit({ allowed: true }),
      settle: { swapTxHash: "0xdef", amountOut: 1n, executionMode: "aggregator", belowMin: true, txHash: "0xdef" },
      cancelled: false,
    });
    expect(belowMin).to.include("aggregator");
    expect(belowMin).to.match(/below the minimum accepted/);

    const clean = buildPrompt({
      id: "3",
      commit: commit({ allowed: true }),
      settle: { swapTxHash: "0xdef", amountOut: 1n, executionMode: "pool", belowMin: false, txHash: "0xdef" },
      cancelled: false,
    });
    expect(clean).to.not.match(/below the minimum accepted/);
  });

  it("prompts for an allowed decision still awaiting settlement, without claiming a fill that hasn't happened", () => {
    const prompt = buildPrompt({ id: "4", commit: commit({ allowed: true }), settle: null, cancelled: false });
    expect(prompt).to.match(/waiting to settle/);
    expect(prompt).to.not.include("filled");
  });
});
