import { expect } from "chai";
import { network } from "hardhat";
import { fetchAssetMarketStatus, isHalted } from "../scripts/lib/rwa-status.js";

const { ethers, networkHelpers } = await network.getOrCreate("bscFork");

// Real NVDAB, verified in docs/research/verified-facts.md.
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const BSC_BINANCE_CHAIN_ID = 56;
const STALENESS_BOUND_SECONDS = 15 * 60;

// Calls Binance's real public RWA status endpoint over the network - this is
// deliberately not mocked. The whole point of this test is proving the
// pipeline works against Binance's actual current answer, not a canned one:
// see docs/partner-feedback/friction-log.md B6 and B15 for how unreliable
// assuming this endpoint's shape from docs alone would have been.
describe("Oracle updater (live RWA status -> real on-chain write)", function () {
  this.timeout(60_000);

  it("writes what the live RWA API says right now into Covenant, and reads it back unchanged", async function () {
    const [owner, oracleUpdater] = await ethers.getSigners();

    const covenant = await ethers.deployContract("Covenant", [
      // quoteToken/swapRouter aren't exercised by this test - any non-zero
      // address satisfies the constructor's zero-address checks.
      owner.address,
      owner.address,
      oracleUpdater.address,
      STALENESS_BOUND_SECONDS,
    ]);

    const liveStatus = await fetchAssetMarketStatus(BSC_BINANCE_CHAIN_ID, NVDAB);
    const expectedHalted = isHalted(liveStatus);
    console.log(`      (live RWA status for NVDAB: openState=${liveStatus.openState} reasonCode=${liveStatus.reasonCode} -> halted=${expectedHalted})`);

    const before = await networkHelpers.time.latest();
    const tx = await covenant.connect(oracleUpdater).updateOracle(NVDAB, expectedHalted);
    await tx.wait();
    const after = await networkHelpers.time.latest();

    const [onChainHalted, onChainUpdatedAt] = await covenant.oracleStatus(NVDAB);
    expect(onChainHalted).to.equal(expectedHalted);
    expect(onChainUpdatedAt).to.be.greaterThanOrEqual(BigInt(before));
    expect(onChainUpdatedAt).to.be.lessThanOrEqual(BigInt(after));

    // previewDecision should now agree, end to end: real API -> real write -> real guard read.
    await covenant.setAllowedToken(NVDAB, true);
    const latest = await networkHelpers.time.latest();
    await covenant.setMandate(1n, 1n, latest + 30 * 24 * 60 * 60);
    const decision = await covenant.previewDecision(NVDAB, 1n);
    if (expectedHalted) {
      expect(decision).to.equal(7n); // DenialReason.OracleHalted
    } else {
      expect(decision).to.equal(0n); // DenialReason.None
    }
  });

  it("classifies every documented reason code correctly (isHalted unit table, real enum values from the skill docs)", function () {
    // Values transcribed from binance-tokenized-securities-info/SKILL.md's Reason Codes table,
    // not invented - see friction-log.md B15 for where that table came from.
    const cases: Array<{ openState: boolean; reasonCode: Parameters<typeof isHalted>[0]["reasonCode"]; expectHalted: boolean }> = [
      { openState: true, reasonCode: "TRADING", expectHalted: false },
      { openState: false, reasonCode: "MARKET_CLOSED", expectHalted: true },
      { openState: false, reasonCode: "MARKET_PAUSED", expectHalted: true },
      { openState: false, reasonCode: "ASSET_PAUSED", expectHalted: true },
      { openState: false, reasonCode: "ASSET_LIMITED", expectHalted: true },
      { openState: false, reasonCode: "UNSUPPORTED", expectHalted: true },
      { openState: false, reasonCode: "MARKET_MAINTENANCE", expectHalted: true },
      // Defensive case: an API that ever reports openState=true alongside a
      // non-TRADING reason code (a contradiction the docs don't rule out)
      // must still be treated as halted - "openState" alone is not trusted.
      { openState: true, reasonCode: "ASSET_PAUSED", expectHalted: true },
    ];

    for (const { openState, reasonCode, expectHalted } of cases) {
      expect(isHalted({ openState, reasonCode })).to.equal(expectHalted, `openState=${openState} reasonCode=${reasonCode}`);
    }
  });
});
