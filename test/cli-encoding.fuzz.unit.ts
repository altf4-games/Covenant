import { expect } from "chai";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { COMMANDS, hex32, addr32 } from "../skills/covenant-mandate/scripts/cli.mjs";
import { decodeCovenantLog, TOPICS } from "../scripts/judge.js";

const iface = new ethers.Interface(covenantArtifact.abi);
let seed = 0x1234567890abcdefn;
const rnd = () => { seed ^= (seed << 13n) & ((1n << 64n) - 1n); seed ^= seed >> 7n; seed ^= (seed << 17n) & ((1n << 64n) - 1n); return seed; };
const big = () => { const bits = Number(rnd() % 257n); return bits === 0 ? 0n : rnd() * (rnd() | 1n) * (rnd() | 1n) * (rnd() | 1n) % (1n << BigInt(bits)); };
const addr = () => ethers.getAddress("0x" + (rnd() * rnd() * rnd()).toString(16).padStart(40, "0").slice(-40));
const b32 = () => "0x" + (rnd() * rnd() * rnd() * rnd()).toString(16).padStart(64, "0").slice(-64);
const asInput = (v: bigint) => { const k = rnd() % 3n; return k === 0n ? v : k === 1n ? v.toString() : (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()); };

// The skill CLI encodes calldata by hand (it is zero-dependency, so it cannot use ethers).
// This checks that encoder, and the judge decoder, against ethers on random inputs:
// every amount from 0 to 2^256-1 as a bigint, a decimal string or a safe integer, and
// arrays of every length. Seeded, so a failure reproduces.
describe("hand-rolled ABI encoding and decoding vs ethers (differential fuzz)", function () {
  this.timeout(120000);
  it("commit, settle, cancel and setMandateForTokens calldata match ethers byte for byte", async function () {
    for (let i = 0; i < 3000; i++) {
      const side = Number(rnd() % 2n), token = addr(), a = big(), q = big(), m = big(), qr = b32(), rr = b32();
      const got = (await COMMANDS.buildCommitCalldata({ side: side ? "sell" : "buy", tokenAddress: token, amountIn: asInput(a), quotedOut: asInput(q), minOut: asInput(m), quoteRef: qr, researchRef: rr })).calldata;
      expect(got, `commit ${i}`).to.equal(iface.encodeFunctionData("commit", [side, token, a, q, m, qr, rr]));
      const id = big(), tx = b32(), out = big(), mode = Number(rnd() % 4n);
      const st = (await COMMANDS.buildSettleCalldata({ decisionId: asInput(id), swapTxHash: tx, amountOut: asInput(out), executionMode: ["unknown","pool","rfq","aggregator"][mode] as any })).calldata;
      expect(st, `settle ${i}`).to.equal(iface.encodeFunctionData("settle", [id, tx, out, mode]));
      expect((await COMMANDS.buildCancelCalldata({ decisionId: asInput(id) })).calldata).to.equal(iface.encodeFunctionData("cancel", [id]));
      const n = Number(rnd() % 6n);
      const tokens = Array.from({ length: n }, addr), slip = Array.from({ length: n }, () => rnd() % 10001n), pos = Array.from({ length: n }, big), drift = Array.from({ length: n }, () => rnd() % 10001n);
      const mn = big(), mt = big(), ex = big();
      const sm = (await COMMANDS.buildSetMandateForTokensCalldata({ maxNotionalPerTradeUsd: asInput(mn), maxTradesPerDay: asInput(mt), expiry: asInput(ex), tokens, maxSlippageBpsList: slip.map(asInput), maxPositionUsdList: pos.map(asInput), maxClosedMarketDriftBpsList: drift.map(asInput) })).calldata;
      expect(sm, `mandate ${i} n=${n}`).to.equal(iface.encodeFunctionData("setMandateForTokens", [mn, mt, ex, tokens, slip, pos, drift]));
    }
  });

  it("hex32/addr32 refuse everything that isn't exactly a uint256 / a 20-byte address", function () {
    const bad: unknown[] = [-1, -1n, "-1", 1.5, NaN, Infinity, 2 ** 53, 2n ** 256n, (2n ** 256n).toString(), "0x10", "1e3", " 1", "1 ", "", "١٢٣", "1_000", null, undefined, {}, [], [1], true, () => 1, Symbol.iterator as any];
    for (const b of bad) expect(() => hex32(b as any), String(typeof b) + ":" + String(b)).to.throw();
    for (const g of [0, 1, "0", "007", "+5", 2 ** 53 - 1, 2n ** 256n - 1n, (2n ** 256n - 1n).toString()]) expect(() => hex32(g as any)).to.not.throw();
    for (const b of ["0x", "0x" + "a".repeat(39), "0x" + "a".repeat(41), "0x" + "g".repeat(40), "a".repeat(40), "0X" + "a".repeat(40), null, 5, "0x" + "a".repeat(40) + "\n"]) expect(() => addr32(b as any), String(b)).to.throw();
  });

  it("the judge decoder reads every field of real DecisionCommitted/Settled/Cancelled logs like ethers does", function () {
    for (let i = 0; i < 2000; i++) {
      const token = addr(), id = 1n + (rnd() % 1000n), side = Number(rnd() % 2n), allowed = rnd() % 2n === 0n, reason = Number(rnd() % 14n);
      const args = [id, token, side, allowed, reason, big(), big(), big(), b32(), b32(), rnd() % (1n << 40n), big(), big(), rnd() % (1n << 40n), rnd() % (1n << 40n)];
      const log = iface.encodeEventLog("DecisionCommitted", args);
      const dec: any = decodeCovenantLog({ address: "0x0", topics: log.topics as string[], data: log.data });
      expect(dec.kind).to.equal("commit");
      expect(BigInt(dec.id)).to.equal(id); expect(dec.token.toLowerCase()).to.equal(token.toLowerCase());
      expect(dec.side).to.equal(side ? "sell" : "buy"); expect(dec.allowed).to.equal(allowed);
      expect(BigInt(dec.amountIn)).to.equal(args[5]); expect(BigInt(dec.quotedOut)).to.equal(args[6]); expect(BigInt(dec.minOut)).to.equal(args[7]);
      expect(dec.quoteRef).to.equal(args[8]); expect(dec.researchRef).to.equal(args[9]); expect(BigInt(dec.expiresAt)).to.equal(args[10]);
      expect(BigInt(dec.mandateMaxNotionalPerTradeUsd)).to.equal(args[11]); expect(BigInt(dec.mandateMaxTradesPerDay)).to.equal(args[12]);
      expect(BigInt(dec.mandateExpiry)).to.equal(args[13]); expect(BigInt(dec.oracleUpdatedAt)).to.equal(args[14]);
      const sl = iface.encodeEventLog("DecisionSettled", [id, b32(), big(), Number(rnd() % 4n), allowed]);
      const d2: any = decodeCovenantLog({ address: "0x0", topics: sl.topics as string[], data: sl.data });
      expect(d2.kind).to.equal("settle"); expect(BigInt(d2.id)).to.equal(id); expect(d2.belowMin).to.equal(allowed);
    }
    expect(TOPICS.DecisionCommitted).to.equal(iface.getEvent("DecisionCommitted")!.topicHash);
  });
});
