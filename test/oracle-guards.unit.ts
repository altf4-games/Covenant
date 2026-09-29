import { expect } from "chai";
import { assertPriceConsistent, priceToUsdE18, type Kline } from "../scripts/lib/rwa-status.js";
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
});
