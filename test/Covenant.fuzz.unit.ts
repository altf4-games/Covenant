import { expect } from "chai";
import { network } from "hardhat";
const { ethers, networkHelpers } = await network.getOrCreate();
const E18 = 10n ** 18n;
const MAX = (1n << 128n) - 1n;

// xorshift so failures reproduce
let seed = 0x9e3779b97f4a7c15n;
const rnd = () => { seed ^= (seed << 13n) & ((1n << 64n) - 1n); seed ^= seed >> 7n; seed ^= (seed << 17n) & ((1n << 64n) - 1n); return seed; };
const pick = <T,>(xs: T[]) => xs[Number(rnd() % BigInt(xs.length))];
// magnitudes: tiny, typical, huge, boundary
const amt = () => pick([0n, 1n, rnd() % 1000n, rnd() % (10n * E18), (rnd() % 1000n) * E18, MAX, MAX - 1n, MAX + 1n, rnd() % MAX, (1n << 100n) + (rnd() % 1000n)]);
const price = () => pick([1n, rnd() % E18 + 1n, (rnd() % 1000n + 1n) * E18, MAX, MAX - 1n, rnd() % MAX + 1n, 200n * E18]);

interface Params {
  side: number; amountIn: bigint; quotedOut: bigint; minOut: bigint; price: bigint; lastClose: bigint;
  sessionOpen: boolean; halted: boolean; slip: number; drift: number; maxNotional: bigint; maxTrades: bigint;
  maxPos: bigint; maxDaily: bigint; held: bigint; active: boolean; allowed: boolean; expiry: bigint; now: bigint;
  open: boolean; stale: bigint; updatedAt: bigint; used: bigint; usedNotional: bigint;
}

function model(p: Params): number {
  // returns DenialReason index, mirroring the documented order of checks
  if (p.amountIn === 0n || p.amountIn > MAX || p.quotedOut > MAX || p.minOut > MAX) return 13;
  if (!p.active) return 1;
  if (p.now > p.expiry) return 2;
  if (!p.allowed) return 3;
  if (p.open) return 10;
  if (p.updatedAt === 0n || p.now - p.updatedAt > p.stale) return 6;
  if (p.halted) return 7;
  const notional = p.side === 0 ? p.amountIn : (p.amountIn * p.price) / E18;
  if (notional > p.maxNotional) return 4;
  if (p.used >= p.maxTrades) return 5;
  if (p.maxDaily > 0n && p.usedNotional + notional > p.maxDaily) return 12;
  const oracleOut = p.side === 0 ? (p.amountIn * E18) / p.price : (p.amountIn * p.price) / E18;
  const floor = 10000n - BigInt(p.slip);
  if (p.quotedOut === 0n || p.minOut * 10000n < p.quotedOut * floor || p.minOut * 10000n < oracleOut * floor) return 8;
  if (p.quotedOut * 10000n > oracleOut * (10000n + BigInt(p.slip))) return 8;
  if (!p.sessionOpen && p.drift > 0) {
    if (p.side === 0) {
      if (p.minOut === 0n) return 11;
      const worst = (p.amountIn * E18) / p.minOut;
      if (worst * 10000n > p.lastClose * (10000n + BigInt(p.drift))) return 11;
    } else if (p.amountIn > 0n) {
      const worst = (p.minOut * E18) / p.amountIn;
      if (worst * 10000n < p.lastClose * (10000n - BigInt(p.drift))) return 11;
    }
  }
  if (p.side === 0) {
    const received = p.quotedOut > oracleOut ? p.quotedOut : oracleOut;
    if (((p.held + received) * p.price) / E18 > p.maxPos) return 9;
  }
  return 0;
}

// A differential fuzz of previewDecision (the same _evaluate commit runs) against
// an independent model of the rules written out in BigInt. It hunts for the two
// things example tests miss: an input inside the documented range that makes the
// contract revert (a panic from overflow or a division by zero) instead of
// deny, and any disagreement in the order or arithmetic of the checks.
// Seeded, so a failure reproduces. 12,000 cases at development time found none;
// a smaller run stays in the suite.
describe("Covenant v2 previewDecision vs an independent model (differential fuzz)", function () {
  this.timeout(600_000);
  it("never reverts on in-range inputs, and returns the model's reason every time", async function () {
    const [owner, updater, agent] = await ethers.getSigners();
    const quote = await ethers.deployContract("MockERC20", ["q", "q"]);
    const stock = await ethers.deployContract("MockERC20", ["s", "s"]);
    const cov = await ethers.deployContract("Covenant", [await quote.getAddress(), updater.address, agent.address, 900, 600]);
    const token = await stock.getAddress();
    let mismatches = 0, reverts = 0, byReason: Record<number, number> = {};
    for (let i = 0; i < 3000; i++) {
      const now = BigInt(await networkHelpers.time.latest());
      const active = rnd() % 10n !== 0n;
      const expiry = now + 1000n; // always future so mandate set works
      const allowed = rnd() % 10n !== 0n;
      const slip = Number(pick([0n, 1n, 50n, 100n, 500n, 10000n]));
      const drift = Number(pick([0n, 0n, 10n, 100n, 5000n, 10000n]));
      const maxNotional = pick([0n, E18, 10n * E18, 1000n * E18, MAX]);
      const maxTrades = pick([0n, 1n, 5n, 1000n]);
      const maxPos = pick([0n, 5n * E18, 1000n * E18, MAX]);
      const maxDaily = pick([0n, 0n, 20n * E18, MAX]);
      const p = price(), lc = price();
      const sessionOpen = rnd() % 2n === 0n, halted = rnd() % 8n === 0n;
      const held = pick([0n, E18, MAX]);
      const side = Number(rnd() % 2n);
      const amountIn = amt(), quotedOut = amt(), minOut = pick([amt(), (quotedOut * 995n) / 1000n, quotedOut, 0n]);

      const sane = rnd() % 10n < 7n;
      let [A, Q, MO, P, LC, MN, MT, MP, MD, HELD, ACT, ALW, HAL] = [amountIn, quotedOut, minOut, p, lc, maxNotional, maxTrades, maxPos, maxDaily, held, active, allowed, halted] as [
        bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean,
      ];
      if (sane) {
        P = (100n + (rnd() % 400n)) * E18; ACT = true; ALW = true; HAL = false; MN = 1000n * E18; MT = 1000n; MD = pick([0n, 0n, 30n * E18]);
        MP = pick([2n * E18, 20n * E18, 1000n * E18]); HELD = pick([0n, E18 / 100n, E18]);
        A = side === 0 ? (1n + (rnd() % 30n)) * E18 / 4n : (1n + (rnd() % 30n)) * E18 / 100n;
        const oracleOut = side === 0 ? (A * E18) / P : (A * P) / E18;
        const noise = BigInt(9700n + (rnd() % 700n)); // 97%..104% of oracle
        Q = (oracleOut * noise) / 10000n;
        const mnoise = BigInt(9700n + (rnd() % 400n)); // 97%..101% of quote
        MO = (Q * mnoise) / 10000n;
        LC = (P * BigInt(9500n + (rnd() % 1000n))) / 10000n; // last close 95%..105% of price
      }
      await cov.setMandate(MN, MT, expiry);
      if (!ACT) await cov.revokeMandate();
      await cov.configureToken(token, ALW, slip, MP);
      await cov.setClosedMarketDrift(token, drift);
      await cov.setMaxDailyNotionalUsd(MD);
      await cov.connect(updater).updateOracle(token, HAL, P, sessionOpen, LC);
      // set held balance exactly
      const cur = await stock.balanceOf(agent.address);
      if (cur < HELD) await stock.mint(agent.address, HELD - cur);
      else if (cur > HELD) await stock.connect(agent).transfer(owner.address, cur - HELD);

      let actual: number | null = null;
      try { actual = Number(await cov.previewDecision(side, token, A, Q, MO)); } catch { reverts++; }
      const expected = model({ side, amountIn: A, quotedOut: Q, minOut: MO, price: P, lastClose: LC, sessionOpen, halted: HAL, slip, drift, maxNotional: MN, maxTrades: MT, maxPos: MP, maxDaily: MD, held: HELD, active: ACT, allowed: ALW, expiry, now: BigInt(await networkHelpers.time.latest()), open: false, stale: 900n, updatedAt: (await cov.oracleStatus(token)).updatedAt, used: 0n, usedNotional: 0n });
      byReason[expected] = (byReason[expected] ?? 0) + 1;
      if (actual === null || actual !== expected) {
        mismatches++;
        if (mismatches <= 8) console.log("MISMATCH", { i, actual, expected, side, A, Q, MO, P, LC, sessionOpen, slip, drift, HELD, MP, MN });
      }
    }
    console.log("reasons covered:", byReason, "reverts:", reverts, "mismatches:", mismatches);
    expect(mismatches).to.equal(0);
    expect(reverts).to.equal(0);
    // the generator must actually reach the late checks, or a clean run means little
    for (const reason of [0, 4, 8, 9, 11, 12]) expect(byReason[reason] ?? 0, `cases ending in reason ${reason}`).to.be.greaterThan(10);
  });
});
