import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();

// Real addresses from docs/research/verified-facts.md, verified there by
// reading name()/symbol()/decimals() live off BSC mainnet. Using the real
// pair here (not placeholder addresses) is what actually proves the
// allowlist tells NVDAB apart from its impersonator - a synthetic pair of
// addresses would only prove the mapping lookup works, not that it draws
// the right line between the two addresses that matter in practice.
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";

const STALENESS_BOUND_SECONDS = 15 * 60;
const ONE_DAY_SECONDS = 24 * 60 * 60;

// Mirrors the Covenant.DenialReason enum order exactly - see contracts/Covenant.sol.
const Reason = {
  None: 0n,
  MandateInactive: 1n,
  MandateExpired: 2n,
  TokenNotAllowed: 3n,
  NotionalExceeded: 4n,
  DailyLimitExceeded: 5n,
  OracleStale: 6n,
  OracleHalted: 7n,
};

async function deployCovenantFixture() {
  const [owner, oracleUpdater, trader, other] = await ethers.getSigners();

  const quoteToken = await ethers.deployContract("MockERC20", ["Mock USDT", "mUSDT"]);
  const router = await ethers.deployContract("MockRouter");
  const tokenOut = await ethers.deployContract("MockERC20", ["Mock NVDAB", "mNVDAB"]);

  const covenant = await ethers.deployContract("Covenant", [
    await quoteToken.getAddress(),
    await router.getAddress(),
    oracleUpdater.address,
    STALENESS_BOUND_SECONDS,
  ]);

  return { owner, oracleUpdater, trader, other, quoteToken, router, tokenOut, covenant };
}

/** Allowlists tokenOut, sets a permissive mandate, and pushes a fresh non-halted oracle update. */
async function makeTradeable(
  covenant: Awaited<ReturnType<typeof deployCovenantFixture>>["covenant"],
  oracleUpdater: Awaited<ReturnType<typeof deployCovenantFixture>>["oracleUpdater"],
  tokenOutAddress: string,
  { maxNotionalPerTrade = ethers.parseUnits("1000", 18), maxTradesPerDay = 10n } = {},
) {
  await covenant.setAllowedToken(tokenOutAddress, true);
  const latest = await networkHelpers.time.latest();
  await covenant.setMandate(maxNotionalPerTrade, maxTradesPerDay, latest + ONE_DAY_SECONDS * 30);
  await covenant.connect(oracleUpdater).updateOracle(tokenOutAddress, false);
}

async function fundAndApprove(quoteToken: any, covenant: any, trader: any, amount: bigint) {
  await quoteToken.mint(trader.address, amount);
  await quoteToken.connect(trader).approve(await covenant.getAddress(), amount);
}

describe("Covenant (unit, mocked token/router)", function () {
  describe("deployment", function () {
    it("rejects a zero address for quoteToken, swapRouter, or oracleUpdater", async function () {
      const [oracleUpdater] = await ethers.getSigners();
      const router = await ethers.deployContract("MockRouter");
      const quoteToken = await ethers.deployContract("MockERC20", ["Mock USDT", "mUSDT"]);
      const CovenantFactory = await ethers.getContractFactory("Covenant");

      await expect(
        CovenantFactory.deploy(ethers.ZeroAddress, await router.getAddress(), oracleUpdater.address, STALENESS_BOUND_SECONDS),
      ).to.be.revertedWithCustomError(CovenantFactory, "ZeroAddress");

      await expect(
        CovenantFactory.deploy(await quoteToken.getAddress(), ethers.ZeroAddress, oracleUpdater.address, STALENESS_BOUND_SECONDS),
      ).to.be.revertedWithCustomError(CovenantFactory, "ZeroAddress");

      await expect(
        CovenantFactory.deploy(await quoteToken.getAddress(), await router.getAddress(), ethers.ZeroAddress, STALENESS_BOUND_SECONDS),
      ).to.be.revertedWithCustomError(CovenantFactory, "ZeroAddress");
    });

    it("sets the deployer as owner", async function () {
      const { owner, covenant } = await networkHelpers.loadFixture(deployCovenantFixture);
      expect(await covenant.owner()).to.equal(owner.address);
    });
  });

  describe("mandate administration", function () {
    it("only the owner can set a mandate", async function () {
      const { covenant, other } = await networkHelpers.loadFixture(deployCovenantFixture);
      const latest = await networkHelpers.time.latest();
      await expect(
        covenant.connect(other).setMandate(1n, 1n, latest + ONE_DAY_SECONDS),
      ).to.be.revertedWithCustomError(covenant, "NotOwner");
    });

    it("rejects a mandate whose expiry is already in the past", async function () {
      const { covenant } = await networkHelpers.loadFixture(deployCovenantFixture);
      const latest = await networkHelpers.time.latest();
      await expect(covenant.setMandate(1n, 1n, latest - 1)).to.be.revertedWithCustomError(covenant, "ExpiryInPast");
    });

    it("activates the mandate and emits MandateSet", async function () {
      const { covenant } = await networkHelpers.loadFixture(deployCovenantFixture);
      const latest = await networkHelpers.time.latest();
      const expiry = latest + ONE_DAY_SECONDS;

      await expect(covenant.setMandate(100n, 5n, expiry)).to.emit(covenant, "MandateSet").withArgs(100n, 5n, expiry);

      const mandate = await covenant.mandate();
      expect(mandate.active).to.equal(true);
      expect(mandate.maxNotionalPerTrade).to.equal(100n);
      expect(mandate.maxTradesPerDay).to.equal(5n);
      expect(mandate.expiry).to.equal(BigInt(expiry));
    });

    it("revokeMandate deactivates immediately and is owner-only", async function () {
      const { covenant, other } = await networkHelpers.loadFixture(deployCovenantFixture);
      const latest = await networkHelpers.time.latest();
      await covenant.setMandate(100n, 5n, latest + ONE_DAY_SECONDS);

      await expect(covenant.connect(other).revokeMandate()).to.be.revertedWithCustomError(covenant, "NotOwner");

      await expect(covenant.revokeMandate()).to.emit(covenant, "MandateRevoked");
      expect((await covenant.mandate()).active).to.equal(false);
    });
  });

  describe("token allowlist (provider pinning)", function () {
    it("is owner-only and pins the exact address, not a ticker", async function () {
      const { covenant, other } = await networkHelpers.loadFixture(deployCovenantFixture);

      await expect(covenant.connect(other).setAllowedToken(NVDAB, true)).to.be.revertedWithCustomError(
        covenant,
        "NotOwner",
      );

      await expect(covenant.setAllowedToken(NVDAB, true)).to.emit(covenant, "TokenAllowlisted").withArgs(
        ethers.getAddress(NVDAB),
        true,
      );

      expect(await covenant.allowedTokens(NVDAB)).to.equal(true);
      expect(await covenant.allowedTokens(IMPERSONATOR_BSTOCKS)).to.equal(false);
    });

    it("denies the real impersonator address from docs/research/verified-facts.md even once NVDAB is allowlisted", async function () {
      const { covenant, oracleUpdater } = await networkHelpers.loadFixture(deployCovenantFixture);
      await makeTradeable(covenant, oracleUpdater, NVDAB);

      // The impersonator was never allowlisted - only the real NVDAB address was.
      expect(await covenant.previewDecision(IMPERSONATOR_BSTOCKS, 1n)).to.equal(Reason.TokenNotAllowed);
      expect(await covenant.previewDecision(NVDAB, 1n)).to.equal(Reason.None);
    });
  });

  describe("oracle", function () {
    it("updateOracle is restricted to the configured updater", async function () {
      const { covenant, other, tokenOut } = await networkHelpers.loadFixture(deployCovenantFixture);
      await expect(
        covenant.connect(other).updateOracle(await tokenOut.getAddress(), false),
      ).to.be.revertedWithCustomError(covenant, "NotOracleUpdater");
    });

    it("setOracleUpdater is owner-only and takes effect immediately", async function () {
      const { covenant, other, oracleUpdater, tokenOut } = await networkHelpers.loadFixture(deployCovenantFixture);
      await expect(covenant.connect(other).setOracleUpdater(other.address)).to.be.revertedWithCustomError(
        covenant,
        "NotOwner",
      );

      await covenant.setOracleUpdater(other.address);
      const tokenOutAddress = await tokenOut.getAddress();
      // The old updater can no longer push updates.
      await expect(covenant.connect(oracleUpdater).updateOracle(tokenOutAddress, false)).to.be.revertedWithCustomError(
        covenant,
        "NotOracleUpdater",
      );
      // The new one can.
      await expect(covenant.connect(other).updateOracle(tokenOutAddress, false)).to.emit(covenant, "OracleUpdated");
    });
  });

  describe("guardedSwap - denial paths (no revert, Attestation only, no funds move)", function () {
    it("denies with MandateInactive when no mandate has ever been set", async function () {
      const { covenant, tokenOut, trader, quoteToken } = await networkHelpers.loadFixture(deployCovenantFixture);
      const tokenOutAddress = await tokenOut.getAddress();
      await covenant.setAllowedToken(tokenOutAddress, true);

      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.MandateInactive);

      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, 1n, 0n, false, Reason.MandateInactive);

      expect(await quoteToken.balanceOf(trader.address)).to.equal(0n);
    });

    it("denies with MandateExpired once the mandate's expiry passes", async function () {
      const { covenant, oracleUpdater, tokenOut, trader } = await networkHelpers.loadFixture(deployCovenantFixture);
      const tokenOutAddress = await tokenOut.getAddress();
      await covenant.setAllowedToken(tokenOutAddress, true);
      await covenant.connect(oracleUpdater).updateOracle(tokenOutAddress, false);

      const latest = await networkHelpers.time.latest();
      const shortExpiry = latest + 60;
      await covenant.setMandate(ethers.parseUnits("1000", 18), 10n, shortExpiry);

      // Still valid right up to expiry.
      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.None);

      await networkHelpers.time.increaseTo(shortExpiry + 1);

      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.MandateExpired);
      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, 1n, 0n, false, Reason.MandateExpired);
    });

    it("denies with TokenNotAllowed for a token never allowlisted", async function () {
      const { covenant, tokenOut } = await networkHelpers.loadFixture(deployCovenantFixture);
      const latest = await networkHelpers.time.latest();
      await covenant.setMandate(ethers.parseUnits("1000", 18), 10n, latest + ONE_DAY_SECONDS);
      expect(await covenant.previewDecision(await tokenOut.getAddress(), 1n)).to.equal(Reason.TokenNotAllowed);
    });

    it("denies with NotionalExceeded above the per-trade cap", async function () {
      const { covenant, oracleUpdater, tokenOut } = await networkHelpers.loadFixture(deployCovenantFixture);
      const tokenOutAddress = await tokenOut.getAddress();
      await makeTradeable(covenant, oracleUpdater, tokenOutAddress, { maxNotionalPerTrade: 100n });

      expect(await covenant.previewDecision(tokenOutAddress, 100n)).to.equal(Reason.None);
      expect(await covenant.previewDecision(tokenOutAddress, 101n)).to.equal(Reason.NotionalExceeded);
    });

    it("denies with OracleStale when the oracle has never been updated for that token", async function () {
      const { covenant, tokenOut } = await networkHelpers.loadFixture(deployCovenantFixture);
      const tokenOutAddress = await tokenOut.getAddress();
      await covenant.setAllowedToken(tokenOutAddress, true);
      const latest = await networkHelpers.time.latest();
      await covenant.setMandate(ethers.parseUnits("1000", 18), 10n, latest + ONE_DAY_SECONDS);
      // Deliberately no updateOracle call.

      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.OracleStale);
    });

    it("denies with OracleStale once an update ages past the staleness bound", async function () {
      const { covenant, oracleUpdater, tokenOut } = await networkHelpers.loadFixture(deployCovenantFixture);
      const tokenOutAddress = await tokenOut.getAddress();
      await makeTradeable(covenant, oracleUpdater, tokenOutAddress);

      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.None);

      await networkHelpers.time.increase(STALENESS_BOUND_SECONDS + 1);

      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.OracleStale);
    });

    it("denies with OracleHalted when the oracle reports a halt", async function () {
      const { covenant, oracleUpdater, tokenOut } = await networkHelpers.loadFixture(deployCovenantFixture);
      const tokenOutAddress = await tokenOut.getAddress();
      await makeTradeable(covenant, oracleUpdater, tokenOutAddress);
      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.None);

      // Halt flips between preview and (what would be) execute - re-checked fresh every call, not cached.
      await covenant.connect(oracleUpdater).updateOracle(tokenOutAddress, true);
      expect(await covenant.previewDecision(tokenOutAddress, 1n)).to.equal(Reason.OracleHalted);
    });

    it("off-by-one: denies the (N+1)th trade in a day, then allows again once the day rolls over", async function () {
      const { covenant, oracleUpdater, tokenOut, quoteToken, trader } = await networkHelpers.loadFixture(
        deployCovenantFixture,
      );
      const tokenOutAddress = await tokenOut.getAddress();
      await makeTradeable(covenant, oracleUpdater, tokenOutAddress, { maxTradesPerDay: 1n });

      await fundAndApprove(quoteToken, covenant, trader, 10n);
      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, 1n, 1n, true, Reason.None);
      expect(await covenant.tradesUsedToday()).to.equal(1n);

      // The 2nd trade the same day is the (N+1)th - must deny, not revert, and pull nothing.
      const balanceBeforeDenial = await quoteToken.balanceOf(trader.address);
      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, 1n, 0n, false, Reason.DailyLimitExceeded);
      expect(await quoteToken.balanceOf(trader.address)).to.equal(balanceBeforeDenial);

      // Roll into the next UTC day: the counter resets and the trade succeeds again.
      // (The oracle update from makeTradeable() is now stale on its own terms -
      // STALENESS_BOUND_SECONDS is 15 minutes, we just warped a full day - so it
      // has to be refreshed here too, independently of the daily-limit reset.)
      await networkHelpers.time.increase(ONE_DAY_SECONDS);
      await covenant.connect(oracleUpdater).updateOracle(tokenOutAddress, false);
      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, 1n, 1n, true, Reason.None);
      expect(await covenant.tradesUsedToday()).to.equal(1n);
    });
  });

  describe("preview/execute agreement - same code path, no drift possible by construction", function () {
    // cross-hackathon-lessons.md #4 / noyeet's design principle: simulate
    // and execute should share one code path so they can't silently drift
    // apart. Covenant already does this structurally - previewDecision and
    // guardedSwap both call the same internal _evaluate (see Covenant.sol) -
    // but that was never directly exercised in one test: call previewDecision
    // immediately before guardedSwap on the identical inputs and assert the
    // real Attestation reports exactly what was previewed, for both a deny
    // and an allow. If someone ever splits the two checks apart, this is the
    // test that would catch it.
    it("previewDecision's answer matches the real Attestation reason for a denial", async function () {
      const { covenant, tokenOut, trader } = await networkHelpers.loadFixture(deployCovenantFixture);
      const tokenOutAddress = await tokenOut.getAddress();
      // Deliberately untradeable: no mandate, no allowlist, no oracle update.
      const previewed = await covenant.previewDecision(tokenOutAddress, 1n);
      expect(previewed).to.equal(Reason.MandateInactive);

      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, 1n, 0n, false, previewed);
    });

    it("previewDecision's answer matches the real Attestation reason for an allow", async function () {
      const { covenant, oracleUpdater, tokenOut, quoteToken, trader } = await networkHelpers.loadFixture(
        deployCovenantFixture,
      );
      const tokenOutAddress = await tokenOut.getAddress();
      await makeTradeable(covenant, oracleUpdater, tokenOutAddress);
      await fundAndApprove(quoteToken, covenant, trader, 1n);

      const previewed = await covenant.previewDecision(tokenOutAddress, 1n);
      expect(previewed).to.equal(Reason.None);

      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, 1n, 1n, true, previewed);
    });
  });

  describe("guardedSwap - allow path", function () {
    it("pulls exactly amountIn, delivers amountOut to the caller, and records the trade", async function () {
      const { covenant, oracleUpdater, tokenOut, quoteToken, trader } = await networkHelpers.loadFixture(
        deployCovenantFixture,
      );
      const tokenOutAddress = await tokenOut.getAddress();
      await makeTradeable(covenant, oracleUpdater, tokenOutAddress);

      const amountIn = ethers.parseUnits("5", 18);
      await fundAndApprove(quoteToken, covenant, trader, amountIn);

      const traderQuoteBefore = await quoteToken.balanceOf(trader.address);

      await expect(covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, amountIn, 0n))
        .to.emit(covenant, "Attestation")
        .withArgs(trader.address, tokenOutAddress, amountIn, amountIn, true, Reason.None);

      expect(await quoteToken.balanceOf(trader.address)).to.equal(traderQuoteBefore - amountIn);
      expect(await tokenOut.balanceOf(trader.address)).to.equal(amountIn); // MockRouter's fixed 1:1 rate
      expect(await covenant.tradesUsedToday()).to.equal(1n);
      // Non-custodial: Covenant itself holds nothing once the call completes.
      expect(await quoteToken.balanceOf(await covenant.getAddress())).to.equal(0n);
    });

    it("reverts for real (not a soft denial) when the swap itself fails downstream, e.g. slippage", async function () {
      const { covenant, oracleUpdater, tokenOut, quoteToken, trader } = await networkHelpers.loadFixture(
        deployCovenantFixture,
      );
      const tokenOutAddress = await tokenOut.getAddress();
      await makeTradeable(covenant, oracleUpdater, tokenOutAddress);

      const amountIn = ethers.parseUnits("5", 18);
      await fundAndApprove(quoteToken, covenant, trader, amountIn);

      // MockRouter is a fixed 1:1 rate, so demanding more out than in is unsatisfiable -
      // this must be a real Solidity revert, not an Attestation(false, ...), because it's
      // a DEX-level failure that happens after Covenant's own guard already said yes.
      await expect(
        covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, amountIn, amountIn + 1n),
      ).to.be.revertedWith("MockRouter: amountOutMinimum");
    });
  });

  describe("reentrancy", function () {
    it("blocks a token whose transferFrom tries to reenter guardedSwap", async function () {
      const [owner, oracleUpdater, trader] = await ethers.getSigners();
      const maliciousToken = await ethers.deployContract("MaliciousReentrantToken");
      const router = await ethers.deployContract("MockRouter");
      const tokenOut = await ethers.deployContract("MockERC20", ["Mock NVDAB", "mNVDAB"]);
      const tokenOutAddress = await tokenOut.getAddress();

      const covenant = await ethers.deployContract("Covenant", [
        await maliciousToken.getAddress(),
        await router.getAddress(),
        oracleUpdater.address,
        STALENESS_BOUND_SECONDS,
      ]);
      const covenantAddress = await covenant.getAddress();

      await makeTradeable(covenant, oracleUpdater, tokenOutAddress);
      await maliciousToken.setAttack(covenantAddress, tokenOutAddress);

      await expect(
        covenant.connect(trader).guardedSwap(tokenOutAddress, 2500, 1n, 0n),
      ).to.be.revertedWithCustomError(covenant, "Reentrant");
    });
  });

  describe("rescueToken", function () {
    it("is owner-only and moves out a balance stuck by direct transfer", async function () {
      const { covenant, other, quoteToken } = await networkHelpers.loadFixture(deployCovenantFixture);
      const covenantAddress = await covenant.getAddress();
      await quoteToken.mint(covenantAddress, 50n);

      await expect(covenant.connect(other).rescueToken(await quoteToken.getAddress(), 50n, other.address)).to.be
        .revertedWithCustomError(covenant, "NotOwner");

      await covenant.rescueToken(await quoteToken.getAddress(), 50n, other.address);
      expect(await quoteToken.balanceOf(other.address)).to.equal(50n);
    });
  });
});
