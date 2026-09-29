import { expect } from "chai";
import { assertPriceConsistent, priceToUsdE18, isHalted, closePriceAt, type Kline } from "../scripts/lib/rwa-status.js";
import { resolveOracleTokens } from "../scripts/oracle-updater.js";

const candle = (closeTime: number, close: string): Kline => [closeTime - 3_600_000, close, close, close, close, "1", closeTime];
const E18 = 10n ** 18n;

describe("oracle updater guards (unit, no network)", function () {
  describe("assertPriceConsistent - a live price the latest candle doesn't back", function () {
    const klines = [candle(1_000, "100"), candle(2_000, "200")];
    it("accepts a price close to the latest hourly close", function () {
      expect(() => assertPriceConsistent(priceToUsdE18("205"), klines)).to.not.throw();
      expect(() => assertPriceConsistent(priceToUsdE18("190"), klines)).to.not.throw();
    });
    it("uses the newest candle, whatever order the endpoint returned them in", function () {
      expect(() => assertPriceConsistent(priceToUsdE18("100"), [...klines].reverse())).to.throw(/stale or wrong/);
    });
    it("refuses a stale or garbage price", function () {
      expect(() => assertPriceConsistent(priceToUsdE18("150"), klines)).to.throw(/stale or wrong/);
      expect(() => assertPriceConsistent(E18 * 2000n, klines)).to.throw(/stale or wrong/);
    });
    it("refuses when there is nothing to cross-check against", function () {
      expect(() => assertPriceConsistent(E18, [])).to.throw(/no hourly candles/);
    });
  });

  describe("resolveOracleTokens - a theme mandate needs every one of its tokens kept fresh", function () {
    const A = "0x" + "aa".repeat(20);
    const B = "0x" + "BB".repeat(20);
    it("takes a comma-separated list, lowercased and de-duplicated", function () {
      expect(resolveOracleTokens(`${A}, ${B},${A}`)).to.deep.equal([A, B.toLowerCase()]);
    });
    it("expands theme:<key> to every token in theme-map.json", function () {
      expect(resolveOracleTokens("theme:ai-chips")).to.have.length(8);
    });
    it("rejects an unknown theme and a malformed address", function () {
      expect(() => resolveOracleTokens("theme:nope")).to.throw(/no theme/);
      expect(() => resolveOracleTokens("NVDA")).to.throw(/20-byte address/);
    });
  });

  describe("assertPriceConsistent boundaries", function () {
    const klines = [candle(1_000, "100")];
    it("exactly 10% away is accepted, one wei further is not", function () {
      expect(() => assertPriceConsistent(110n * E18, klines)).to.not.throw();
      expect(() => assertPriceConsistent(110n * E18 + 1n, klines)).to.throw(/stale or wrong/);
      expect(() => assertPriceConsistent(90n * E18, klines)).to.not.throw();
      expect(() => assertPriceConsistent(90n * E18 - 1n, klines)).to.throw(/stale or wrong/);
    });
    it("a candle that closed at zero is refused rather than used as a reference", function () {
      expect(() => assertPriceConsistent(E18, [candle(1_000, "0")])).to.throw(/zero close/);
    });
  });

  describe("price strings", function () {
    it("converts to 1e18 fixed point, truncating past 18 decimals, and refuses anything that isn't a plain decimal", function () {
      expect(priceToUsdE18("226.40605755959772329895")).to.equal(226_406057559597723298n);
      expect(priceToUsdE18("226.565390020320031841313297186531632116")).to.equal(226_565390020320031841n);
      expect(priceToUsdE18("221.57")).to.equal(221_570000000000000000n);
      expect(priceToUsdE18("0")).to.equal(0n);
      expect(priceToUsdE18("  5 ")).to.equal(5n * E18);
      for (const bad of ["-1", "1e3", "", ".5", "5.", "1,5", "0x10", "NaN"]) expect(() => priceToUsdE18(bad), bad).to.throw();
    });
  });

  describe("isHalted: only a positively confirmed TRADING is not halted", function () {
    it("classifies every documented reason code", function () {
      const codes = ["MARKET_CLOSED", "MARKET_PAUSED", "ASSET_PAUSED", "ASSET_LIMITED", "UNSUPPORTED", "MARKET_MAINTENANCE"] as const;
      expect(isHalted({ openState: true, reasonCode: "TRADING" })).to.equal(false);
      for (const reasonCode of codes) {
        expect(isHalted({ openState: false, reasonCode }), reasonCode).to.equal(true);
        expect(isHalted({ openState: true, reasonCode }), `open but ${reasonCode}`).to.equal(true);
      }
      expect(isHalted({ openState: false, reasonCode: "TRADING" })).to.equal(true);
    });
  });

  describe("closePriceAt", function () {
    const k: Kline[] = [[0, "1", "9", "0.5", "2", "10", 1_000], [1_000, "3", "9", "0.5", "4", "10", 2_000]];
    it("returns the close of the candle that ends exactly then, and nothing near it", function () {
      expect(closePriceAt(k, new Date(1_000))).to.equal("2");
      expect(closePriceAt(k, new Date(2_000))).to.equal("4");
      expect(() => closePriceAt(k, new Date(1_500))).to.throw(/no hourly candle/);
      expect(() => closePriceAt(k, new Date(1_001))).to.throw(/no hourly candle/);
    });
  });

  it("an empty token list is an error, not a silent no-op", function () {
    expect(() => resolveOracleTokens(" , ,")).to.throw(/empty/);
  });
});
