import { expect } from "chai";
import { describeDecision, resolveFromBlock, guardedVsUnguarded, DEFAULT_LOOKBACK_BLOCKS, groupDecimal } from "../status-page/lib.mjs";

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
    expect(() => resolveFromBlock("not-a-number", 10_000)).to.throw(/not a plain decimal integer string/);
  });

  it("refuses a negative block number", function () {
    expect(() => resolveFromBlock("-5", 10_000)).to.throw(/not a valid block number/);
  });

  it("refuses a non-integer block number", function () {
    expect(() => resolveFromBlock("12.5", 10_000)).to.throw(/not a plain decimal integer string/);
  });

  it("refuses a hex/binary/octal-prefixed string instead of silently reinterpreting it in the wrong base", function () {
    // Red-team follow-up: Number(string) natively parses 0x/0b/0o-prefixed
    // strings as hex/binary/octal, not decimal - Number("0x10") is silently
    // 16, not a refusal. Confirmed live before this check existed.
    expect(() => resolveFromBlock("0x10", 10_000)).to.throw(/not a plain decimal integer string/);
    expect(() => resolveFromBlock("0b101", 10_000)).to.throw(/not a plain decimal integer string/);
    expect(() => resolveFromBlock("0o17", 10_000)).to.throw(/not a plain decimal integer string/);
  });

  it("refuses a block number past Number.MAX_SAFE_INTEGER instead of silently rounding it", function () {
    // Red-team follow-up: Number.isInteger("9007199254740993") returns true
    // even though that string's value already lost precision converting to
    // a Number - the same class of bug hex32/addr32 were hardened against,
    // just left unfixed here originally.
    expect(() => resolveFromBlock("9007199254740993", 10_000)).to.throw(/not a valid block number/);
  });

  it("refuses booleans and arrays instead of silently coercing them into a made-up block number", function () {
    // Same class of gap as hex32's: Number() coerces far more than "string
    // or number" (Number([])===0, Number(true)===1, Number([100])===100).
    expect(() => resolveFromBlock(true, 10_000)).to.throw(/not a number or a decimal string/);
    expect(() => resolveFromBlock([], 10_000)).to.throw(/not a number or a decimal string/);
    expect(() => resolveFromBlock([100], 10_000)).to.throw(/not a number or a decimal string/);
  });
});

describe("status-page/lib.mjs default window", function () {
  it("reaches back further than a few minutes of BSC blocks, and never below block 0", function () {
    expect(DEFAULT_LOOKBACK_BLOCKS).to.be.greaterThan(10_000);
    expect(resolveFromBlock(undefined, 1_000_000)).to.equal(1_000_000 - DEFAULT_LOOKBACK_BLOCKS);
    expect(resolveFromBlock(undefined, 10)).to.equal(0);
  });
});

describe("status-page/lib.mjs groupDecimal", function () {
  it("groups the whole part and keeps up to six decimals", function () {
    expect(groupDecimal("1234567.1234567891")).to.equal("1,234,567.123456");
    expect(groupDecimal("0.5")).to.equal("0.5");
    expect(groupDecimal("2.000000")).to.equal("2");
    expect(groupDecimal("0.0000001")).to.equal("0");
  });
  it("doesn't lose digits on a value past 2^53, where Number() would", function () {
    const big = "340282366920938463463374607431768211455.0";
    expect(groupDecimal(big)).to.equal("340,282,366,920,938,463,463,374,607,431,768,211,455");
    expect(Number(big).toLocaleString("en-US")).to.not.equal(groupDecimal(big));
  });
});
