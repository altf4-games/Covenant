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

  describe("slashable guard (Phase 2.5, bond/challenge/slash)", function () {
    const CHALLENGE_WINDOW_SECONDS = 60 * 60;
    const BOND_COOLDOWN_SECONDS = 60 * 60;
    const EVIDENCE_HASH = ethers.keccak256(ethers.toUtf8Bytes("real RWA status response, fetched at challenge time"));

    async function postBond(covenant: any, oracleUpdater: any, amount = ethers.parseEther("0.01")) {
      await covenant.connect(oracleUpdater).postBond({ value: amount });
    }

    describe("postBond / withdrawBond", function () {
      it("is oracle-updater-only, accumulates, and emits real balances", async function () {
        const { covenant, oracleUpdater, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const amount1 = ethers.parseEther("0.01");
        const amount2 = ethers.parseEther("0.02");

        await expect(covenant.connect(other).postBond({ value: amount1 })).to.be.revertedWithCustomError(
          covenant,
          "NotOracleUpdater",
        );

        await expect(covenant.connect(oracleUpdater).postBond({ value: amount1 }))
          .to.emit(covenant, "BondPosted")
          .withArgs(oracleUpdater.address, amount1, amount1);
        expect(await covenant.updaterBond()).to.equal(amount1);

        await expect(covenant.connect(oracleUpdater).postBond({ value: amount2 }))
          .to.emit(covenant, "BondPosted")
          .withArgs(oracleUpdater.address, amount2, amount1 + amount2);
        expect(await covenant.updaterBond()).to.equal(amount1 + amount2);
      });

      it("blocks withdrawal during the cooldown, then allows it and moves a real balance", async function () {
        const { covenant, oracleUpdater } = await networkHelpers.loadFixture(deployCovenantFixture);
        const amount = ethers.parseEther("0.01");
        await postBond(covenant, oracleUpdater, amount);

        await expect(covenant.connect(oracleUpdater).withdrawBond()).to.be.revertedWithCustomError(
          covenant,
          "BondCooldownActive",
        );

        await networkHelpers.time.increase(BOND_COOLDOWN_SECONDS + 1);

        const before = await ethers.provider.getBalance(oracleUpdater.address);
        const tx = await covenant.connect(oracleUpdater).withdrawBond();
        const receipt = await tx.wait();
        const gasCost = receipt!.gasUsed * receipt!.gasPrice;
        const after = await ethers.provider.getBalance(oracleUpdater.address);

        expect(after - before + gasCost).to.equal(amount);
        expect(await covenant.updaterBond()).to.equal(0n);
      });

      it("edge case: blocks withdrawal while an unresolved challenge is open", async function () {
        const { covenant, oracleUpdater, tokenOut, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        await postBond(covenant, oracleUpdater);
        await networkHelpers.time.increase(BOND_COOLDOWN_SECONDS + 1);

        const updateTimestamp = await networkHelpers.time.latest();
        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);

        await expect(covenant.connect(oracleUpdater).withdrawBond()).to.be.revertedWithCustomError(
          covenant,
          "OpenChallengesExist",
        );
      });

      it("posting more bond restarts the cooldown - a top-up can't be withdrawn early", async function () {
        const { covenant, oracleUpdater } = await networkHelpers.loadFixture(deployCovenantFixture);
        await postBond(covenant, oracleUpdater);
        await networkHelpers.time.increase(BOND_COOLDOWN_SECONDS + 1);

        // Would be withdrawable now, but a fresh deposit resets the clock.
        await postBond(covenant, oracleUpdater, ethers.parseEther("0.005"));
        await expect(covenant.connect(oracleUpdater).withdrawBond()).to.be.revertedWithCustomError(
          covenant,
          "BondCooldownActive",
        );
      });
    });

    describe("challengeUpdate", function () {
      it("anyone can challenge, and emits the real evidence hash referenced", async function () {
        const { covenant, tokenOut, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();

        await expect(covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH))
          .to.emit(covenant, "ChallengeSubmitted")
          .withArgs(1n, other.address, tokenOutAddress, updateTimestamp, EVIDENCE_HASH);
        expect(await covenant.openChallengeCount()).to.equal(1n);
      });

      it("edge case: rejects a challenge submitted after the window has closed", async function () {
        const { covenant, tokenOut, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();

        await networkHelpers.time.increase(CHALLENGE_WINDOW_SECONDS + 1);

        await expect(
          covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH),
        ).to.be.revertedWithCustomError(covenant, "ChallengeWindowClosed");
      });

      it("edge case: a second challenge on the same (token, timestamp) is rejected while the first is unresolved", async function () {
        const { covenant, tokenOut, other, trader } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();

        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);
        await expect(
          covenant.connect(trader).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH),
        ).to.be.revertedWithCustomError(covenant, "UpdateAlreadyChallenged");
      });

      it("edge case: the same update CAN be re-challenged once the first challenge resolves", async function () {
        const { covenant, oracleUpdater, tokenOut, other, trader } = await networkHelpers.loadFixture(
          deployCovenantFixture,
        );
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();

        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);
        await covenant.resolveChallenge(1n, false); // dismissed, not upheld

        await expect(covenant.connect(trader).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH))
          .to.emit(covenant, "ChallengeSubmitted")
          .withArgs(2n, trader.address, tokenOutAddress, updateTimestamp, EVIDENCE_HASH);
      });
    });

    describe("resolveChallenge", function () {
      it("is owner-only", async function () {
        const { covenant, tokenOut, other, trader } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();
        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);

        await expect(covenant.connect(trader).resolveChallenge(1n, true)).to.be.revertedWithCustomError(
          covenant,
          "NotOwner",
        );
      });

      it("rejects an unknown challenge id and a double-resolve", async function () {
        const { covenant, tokenOut, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();

        await expect(covenant.resolveChallenge(1n, true)).to.be.revertedWithCustomError(
          covenant,
          "ChallengeDoesNotExist",
        );
        await expect(covenant.resolveChallenge(0n, true)).to.be.revertedWithCustomError(
          covenant,
          "ChallengeDoesNotExist",
        );

        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);
        await covenant.resolveChallenge(1n, false);
        await expect(covenant.resolveChallenge(1n, true)).to.be.revertedWithCustomError(
          covenant,
          "ChallengeAlreadyResolved",
        );
      });

      it("dismissed: no funds move, but the challenge slot frees up (openChallengeCount drops)", async function () {
        const { covenant, tokenOut, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();
        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);

        const bondBefore = await covenant.updaterBond();
        await expect(covenant.resolveChallenge(1n, false)).to.emit(covenant, "ChallengeResolved").withArgs(1n, false, 0n);
        expect(await covenant.updaterBond()).to.equal(bondBefore);
        expect(await covenant.openChallengeCount()).to.equal(0n);
      });

      it("upheld: slashes exactly SLASH_BPS of the current bond to the real challenger", async function () {
        const { covenant, oracleUpdater, tokenOut, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const bondAmount = ethers.parseEther("0.1");
        await postBond(covenant, oracleUpdater, bondAmount);

        const updateTimestamp = await networkHelpers.time.latest();
        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);

        const expectedSlash = (bondAmount * 2000n) / 10000n; // SLASH_BPS = 20%
        const before = await ethers.provider.getBalance(other.address);
        await expect(covenant.resolveChallenge(1n, true))
          .to.emit(covenant, "ChallengeResolved")
          .withArgs(1n, true, expectedSlash);
        const after = await ethers.provider.getBalance(other.address);

        expect(after - before).to.equal(expectedSlash);
        expect(await covenant.updaterBond()).to.equal(bondAmount - expectedSlash);
      });

      it("edge case: a second upheld challenge after an earlier slash never underflows, and gracefully slashes zero once the bond is fully gone", async function () {
        const { covenant, oracleUpdater, tokenOut, other, trader } = await networkHelpers.loadFixture(
          deployCovenantFixture,
        );
        const tokenOutAddress = await tokenOut.getAddress();
        // A tiny bond: 20% of 4 wei rounds down to 0 after enough rounds,
        // which is exactly the "bond insufficient to cover the slash
        // percentage" case the spec calls out - it must degrade gracefully
        // to a real zero-value transfer, not revert or underflow.
        await postBond(covenant, oracleUpdater, 4n);

        const t1 = await networkHelpers.time.latest();
        await covenant.connect(other).challengeUpdate(tokenOutAddress, t1, EVIDENCE_HASH);
        await covenant.resolveChallenge(1n, true); // slashes 0 (4*2000/10000 = 0)

        expect(await covenant.updaterBond()).to.equal(4n);

        const t2 = t1 + 1;
        await covenant.connect(trader).challengeUpdate(tokenOutAddress, t2, EVIDENCE_HASH);
        await covenant.resolveChallenge(2n, true); // would throw if it reverted or underflowed
        expect(await covenant.updaterBond()).to.equal(4n); // still 4 - never underflowed, never reverted
      });

      it("edge case: resolution uses the challenge's original claimed timestamp, not the resolution-time clock", async function () {
        // Submit near the edge of a real window, then let a lot of real
        // time pass before resolving. If resolveChallenge accidentally
        // re-checked the window against block.timestamp at resolution time
        // instead of trusting what was recorded at submission, this would
        // wrongly fail or behave differently long after the fact.
        const { covenant, tokenOut, other } = await networkHelpers.loadFixture(deployCovenantFixture);
        const tokenOutAddress = await tokenOut.getAddress();
        const updateTimestamp = await networkHelpers.time.latest();

        await networkHelpers.time.increase(CHALLENGE_WINDOW_SECONDS - 5);
        await covenant.connect(other).challengeUpdate(tokenOutAddress, updateTimestamp, EVIDENCE_HASH);

        await networkHelpers.time.increase(30 * 24 * 60 * 60); // a month later
        const stored = await covenant.challenges(1n);
        expect(stored.updateTimestamp).to.equal(updateTimestamp);

        await covenant.resolveChallenge(1n, false); // would throw if this wrongly re-checked the window at resolve time
      });
    });
  });
});
