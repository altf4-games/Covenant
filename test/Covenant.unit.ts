import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();

// The real impersonator from docs/research/verified-facts.md: symbol
// "bStocks", 1e27 supply, not a real stock token. Allowlisting is by exact
// address, so it must be denied even while a real stock is allowed.
const IMPERSONATOR_BSTOCKS = "0x2F701b108a9aF5558960325A0239D0a13c2C4444";

const STALENESS_BOUND = 15 * 60;
const DECISION_TTL = 10 * 60;
const ONE_DAY = 24 * 60 * 60;
const E18 = 10n ** 18n;

// Mirrors Covenant.DenialReason exactly - see contracts/Covenant.sol.
const Reason = {
  None: 0n,
  MandateInactive: 1n,
  MandateExpired: 2n,
  TokenNotAllowed: 3n,
  NotionalExceeded: 4n,
  DailyLimitExceeded: 5n,
  OracleStale: 6n,
  OracleHalted: 7n,
  SlippageTooLoose: 8n,
  PositionLimit: 9n,
  DecisionOpen: 10n,
  ClosedMarketDrift: 11n,
  DailyNotionalExceeded: 12n,
};
const Side = { Buy: 0, Sell: 1 };
const Mode = { Unknown: 0, Pool: 1, Rfq: 2, Aggregator: 3 };

const QUOTE_REF = ethers.keccak256(ethers.toUtf8Bytes("baw market-order quote response"));
const RESEARCH_REF = ethers.keccak256(ethers.toUtf8Bytes("x402 research response"));
const SWAP_TX = ethers.keccak256(ethers.toUtf8Bytes("a real swap tx hash"));

async function deployFixture() {
  const [owner, updater, agent, other, stranger] = await ethers.getSigners();
  const quote = await ethers.deployContract("MockERC20", ["Mock USDT", "mUSDT"]);
  const stock = await ethers.deployContract("MockERC20", ["Mock NVDAB", "mNVDAB"]);
  const covenant = await ethers.deployContract("Covenant", [
    await quote.getAddress(),
    updater.address,
    agent.address,
    STALENESS_BOUND,
    DECISION_TTL,
  ]);
  return { owner, updater, agent, other, stranger, quote, stock, covenant, stockAddress: await stock.getAddress() };
}

/** Mandate active, token allowed, oracle fresh. Every limit is overridable. */
async function makeTradeable(
  f: Awaited<ReturnType<typeof deployFixture>>,
  {
    maxNotional = 10n * E18,
    maxTrades = 5n,
    slippageBps = 100,
    maxPositionUsd = 50n * E18,
    price = 200n * E18,
  } = {},
) {
  const latest = await networkHelpers.time.latest();
  await f.covenant.setMandate(maxNotional, maxTrades, latest + 30 * ONE_DAY);
  await f.covenant.configureToken(f.stockAddress, true, slippageBps, maxPositionUsd);
  await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, price, true, price);
}

/** A buy of `usd` quote units at the oracle price, minimum 0.5% below. */
function buyArgs(usd: bigint, price = 200n * E18) {
  const quotedOut = (usd * E18) / price;
  const minOut = (quotedOut * 995n) / 1000n;
  return { amountIn: usd, quotedOut, minOut };
}

/** A sell of `tokens` stock units at the oracle price, minimum 0.5% below. */
function sellArgs(tokens: bigint, price = 200n * E18) {
  const quotedOut = (tokens * price) / E18;
  const minOut = (quotedOut * 995n) / 1000n;
  return { amountIn: tokens, quotedOut, minOut };
}

async function commit(
  f: Awaited<ReturnType<typeof deployFixture>>,
  side: number,
  a: { amountIn: bigint; quotedOut: bigint; minOut: bigint },
  token = f.stockAddress,
  signer = f.agent,
) {
  const tx = await f.covenant.connect(signer).commit(side, token, a.amountIn, a.quotedOut, a.minOut, QUOTE_REF, RESEARCH_REF);
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    const parsed = f.covenant.interface.parseLog(log as any);
    // toObject(), not a spread: an ethers Result's named keys don't survive `...`.
    if (parsed?.name === "DecisionCommitted") return { ...parsed.args.toObject(), block: receipt!.blockNumber } as any;
  }
  throw new Error("no DecisionCommitted event in receipt");
}

describe("Covenant v2 (unit, mocked tokens)", function () {
  describe("deployment", function () {
    it("rejects zero addresses", async function () {
      const [, updater, agent] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("Covenant");
      const q = updater.address; // any non-zero address works as the quote token here
      await expect(Factory.deploy(ethers.ZeroAddress, updater.address, agent.address, STALENESS_BOUND, DECISION_TTL)).to.be
        .revertedWithCustomError(Factory, "ZeroAddress");
      await expect(Factory.deploy(q, ethers.ZeroAddress, agent.address, STALENESS_BOUND, DECISION_TTL)).to.be
        .revertedWithCustomError(Factory, "ZeroAddress");
      await expect(Factory.deploy(q, updater.address, ethers.ZeroAddress, STALENESS_BOUND, DECISION_TTL)).to.be
        .revertedWithCustomError(Factory, "ZeroAddress");
    });

    it("rejects any two roles sharing a key: owner, oracle updater and agent must all differ", async function () {
      const [owner, updater, agent, quote] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("Covenant");
      await expect(Factory.deploy(quote.address, owner.address, agent.address, STALENESS_BOUND, DECISION_TTL)).to.be
        .revertedWithCustomError(Factory, "RolesNotDistinct");
      await expect(Factory.deploy(quote.address, updater.address, owner.address, STALENESS_BOUND, DECISION_TTL)).to.be
        .revertedWithCustomError(Factory, "RolesNotDistinct");
      await expect(Factory.deploy(quote.address, updater.address, updater.address, STALENESS_BOUND, DECISION_TTL)).to.be
        .revertedWithCustomError(Factory, "RolesNotDistinct");
    });

    it("rejects a staleness bound or decision TTL outside sane ranges", async function () {
      const [, updater, agent, quote] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("Covenant");
      await expect(Factory.deploy(quote.address, updater.address, agent.address, 59, DECISION_TTL)).to.be.revertedWithCustomError(Factory, "InvalidBound");
      await expect(Factory.deploy(quote.address, updater.address, agent.address, ONE_DAY + 1, DECISION_TTL)).to.be.revertedWithCustomError(Factory, "InvalidBound");
      await expect(Factory.deploy(quote.address, updater.address, agent.address, STALENESS_BOUND, 59)).to.be.revertedWithCustomError(Factory, "InvalidBound");
      await expect(Factory.deploy(quote.address, updater.address, agent.address, STALENESS_BOUND, 3601)).to.be.revertedWithCustomError(Factory, "InvalidBound");
    });

    it("records the three roles", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      expect(await f.covenant.owner()).to.equal(f.owner.address);
      expect(await f.covenant.oracleUpdater()).to.equal(f.updater.address);
      expect(await f.covenant.agent()).to.equal(f.agent.address);
    });
  });

  describe("owner administration", function () {
    it("setMandate is owner-only and rejects an expiry in the past", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      const latest = await networkHelpers.time.latest();
      await expect(f.covenant.connect(f.agent).setMandate(1n, 1n, latest + ONE_DAY)).to.be.revertedWithCustomError(f.covenant, "NotOwner");
      await expect(f.covenant.setMandate(1n, 1n, latest)).to.be.revertedWithCustomError(f.covenant, "ExpiryInPast");
      await expect(f.covenant.setMandate(5n, 3n, latest + ONE_DAY)).to.emit(f.covenant, "MandateSet").withArgs(5n, 3n, latest + ONE_DAY);
    });

    it("configureToken is owner-only and rejects a slippage bound over 100%", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await expect(f.covenant.connect(f.agent).configureToken(f.stockAddress, true, 100, 1n)).to.be.revertedWithCustomError(f.covenant, "NotOwner");
      await expect(f.covenant.configureToken(f.stockAddress, true, 10_001, 1n)).to.be.revertedWithCustomError(f.covenant, "InvalidBound");
      await expect(f.covenant.configureToken(ethers.ZeroAddress, true, 100, 1n)).to.be.revertedWithCustomError(f.covenant, "ZeroAddress");
      await expect(f.covenant.configureToken(f.stockAddress, true, 100, 7n)).to.emit(f.covenant, "TokenConfigured").withArgs(f.stockAddress, true, 100, 7n);
    });

    it("setAgent and setOracleUpdater are owner-only and keep all three roles distinct", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await expect(f.covenant.connect(f.agent).setAgent(f.other.address)).to.be.revertedWithCustomError(f.covenant, "NotOwner");
      await expect(f.covenant.setAgent(f.owner.address)).to.be.revertedWithCustomError(f.covenant, "RolesNotDistinct");
      await expect(f.covenant.setAgent(f.updater.address)).to.be.revertedWithCustomError(f.covenant, "RolesNotDistinct");
      await expect(f.covenant.setOracleUpdater(f.owner.address)).to.be.revertedWithCustomError(f.covenant, "RolesNotDistinct");
      await expect(f.covenant.setOracleUpdater(f.agent.address)).to.be.revertedWithCustomError(f.covenant, "RolesNotDistinct");
      await f.covenant.setAgent(f.other.address);
      expect(await f.covenant.agent()).to.equal(f.other.address);
    });

    it("setMandateForTokens (Feature 2 redesign) sets the mandate and configures every token in one owner transaction", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      const second = await ethers.deployContract("MockERC20", ["Mock AMDB", "mAMDB"]);
      const secondAddress = await second.getAddress();
      const latest = await networkHelpers.time.latest();
      const expiry = latest + 30 * ONE_DAY;

      await expect(
        f.covenant.connect(f.agent).setMandateForTokens(
          5n * E18, 3n, expiry, [f.stockAddress, secondAddress], [100, 150], [50n * E18, 50n * E18], [100, 0],
        ),
      ).to.be.revertedWithCustomError(f.covenant, "NotOwner");

      // Array-length mismatch is refused before anything is written.
      await expect(
        f.covenant.setMandateForTokens(5n * E18, 3n, expiry, [f.stockAddress, secondAddress], [100], [50n * E18, 50n * E18], [100, 0]),
      ).to.be.revertedWithCustomError(f.covenant, "ArrayLengthMismatch");

      await f.covenant.setMandateForTokens(
        5n * E18, 3n, expiry, [f.stockAddress, secondAddress], [100, 150], [50n * E18, 60n * E18], [100, 0],
      );

      const mandate = await f.covenant.mandate();
      expect(mandate.active).to.equal(true);
      expect(mandate.maxNotionalPerTradeUsd).to.equal(5n * E18);
      expect(mandate.maxTradesPerDay).to.equal(3n);

      const cfg1 = await f.covenant.tokenConfig(f.stockAddress);
      expect(cfg1.allowed).to.equal(true);
      expect(cfg1.maxSlippageBps).to.equal(100);
      expect(cfg1.maxPositionUsd).to.equal(50n * E18);
      expect(cfg1.maxClosedMarketDriftBps).to.equal(100);

      const cfg2 = await f.covenant.tokenConfig(secondAddress);
      expect(cfg2.allowed).to.equal(true);
      expect(cfg2.maxSlippageBps).to.equal(150);
      expect(cfg2.maxPositionUsd).to.equal(60n * E18);
      expect(cfg2.maxClosedMarketDriftBps).to.equal(0);

      // Emits the exact same events the single-token setters would, so no
      // off-chain decoder needs a separate code path for this function.
      await expect(
        f.covenant.setMandateForTokens(5n * E18, 3n, expiry, [f.stockAddress], [100], [50n * E18], [100]),
      )
        .to.emit(f.covenant, "MandateSet").withArgs(5n * E18, 3n, expiry)
        .and.to.emit(f.covenant, "TokenConfigured").withArgs(f.stockAddress, true, 100, 50n * E18)
        .and.to.emit(f.covenant, "ClosedMarketDriftSet").withArgs(f.stockAddress, 100);
    });

    it("setMaxDailyNotionalUsd (red-team H7) is owner-only, independent of setMandate, and defaults to disabled", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      expect(await f.covenant.maxDailyNotionalUsd()).to.equal(0n);
      await expect(f.covenant.connect(f.agent).setMaxDailyNotionalUsd(5n * E18)).to.be.revertedWithCustomError(f.covenant, "NotOwner");
      await expect(f.covenant.setMaxDailyNotionalUsd(5n * E18)).to.emit(f.covenant, "MaxDailyNotionalSet").withArgs(5n * E18);
      expect(await f.covenant.maxDailyNotionalUsd()).to.equal(5n * E18);
      // Tightening it doesn't touch the mandate set separately by setMandate.
      const latest = await networkHelpers.time.latest();
      await f.covenant.setMandate(10n * E18, 5n, latest + ONE_DAY);
      expect(await f.covenant.maxDailyNotionalUsd()).to.equal(5n * E18);
    });
  });

  describe("oracle", function () {
    it("updateOracle is updater-only, rejects a zero price, and records price and halt", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await expect(f.covenant.connect(f.agent).updateOracle(f.stockAddress, false, E18, true, E18)).to.be.revertedWithCustomError(f.covenant, "NotOracleUpdater");
      await expect(f.covenant.connect(f.owner).updateOracle(f.stockAddress, false, E18, true, E18)).to.be.revertedWithCustomError(f.covenant, "NotOracleUpdater");
      await expect(f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 0n, true, 0n)).to.be.revertedWithCustomError(f.covenant, "ZeroPrice");
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, true, 221n * E18, true, 221n * E18);
      const status = await f.covenant.oracleStatus(f.stockAddress);
      expect(status.halted).to.equal(true);
      expect(status.priceUsd).to.equal(221n * E18);
    });
  });

  describe("access: only the agent can commit, settle or cancel (red-team H2, griefing)", function () {
    it("a stranger, the owner and the oracle updater all revert on commit, and the day's counter is untouched", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const a = buyArgs(E18);
      for (const s of [f.stranger, f.owner, f.updater]) {
        await expect(
          f.covenant.connect(s).commit(Side.Buy, f.stockAddress, a.amountIn, a.quotedOut, a.minOut, QUOTE_REF, RESEARCH_REF),
        ).to.be.revertedWithCustomError(f.covenant, "NotAgent");
      }
      expect(await f.covenant.tradesUsedToday()).to.equal(0n);
      expect(await f.covenant.nextDecisionId()).to.equal(1n);
    });
  });

  describe("denials (never revert, always recorded)", function () {
    it("MandateInactive before any mandate, and after revokeMandate", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.MandateInactive);
      await makeTradeable(f);
      await f.covenant.revokeMandate();
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.MandateInactive);
    });

    it("MandateExpired once the expiry passes", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const latest = await networkHelpers.time.latest();
      await f.covenant.setMandate(10n * E18, 5n, latest + 100);
      await networkHelpers.time.increase(101);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.MandateExpired);
    });

    it("TokenNotAllowed for an unconfigured token and for the real impersonator address", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      expect((await commit(f, Side.Buy, buyArgs(E18), IMPERSONATOR_BSTOCKS)).reason).to.equal(Reason.TokenNotAllowed);
      await f.covenant.configureToken(f.stockAddress, false, 100, 50n * E18);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.TokenNotAllowed);
    });

    it("OracleStale when never updated, and once an update ages past the bound", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      const latest = await networkHelpers.time.latest();
      await f.covenant.setMandate(10n * E18, 5n, latest + 30 * ONE_DAY);
      await f.covenant.configureToken(f.stockAddress, true, 100, 50n * E18);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.OracleStale);
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, true, 200n * E18);
      await networkHelpers.time.increase(STALENESS_BOUND + 1);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.OracleStale);
    });

    it("OracleHalted while the oracle reports a halt", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, true, 200n * E18, true, 200n * E18);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.OracleHalted);
    });

    it("NotionalExceeded: a buy is measured in quote units, a sell through the oracle price", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxNotional: 10n * E18 });
      expect((await commit(f, Side.Buy, buyArgs(11n * E18))).reason).to.equal(Reason.NotionalExceeded);
      // 0.06 tokens at $200 = $12 of notional, over the $10 cap.
      expect((await commit(f, Side.Sell, sellArgs((6n * E18) / 100n))).reason).to.equal(Reason.NotionalExceeded);
      // 0.04 tokens = $8, under the cap.
      expect((await commit(f, Side.Sell, sellArgs((4n * E18) / 100n))).reason).to.equal(Reason.None);
    });

    it("SlippageTooLoose: a zero quote, and a minimum below the slippage bound", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { slippageBps: 100 });
      const a = buyArgs(E18);
      expect((await commit(f, Side.Buy, { ...a, quotedOut: 0n, minOut: 0n })).reason).to.equal(Reason.SlippageTooLoose);
      // 2% below the quote with a 1% bound.
      expect((await commit(f, Side.Buy, { ...a, minOut: (a.quotedOut * 98n) / 100n })).reason).to.equal(Reason.SlippageTooLoose);
    });

    it("SlippageTooLoose: an understated quote can't smuggle in a loose minimum (red-team H5)", async function () {
      // The attack: report a quote 10x too low, so a minimum "within 1% of
      // the quote" is really 90% below the market. The oracle leg of the
      // check catches it.
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { slippageBps: 100 });
      const honest = buyArgs(E18);
      const fakeQuote = honest.quotedOut / 10n;
      const looseMin = (fakeQuote * 995n) / 1000n;
      expect((await commit(f, Side.Buy, { amountIn: E18, quotedOut: fakeQuote, minOut: looseMin })).reason).to.equal(
        Reason.SlippageTooLoose,
      );
    });

    it("DailyLimitExceeded on the (N+1)th allowed trade, then clear the next UTC day", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxTrades: 1n });
      const first = await commit(f, Side.Buy, buyArgs(E18));
      expect(first.reason).to.equal(Reason.None);
      await f.covenant.connect(f.agent).settle(first.id, SWAP_TX, buyArgs(E18).quotedOut, Mode.Rfq);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.DailyLimitExceeded);

      await networkHelpers.time.increase(ONE_DAY);
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, true, 200n * E18);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.None);
    });

    it("DecisionOpen while an approved decision is still in flight, then clear once it expires", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.None);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.DecisionOpen);

      await networkHelpers.time.increase(DECISION_TTL + 1);
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, true, 200n * E18);
      expect(await f.covenant.hasOpenDecision()).to.equal(false);
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.None);
    });

    it("DailyNotionalExceeded (red-team H7) is off by default: 0 means no cumulative cap", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxNotional: 10n * E18, maxTrades: 10n });
      expect(await f.covenant.maxDailyNotionalUsd()).to.equal(0n);
      expect((await commit(f, Side.Buy, buyArgs(10n * E18))).reason).to.equal(Reason.None);
    });

    it("DailyNotionalExceeded (red-team H7): caps cumulative same-day notional once set, and resets the next UTC day", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxNotional: 10n * E18, maxTrades: 10n });
      await f.covenant.setMaxDailyNotionalUsd(15n * E18);

      const first = await commit(f, Side.Buy, buyArgs(10n * E18));
      expect(first.reason).to.equal(Reason.None);
      await f.covenant.connect(f.agent).settle(first.id, SWAP_TX, buyArgs(10n * E18).quotedOut, Mode.Rfq);
      expect(await f.covenant.notionalUsedToday()).to.equal(10n * E18);

      // $10 used, $10 more would total $20 - over the $15 daily cap, even
      // though each trade alone is under the $10-per-trade cap.
      expect((await commit(f, Side.Buy, buyArgs(10n * E18))).reason).to.equal(Reason.DailyNotionalExceeded);

      // Exactly at the boundary ($10 + $5 = $15) is allowed, not denied.
      const second = await commit(f, Side.Buy, buyArgs(5n * E18));
      expect(second.reason).to.equal(Reason.None);
      await f.covenant.connect(f.agent).settle(second.id, SWAP_TX, buyArgs(5n * E18).quotedOut, Mode.Rfq);
      expect(await f.covenant.notionalUsedToday()).to.equal(15n * E18);

      await networkHelpers.time.increase(ONE_DAY);
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, true, 200n * E18);
      expect(await f.covenant.notionalUsedToday()).to.equal(0n);
      expect((await commit(f, Side.Buy, buyArgs(10n * E18))).reason).to.equal(Reason.None);
    });

    it("H7 (disclosed residual gap): the daily-notional cap is keyed by UTC calendar day like tradesUsedToday, so a burst straddling midnight can still clear the cap twice within under a minute", async function () {
      // This is the exact double-burst the daily cap does not close on its
      // own - documented in Covenant.sol's _evaluate and in
      // docs/research/opus-2026-09-24/a-redteam.md's H7. A real fix needs a
      // rolling window, not a calendar-day counter; out of scope for this
      // build, but the gap is demonstrated here rather than left untested.
      // Timestamps are spaced generously (not shaved to the exact second)
      // because every transaction here mines its own block, and Hardhat's
      // default automine timestamp is strictly increasing - too tight a gap
      // would push the "first" trade itself past midnight before it lands.
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxNotional: 10n * E18, maxTrades: 10n });
      await f.covenant.setMaxDailyNotionalUsd(10n * E18);

      const latest = await networkHelpers.time.latest();
      const today = Math.floor(latest / ONE_DAY);
      const justBeforeMidnight = (today + 1) * ONE_DAY - 15; // 23:59:45 UTC
      await networkHelpers.time.increaseTo(justBeforeMidnight);
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, true, 200n * E18);

      const first = await commit(f, Side.Buy, buyArgs(10n * E18));
      expect(first.reason).to.equal(Reason.None); // uses the full $10 cap for "today"
      await f.covenant.connect(f.agent).settle(first.id, SWAP_TX, buyArgs(10n * E18).quotedOut, Mode.Rfq);

      await networkHelpers.time.increase(20); // crosses into the next UTC day
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, true, 200n * E18);
      const second = await commit(f, Side.Buy, buyArgs(10n * E18));
      // A second full $10 cleared within under a minute of the first - $20
      // of same-notional exposure in one burst, exactly the gap H7 flags.
      expect(second.reason).to.equal(Reason.None);
    });

    it("a denial doesn't count toward the day, doesn't open a decision, and expires on the spot", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const denied = await commit(f, Side.Buy, buyArgs(E18), IMPERSONATOR_BSTOCKS);
      expect(denied.allowed).to.equal(false);
      expect(await f.covenant.tradesUsedToday()).to.equal(0n);
      expect(await f.covenant.openDecisionId()).to.equal(0n);
      const stored = await f.covenant.getDecision(denied.id);
      expect(stored.expiresAt).to.equal(stored.committedAt);
    });
  });

  describe("Feature 3: position limit from the wallet's real balance", function () {
    it("denies a buy that would take the position over the cap, counting what's already held", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      // Cap $5 at $200/token = 0.025 tokens.
      await makeTradeable(f, { maxPositionUsd: 5n * E18 });

      // $4 of buying power with nothing held: fine.
      expect((await f.covenant.previewDecision(Side.Buy, f.stockAddress, 4n * E18, buyArgs(4n * E18).quotedOut, buyArgs(4n * E18).minOut))).to.equal(Reason.None);

      // The wallet already holds $3 worth (0.015 tokens). $3 more = $6 > $5.
      await f.stock.mint(f.agent.address, (15n * E18) / 1000n);
      expect((await commit(f, Side.Buy, buyArgs(3n * E18))).reason).to.equal(Reason.PositionLimit);

      // $2 more lands exactly on the $5 cap, which is allowed.
      expect((await commit(f, Side.Buy, buyArgs(2n * E18))).reason).to.equal(Reason.None);
    });

    it("reads the balance at decision time, so tokens arriving after an allowed decision count against the next one", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxPositionUsd: 5n * E18 });
      const first = await commit(f, Side.Buy, buyArgs(4n * E18));
      expect(first.reason).to.equal(Reason.None);
      // The real swap lands 0.02 tokens ($4) in the wallet, then settles.
      await f.stock.mint(f.agent.address, (2n * E18) / 100n);
      await f.covenant.connect(f.agent).settle(first.id, SWAP_TX, (2n * E18) / 100n, Mode.Rfq);
      expect((await commit(f, Side.Buy, buyArgs(2n * E18))).reason).to.equal(Reason.PositionLimit);
    });

    it("an understated quote can't slip past the cap: the larger of quote and oracle output is used", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxPositionUsd: 5n * E18, slippageBps: 10_000 });
      // With a 100% slippage bound the slippage check passes anything, so
      // this isolates the position check: a $6 buy reported as a tiny quote.
      expect((await commit(f, Side.Buy, { amountIn: 6n * E18, quotedOut: 1n, minOut: 0n })).reason).to.equal(Reason.PositionLimit);
    });

    it("token-to-share ratio normalization: the real ~0.078% share-vs-token skew (friction-log C17) makes the position check stricter, not exploitable", async function () {
      // baw market-order quote's toCoinAmount (this project's quotedOut) is
      // reported in bStock *share* units; balanceOf and the real ERC-20
      // Transfer move *token* units. NVDAB's real ratio, confirmed live via
      // the Day-1 gate swap (friction-log C17): toTokenActualQty
      // 0.001578888415748593 share units for a real Transfer of
      // 0.001577660642762526 token units - quotedOut runs about 0.0778%
      // (778 parts per million) above what the wallet will really hold.
      // The position check takes max(quotedOut, oracleOut), so this
      // real-world skew can only make the cap bind *earlier* than the real
      // post-trade position would - never later. No normalization is
      // applied on chain because none is needed: the conservative direction
      // is already the safe one, the same reasoning Feature 1's boundary
      // rounding test relies on.
      const f = await networkHelpers.loadFixture(deployFixture);
      const REAL_RATIO_PPM = 778n; // 0.0778%, i.e. 778 / 1_000_000
      const oracleOnly = buyArgs(5n * E18); // exactly at the $5 cap in real token units
      const shareInflatedQuotedOut = oracleOnly.quotedOut + (oracleOnly.quotedOut * REAL_RATIO_PPM) / 1_000_000n;

      await makeTradeable(f, { maxPositionUsd: 5n * E18 });
      // The real (token-unit) amount alone sits exactly at the cap: allowed.
      expect(
        await f.covenant.previewDecision(Side.Buy, f.stockAddress, oracleOnly.amountIn, oracleOnly.quotedOut, oracleOnly.minOut),
      ).to.equal(Reason.None);
      // The same trade, but with the real share-unit-inflated quotedOut a
      // live `baw market-order quote` would actually report, is denied -
      // the contract errs toward the wallet's real future balance being
      // slightly higher than it will be, never lower.
      expect(
        await f.covenant.previewDecision(Side.Buy, f.stockAddress, oracleOnly.amountIn, shareInflatedQuotedOut, oracleOnly.minOut),
      ).to.equal(Reason.PositionLimit);
    });

    it("doesn't apply to sells: reducing a position is never blocked by the cap", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxPositionUsd: 1n * E18 });
      await f.stock.mint(f.agent.address, 10n * E18); // far over the cap already
      expect((await commit(f, Side.Sell, sellArgs((2n * E18) / 100n))).reason).to.equal(Reason.None);
    });
  });

  describe("Feature 1: closed-market drift guard", function () {
    /** Session closed, the token trading at `current` now, having closed at `lastClose`. */
    async function closedMarket(f: Awaited<ReturnType<typeof deployFixture>>, current: bigint, lastClose: bigint) {
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, current, false, lastClose);
    }

    it("setClosedMarketDrift is owner-only, bounded, and emits", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await expect(f.covenant.connect(f.agent).setClosedMarketDrift(f.stockAddress, 100)).to.be.revertedWithCustomError(f.covenant, "NotOwner");
      await expect(f.covenant.setClosedMarketDrift(f.stockAddress, 10_001)).to.be.revertedWithCustomError(f.covenant, "InvalidBound");
      await expect(f.covenant.setClosedMarketDrift(ethers.ZeroAddress, 100)).to.be.revertedWithCustomError(f.covenant, "ZeroAddress");
      await expect(f.covenant.setClosedMarketDrift(f.stockAddress, 100)).to.emit(f.covenant, "ClosedMarketDriftSet").withArgs(f.stockAddress, 100);
      expect((await f.covenant.tokenConfig(f.stockAddress)).maxClosedMarketDriftBps).to.equal(100n);
    });

    it("configureToken doesn't reset the drift bound set separately", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await f.covenant.setClosedMarketDrift(f.stockAddress, 150);
      await f.covenant.configureToken(f.stockAddress, true, 100, E18);
      expect((await f.covenant.tokenConfig(f.stockAddress)).maxClosedMarketDriftBps).to.equal(150n);
    });

    it("the oracle rejects a zero last-close price", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await expect(f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, false, 0n)).to.be.revertedWithCustomError(f.covenant, "ZeroPrice");
    });

    it("while closed, a buy priced over the bound above the last close is denied; within it, allowed", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { slippageBps: 100 });
      await f.covenant.setClosedMarketDrift(f.stockAddress, 100); // 1%

      await closedMarket(f, 203n * E18, 200n * E18); // +1.5% since the close
      expect((await commit(f, Side.Buy, buyArgs(E18, 203n * E18))).reason).to.equal(Reason.ClosedMarketDrift);

      await closedMarket(f, 201n * E18, 200n * E18); // +0.5%
      expect(await f.covenant.previewDecision(Side.Buy, f.stockAddress, ...Object.values(buyArgs(E18, 201n * E18)) as [bigint, bigint, bigint])).to.equal(Reason.None);

      // Just inside +1%: allowed.
      await closedMarket(f, 20199n * E18 / 100n, 200n * E18);
      expect(await f.covenant.previewDecision(Side.Buy, f.stockAddress, ...Object.values(buyArgs(E18, 20199n * E18 / 100n)) as [bigint, bigint, bigint])).to.equal(Reason.None);

      // Exactly +1% is denied: quotedOut truncates, which puts the implied
      // price 20,200 wei (about 1e-16) over the bound. Rounding errs toward
      // denial, the safe direction for a guard; asserted so it stays that way.
      await closedMarket(f, 202n * E18, 200n * E18);
      expect(await f.covenant.previewDecision(Side.Buy, f.stockAddress, ...Object.values(buyArgs(E18, 202n * E18)) as [bigint, bigint, bigint])).to.equal(Reason.ClosedMarketDrift);
    });

    it("while closed, a sell priced over the bound below the last close is denied", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { slippageBps: 100 });
      await f.covenant.setClosedMarketDrift(f.stockAddress, 100);
      const tokens = (2n * E18) / 100n;

      await closedMarket(f, 197n * E18, 200n * E18); // -1.5%
      expect((await commit(f, Side.Sell, sellArgs(tokens, 197n * E18))).reason).to.equal(Reason.ClosedMarketDrift);

      await closedMarket(f, 199n * E18, 200n * E18); // -0.5%
      expect((await commit(f, Side.Sell, sellArgs(tokens, 199n * E18))).reason).to.equal(Reason.None);
    });

    it("doesn't apply while the session is open, or when the bound is 0", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { slippageBps: 100 });
      await f.covenant.setClosedMarketDrift(f.stockAddress, 100);

      // Session open: a price 5% above the last close is just the market.
      await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 210n * E18, true, 200n * E18);
      expect(await f.covenant.previewDecision(Side.Buy, f.stockAddress, ...Object.values(buyArgs(E18, 210n * E18)) as [bigint, bigint, bigint])).to.equal(Reason.None);

      // Session closed, rule off.
      await f.covenant.setClosedMarketDrift(f.stockAddress, 0);
      await closedMarket(f, 210n * E18, 200n * E18);
      expect(await f.covenant.previewDecision(Side.Buy, f.stockAddress, ...Object.values(buyArgs(E18, 210n * E18)) as [bigint, bigint, bigint])).to.equal(Reason.None);
    });

    it("with the real NVDAB numbers seen on 2026-09-25 (last close $223.679, $224.379 overnight, +0.31%)", async function () {
      // From Binance's K-line and dynamic endpoints at 07:21 UTC, NYSE closed.
      const lastClose = 223_679007987152600000n;
      const now = 224_379144003205100000n;
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { slippageBps: 100 });
      await closedMarket(f, now, lastClose);
      const a = buyArgs(E18, now);

      await f.covenant.setClosedMarketDrift(f.stockAddress, 20); // 0.2%: that overnight premium is too much
      expect(await f.covenant.previewDecision(Side.Buy, f.stockAddress, a.amountIn, a.quotedOut, a.minOut)).to.equal(Reason.ClosedMarketDrift);
      await f.covenant.setClosedMarketDrift(f.stockAddress, 100); // 1%: acceptable
      expect(await f.covenant.previewDecision(Side.Buy, f.stockAddress, a.amountIn, a.quotedOut, a.minOut)).to.equal(Reason.None);
    });

    it("H12: a zero-size sell no longer panics on division by zero while the market is closed", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { slippageBps: 100 });
      await f.covenant.setClosedMarketDrift(f.stockAddress, 100);
      await closedMarket(f, 200n * E18, 200n * E18);

      // amountIn = 0 makes oracleOut (and notional) 0 too, so quotedOut/minOut
      // only need to satisfy the slippage ratio against each other -
      // 9_900/10_000 clears a 1% (100 bps) slippage bound exactly.
      expect(await f.covenant.previewDecision(Side.Sell, f.stockAddress, 0n, 10_000n, 9_900n)).to.equal(Reason.None);
      expect((await commit(f, Side.Sell, { amountIn: 0n, quotedOut: 10_000n, minOut: 9_900n })).reason).to.equal(Reason.None);
    });
  });

  describe("the allowed path: commit -> settle", function () {
    it("an allowed commit records the decision, opens it, counts it, and sets expiry to now + TTL", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const a = buyArgs(E18);
      const ev = await commit(f, Side.Buy, a);
      expect(ev.allowed).to.equal(true);
      expect(ev.reason).to.equal(Reason.None);
      expect(ev.quoteRef).to.equal(QUOTE_REF);
      expect(ev.researchRef).to.equal(RESEARCH_REF);
      const stored = await f.covenant.getDecision(ev.id);
      expect(stored.expiresAt - stored.committedAt).to.equal(BigInt(DECISION_TTL));
      expect(stored.amountIn).to.equal(a.amountIn);
      expect(await f.covenant.openDecisionId()).to.equal(ev.id);
      expect(await f.covenant.tradesUsedToday()).to.equal(1n);
    });

    it("DecisionCommitted is self-describing (red-team H11): it carries the mandate and oracle snapshot in force, not just the decision", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      const latest = await networkHelpers.time.latest();
      const expiry = latest + 30 * ONE_DAY;
      await f.covenant.setMandate(10n * E18, 5n, expiry);
      await f.covenant.configureToken(f.stockAddress, true, 100, 50n * E18);
      const oracleTx = await f.covenant.connect(f.updater).updateOracle(f.stockAddress, false, 200n * E18, true, 200n * E18);
      const oracleReceipt = await oracleTx.wait();
      const oracleBlock = await ethers.provider.getBlock(oracleReceipt!.blockNumber);
      const oracleUpdatedAt = BigInt(oracleBlock!.timestamp);

      const ev = await commit(f, Side.Buy, buyArgs(E18));
      // A third party reading only this one event - no MandateSet/OracleUpdated
      // replay - can confirm what was in force when this decision was made.
      expect(ev.mandateMaxNotionalPerTradeUsd).to.equal(10n * E18);
      expect(ev.mandateMaxTradesPerDay).to.equal(5n);
      expect(ev.mandateExpiry).to.equal(BigInt(expiry));
      expect(ev.oracleUpdatedAt).to.equal(oracleUpdatedAt);
    });

    it("settle records the real fill, closes the decision, and flags a fill below the minimum", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const a = buyArgs(E18);
      const ev = await commit(f, Side.Buy, a);

      await expect(f.covenant.connect(f.agent).settle(ev.id, SWAP_TX, a.minOut - 1n, Mode.Rfq))
        .to.emit(f.covenant, "DecisionSettled")
        .withArgs(ev.id, SWAP_TX, a.minOut - 1n, Mode.Rfq, true);

      const stored = await f.covenant.getDecision(ev.id);
      expect(stored.settled).to.equal(true);
      expect(stored.swapTxHash).to.equal(SWAP_TX);
      expect(stored.executionMode).to.equal(BigInt(Mode.Rfq));
      expect(await f.covenant.openDecisionId()).to.equal(0n);

      const next = await commit(f, Side.Buy, a);
      await expect(f.covenant.connect(f.agent).settle(next.id, SWAP_TX, a.quotedOut, Mode.Pool))
        .to.emit(f.covenant, "DecisionSettled")
        .withArgs(next.id, SWAP_TX, a.quotedOut, Mode.Pool, false);
    });

    it("settle rejects: a stranger, an unknown id, a denied decision, a double settle, and a zero tx hash", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const denied = await commit(f, Side.Buy, buyArgs(E18), IMPERSONATOR_BSTOCKS);
      const ok = await commit(f, Side.Buy, buyArgs(E18));

      await expect(f.covenant.connect(f.stranger).settle(ok.id, SWAP_TX, 1n, Mode.Rfq)).to.be.revertedWithCustomError(f.covenant, "NotAgent");
      await expect(f.covenant.connect(f.agent).settle(0n, SWAP_TX, 1n, Mode.Rfq)).to.be.revertedWithCustomError(f.covenant, "DecisionDoesNotExist");
      await expect(f.covenant.connect(f.agent).settle(99n, SWAP_TX, 1n, Mode.Rfq)).to.be.revertedWithCustomError(f.covenant, "DecisionDoesNotExist");
      await expect(f.covenant.connect(f.agent).settle(denied.id, SWAP_TX, 1n, Mode.Rfq)).to.be.revertedWithCustomError(f.covenant, "DecisionNotAllowed");
      await expect(f.covenant.connect(f.agent).settle(ok.id, ethers.ZeroHash, 1n, Mode.Rfq)).to.be.revertedWithCustomError(f.covenant, "ZeroTxHash");
      await f.covenant.connect(f.agent).settle(ok.id, SWAP_TX, 1n, Mode.Rfq);
      await expect(f.covenant.connect(f.agent).settle(ok.id, SWAP_TX, 1n, Mode.Rfq)).to.be.revertedWithCustomError(f.covenant, "DecisionClosed");
    });

    it("settle is still accepted after the decision's expiry - verify.ts, not the contract, judges swap timing", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const ev = await commit(f, Side.Buy, buyArgs(E18));
      await networkHelpers.time.increase(DECISION_TTL + 60);
      await f.covenant.connect(f.agent).settle(ev.id, SWAP_TX, 1n, Mode.Rfq);
      expect((await f.covenant.getDecision(ev.id)).settled).to.equal(true);
    });

    it("cancel closes an approved decision without trading; it still counts toward the day", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f, { maxTrades: 1n });
      const ev = await commit(f, Side.Buy, buyArgs(E18));
      await expect(f.covenant.connect(f.stranger).cancel(ev.id)).to.be.revertedWithCustomError(f.covenant, "NotAgent");
      await expect(f.covenant.connect(f.agent).cancel(ev.id)).to.emit(f.covenant, "DecisionCancelled").withArgs(ev.id);
      expect(await f.covenant.openDecisionId()).to.equal(0n);
      await expect(f.covenant.connect(f.agent).cancel(ev.id)).to.be.revertedWithCustomError(f.covenant, "DecisionClosed");
      await expect(f.covenant.connect(f.agent).settle(ev.id, SWAP_TX, 1n, Mode.Rfq)).to.be.revertedWithCustomError(f.covenant, "DecisionClosed");
      expect((await commit(f, Side.Buy, buyArgs(E18))).reason).to.equal(Reason.DailyLimitExceeded);
    });

    it("rotating the agent clears the old agent's open decision", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      await commit(f, Side.Buy, buyArgs(E18));
      await f.covenant.setAgent(f.other.address);
      expect(await f.covenant.openDecisionId()).to.equal(0n);
      await expect(
        f.covenant.connect(f.agent).commit(Side.Buy, f.stockAddress, E18, 1n, 1n, QUOTE_REF, RESEARCH_REF),
      ).to.be.revertedWithCustomError(f.covenant, "NotAgent");
    });
  });

  describe("preview/commit agreement - one _evaluate, no drift possible", function () {
    it("previewDecision matches the real commit for a denial and for an allow", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await makeTradeable(f);
      const a = buyArgs(E18);

      const deniedPreview = await f.covenant.previewDecision(Side.Buy, IMPERSONATOR_BSTOCKS, a.amountIn, a.quotedOut, a.minOut);
      expect(deniedPreview).to.equal(Reason.TokenNotAllowed);
      expect((await commit(f, Side.Buy, a, IMPERSONATOR_BSTOCKS)).reason).to.equal(deniedPreview);

      const allowedPreview = await f.covenant.previewDecision(Side.Buy, f.stockAddress, a.amountIn, a.quotedOut, a.minOut);
      expect(allowedPreview).to.equal(Reason.None);
      expect((await commit(f, Side.Buy, a)).reason).to.equal(allowedPreview);
    });
  });
});
