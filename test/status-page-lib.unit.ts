import { expect } from "chai";
import { describeDecision, resolveFromBlock, guardedVsUnguarded } from "../status-page/lib.mjs";

// Pure-function coverage for status-page/lib.mjs, no network, no fork: the
// live suite (test/status-page.live.ts) already exercises these against
// real on-chain decisions, but only ever with buy-side commits. These two
// bugs (sell wording, and resolveFromBlock silently accepting garbage) were
// both on the sell/invalid-input paths the live suite never actually hits.
const fmt = (wei: bigint) => (Number(wei) / 1e18).toString();
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    commit: {
      token: NVDAB,
      side: "buy",
      allowed: true,
      reason: "None",
      amountIn: 5_000_000_000_000_000_000n,
      quotedOut: 0n,
      minOut: 0n,
      ...overrides,
    },
    settle: null,
    cancelled: false,
  };
}

describe("status-page/lib.mjs describeDecision - sell wording", function () {
  it("a buy spends USDT for the token", function () {
    expect(describeDecision(decision({ side: "buy" }), fmt)).to.match(/^Buy order: spend 5 USDT for .+NVDAB.*$/);
  });

  it("a sell spends the token for USDT, not the token for itself", function () {
    const text = describeDecision(decision({ side: "sell" }), fmt);
    expect(text).to.match(/^Sell order: spend 5 .*NVDAB.* for USDT/);
    // The bug this guards against: the old code reused the buy's spendLabel
    // as the receive label too, so a sell read "spend 5 NVDAB for NVDAB".
    expect(text).to.not.match(/for .*NVDAB.*NVDAB/);
  });

  it("a settled sell reports the USDT actually received, not the token again", function () {
    const d = decision({ side: "sell" });
    d.settle = { amountOut: 3_000_000_000_000_000_000n, executionMode: "pool", belowMin: false, txHash: "0xabc", swapTxHash: "0xabc" };
    const text = describeDecision(d, fmt);
    expect(text).to.match(/received 3 USDT via pool/);
  });
});

describe("status-page/lib.mjs guardedVsUnguarded - sell wording", function () {
  it("names the token as what an unguarded wallet would have sold, for a denied sell", function () {
    const d = decision({ side: "sell", allowed: false, reason: "TokenNotAllowed" });
    const text = guardedVsUnguarded(d, fmt);
    expect(text).to.match(/spent 5 .*NVDAB.* on this trade/);
  });
});

describe("status-page/lib.mjs resolveFromBlock - input validation", function () {
  it("defaults to a lookback window when nothing explicit is given", function () {
    expect(resolveFromBlock(undefined, 10_000)).to.be.a("number");
    expect(resolveFromBlock("", 10_000)).to.be.a("number");
    expect(resolveFromBlock(null, 10_000)).to.be.a("number");
  });

  it("uses an explicit, valid block number", function () {
    expect(resolveFromBlock("12345", 999_999)).to.equal(12345);
    expect(resolveFromBlock(12345, 999_999)).to.equal(12345);
  });

  it("refuses NaN input instead of silently scanning from block NaN", function () {
    expect(() => resolveFromBlock("not-a-number", 10_000)).to.throw(/not a valid block number/);
  });

  it("refuses a negative block number", function () {
    expect(() => resolveFromBlock("-5", 10_000)).to.throw(/not a valid block number/);
  });

  it("refuses a non-integer block number", function () {
    expect(() => resolveFromBlock("12.5", 10_000)).to.throw(/not a valid block number/);
  });
});
