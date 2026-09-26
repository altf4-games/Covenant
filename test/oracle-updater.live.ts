import { expect } from "chai";
import { network } from "hardhat";
import { isHalted, priceToUsdE18, fetchHourlyKlines } from "../scripts/lib/rwa-status.js";
import { isRegularSessionOpen, lastRegularClose } from "../scripts/lib/nyse-calendar.js";
import { readLiveOracle, pushOracleUpdate } from "../scripts/oracle-updater.js";
import { isWeb3ApiGeoBlocked } from "../scripts/lib/local-fork.js";

const { ethers, networkHelpers } = await network.getOrCreate("bscFork");

// Real NVDAB and real BSC USDT, verified in docs/research/verified-facts.md.
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const BSC_BINANCE_CHAIN_ID = 56;
const E18 = 10n ** 18n;

// Both reads hit Binance's real public endpoints, deliberately unmocked:
// the point is proving the pipeline works against Binance's actual current
// answer (friction-log.md B6 and B15 show how unreliable assuming this
// endpoint's shape from docs alone would have been).
describe("Oracle updater (live RWA status + live price -> real on-chain write)", function () {
  this.timeout(90_000);

  it("posts what the live endpoints say right now, reads it back, and the guard's decision agrees", async function () {
    const [, updater, agent] = await ethers.getSigners();
    const covenant = await ethers.deployContract("Covenant", [USDT, updater.address, agent.address, 900, 600]);
    const covenantAddress = await covenant.getAddress();

    const now = new Date();
    let reading: Awaited<ReturnType<typeof readLiveOracle>>;
    try {
      reading = await readLiveOracle(BSC_BINANCE_CHAIN_ID, NVDAB, now);
    } catch (err) {
      if (isWeb3ApiGeoBlocked(err)) return this.skip();
      throw err;
    }
    console.log(
      `      (live NVDAB: openState=${reading.status.openState} reasonCode=${reading.status.reasonCode} -> halted=${reading.halted}, price=${reading.rawPrice})`,
    );
    console.log(`      (NYSE session open: ${reading.sessionOpen}; last close ${reading.lastCloseAt.toISOString()} at ${reading.rawLastClose})`);

    // Feature 1's fields, re-derived independently: the session from the
    // calendar, and the last close from a separate fetch of the real K-line.
    expect(reading.sessionOpen).to.equal(isRegularSessionOpen(now));
    expect(reading.lastCloseAt.getTime()).to.equal(lastRegularClose(now).getTime());
    const candle = (await fetchHourlyKlines(BSC_BINANCE_CHAIN_ID, NVDAB)).find((k) => k[6] === reading.lastCloseAt.getTime())!;
    expect(reading.lastCloseUsd).to.equal(priceToUsdE18(candle[4]));
    // Real, not a units bug: within 20% of the live price.
    expect(reading.lastCloseUsd * 10n).to.be.greaterThan(reading.priceUsd * 8n);
    expect(reading.lastCloseUsd * 10n).to.be.lessThan(reading.priceUsd * 12n);
    // A real stock price, not a placeholder: NVDAB traded around $220 when
    // this was written. A loose band still catches a units bug (1e18 off).
    expect(reading.priceUsd).to.be.greaterThan(10n * E18);
    expect(reading.priceUsd).to.be.lessThan(10_000n * E18);

    const before = await networkHelpers.time.latest();
    const posted = await pushOracleUpdate({ signer: updater, covenantAddress, token: NVDAB, reading });
    expect(posted.halted).to.equal(reading.halted);
    expect(posted.priceUsd).to.equal(reading.priceUsd);
    expect(posted.sessionOpen).to.equal(reading.sessionOpen);
    expect(posted.lastCloseUsd).to.equal(reading.lastCloseUsd);
    expect(posted.updatedAt).to.be.greaterThanOrEqual(BigInt(before));

    // End to end: real API -> real write -> real guard read.
    const latest = await networkHelpers.time.latest();
    await covenant.setMandate(10n * E18, 5n, latest + 30 * 24 * 60 * 60);
    await covenant.configureToken(NVDAB, true, 100, 10n * E18);
    await covenant.setClosedMarketDrift(NVDAB, 10_000); // wide open: this test is about the live halt signal
    const amountIn = E18; // $1
    const quotedOut = (amountIn * E18) / reading.priceUsd;
    const minOut = (quotedOut * 995n) / 1000n;
    const decision = await covenant.previewDecision(0, NVDAB, amountIn, quotedOut, minOut);
    expect(decision).to.equal(reading.halted ? 7n : 0n); // OracleHalted : None
  });

  it("refuses to post when the updater key is the agent's or the owner's", async function () {
    const [owner, updater, agent] = await ethers.getSigners();
    const covenant = await ethers.deployContract("Covenant", [USDT, updater.address, agent.address, 900, 600]);
    const reading = { halted: false, priceUsd: 200n * E18, sessionOpen: true, lastCloseUsd: 200n * E18 };
    for (const wrong of [owner, agent]) {
      await expect(
        pushOracleUpdate({ signer: wrong, covenantAddress: await covenant.getAddress(), token: NVDAB, reading }),
      ).to.be.rejected;
    }
  });

  it("classifies every documented reason code correctly (isHalted table, values from the skill docs)", function () {
    // Transcribed from binance-tokenized-securities-info/SKILL.md's Reason
    // Codes table, not invented - see friction-log.md B15.
    const cases: Array<{ openState: boolean; reasonCode: Parameters<typeof isHalted>[0]["reasonCode"]; expectHalted: boolean }> = [
      { openState: true, reasonCode: "TRADING", expectHalted: false },
      { openState: false, reasonCode: "MARKET_CLOSED", expectHalted: true },
      { openState: false, reasonCode: "MARKET_PAUSED", expectHalted: true },
      { openState: false, reasonCode: "ASSET_PAUSED", expectHalted: true },
      { openState: false, reasonCode: "ASSET_LIMITED", expectHalted: true },
      { openState: false, reasonCode: "UNSUPPORTED", expectHalted: true },
      { openState: false, reasonCode: "MARKET_MAINTENANCE", expectHalted: true },
      // A contradiction the docs don't rule out: openState alone isn't trusted.
      { openState: true, reasonCode: "ASSET_PAUSED", expectHalted: true },
    ];
    for (const { openState, reasonCode, expectHalted } of cases) {
      expect(isHalted({ openState, reasonCode })).to.equal(expectHalted, `openState=${openState} reasonCode=${reasonCode}`);
    }
  });

  it("converts real price strings to 1e18 fixed point, including the 36-decimal ones xStocks return", function () {
    // Both strings were returned live by the RWA dynamic endpoint (see
    // data/off-hours-log.jsonl): NVDAB with 20 decimals, NVDAx with 36.
    expect(priceToUsdE18("226.40605755959772329895")).to.equal(226_406057559597723298n);
    expect(priceToUsdE18("226.565390020320031841313297186531632116")).to.equal(226_565390020320031841n);
    expect(priceToUsdE18("221.57")).to.equal(221_570000000000000000n);
    expect(priceToUsdE18("0")).to.equal(0n);
    expect(() => priceToUsdE18("-1")).to.throw();
    expect(() => priceToUsdE18("1e3")).to.throw();
  });
});
