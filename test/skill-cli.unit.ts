import { expect } from "chai";
import { COMMANDS, hex32 } from "../skills/covenant-mandate/scripts/cli.mjs";

// Input validation in the Wallet Skill's CLI, no network: resolve gets a
// stubbed token list, the calldata builders need none.
const TOKEN = "0x" + "aa".repeat(20);

describe("covenant-mandate skill CLI (unit, input validation)", function () {
  describe("resolve's chain axis", function () {
    const realFetch = globalThis.fetch;
    before(() => {
      // One Ondo "FOO" token, and it's on Ethereum, not BSC.
      globalThis.fetch = (async () => ({
        status: 200,
        json: async () => ({ data: [{ ticker: "FOO", symbol: "FOOon", type: 1, chainId: "1", contractAddress: "0x" + "11".repeat(20) }] }),
      })) as unknown as typeof fetch;
    });
    after(() => {
      globalThis.fetch = realFetch;
    });

    const outcome = async (args: Record<string, unknown>) => {
      try {
        return (await COMMANDS.resolve(args as never)).resolved.chainId as string;
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    };

    it("refuses a single match on another chain when chainId 56 was asked for explicitly", async function () {
      expect(await outcome({ ticker: "FOO", provider: "ondo", chainId: 56 })).to.match(/^refused: .*on chain 56/);
    });

    it("refuses to silently return a non-BSC token when no chainId was given", async function () {
      expect(await outcome({ ticker: "FOO", provider: "ondo" })).to.match(/^refused: .*not BSC/);
    });

    it("returns it when that chain is asked for explicitly", async function () {
      expect(await outcome({ ticker: "FOO", provider: "ondo", chainId: 1 })).to.equal("1");
    });
  });

  describe("calldata builders reject bad input instead of emitting broken calldata", function () {
    const build = async (overrides: Record<string, unknown>) => {
      try {
        const { calldata } = await COMMANDS.buildCommitCalldata({ side: "buy", tokenAddress: TOKEN, amountIn: "1000", quotedOut: "5", minOut: "4", ...overrides } as never);
        return calldata as string;
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    };

    it("builds valid calldata for valid input", async function () {
      expect(await build({})).to.match(/^0x[0-9a-f]+$/);
    });

    it("refuses a negative amount", async function () {
      expect(await build({ amountIn: "-5" })).to.match(/^refused: .*uint256 range/);
    });

    it("refuses an amount of 2^256", async function () {
      expect(await build({ amountIn: (2n ** 256n).toString() })).to.match(/^refused: .*uint256 range/);
    });

    it("refuses a JS number that already lost precision", async function () {
      expect(await build({ amountIn: 1234567890123456789 })).to.match(/^refused: .*not an exact integer/);
    });

    it("refuses a ticker where an address belongs", async function () {
      expect(await build({ tokenAddress: "NVDA" })).to.match(/^refused: .*not a 0x-prefixed 20-byte address/);
    });

    it("refuses non-numeric garbage with a clean error, not BigInt()'s raw native SyntaxError", async function () {
      // Red-team follow-up: hex32(n) used to let BigInt(n) throw straight
      // through uncaught on anything that isn't parseable at all -
      // "Cannot convert not-a-number to a BigInt", no exitCode - breaking
      // the clean-refusal contract every other case here relies on.
      const result = await build({ amountIn: "not-a-number" });
      expect(result).to.match(/^refused: .*not a plain decimal integer string/);
      expect(result).to.not.match(/SyntaxError|Cannot convert/);
    });

    it("refuses a hex/binary/octal-prefixed string instead of silently reinterpreting it in the wrong base", async function () {
      // Red-team follow-up: BigInt(string) natively parses 0x/0b/0o-prefixed
      // strings as hex/binary/octal, not decimal - BigInt("0x10") is
      // silently 16n, not a refusal, even though "0x10" isn't the plain
      // decimal string this CLI's own docs say to pass. Confirmed live
      // before this check existed.
      expect(await build({ amountIn: "0x10" })).to.match(/^refused: .*not a plain decimal integer string/);
      expect(await build({ amountIn: "0b101" })).to.match(/^refused: .*not a plain decimal integer string/);
      expect(await build({ amountIn: "0o17" })).to.match(/^refused: .*not a plain decimal integer string/);
    });

    it("refuses booleans and arrays instead of silently coercing them into a made-up amount", async function () {
      // Red-team follow-up: BigInt() coerces far more than "string or
      // number" - true/false, [] and single-element arrays all used to
      // silently become a plausible-looking amount (1, 0, 0, and the
      // element's own value) instead of being refused. Confirmed live
      // before this check existed.
      expect(await build({ amountIn: true })).to.match(/^refused: .*not a number, bigint or a decimal string/);
      expect(await build({ amountIn: false })).to.match(/^refused: .*not a number, bigint or a decimal string/);
      expect(await build({ amountIn: [] })).to.match(/^refused: .*not a number, bigint or a decimal string/);
      expect(await build({ amountIn: [100] })).to.match(/^refused: .*not a number, bigint or a decimal string/);
    });

    it("still accepts a real bigint - encodeUintArray's own internal use of hex32, not just external input", function () {
      // Regression: the type check added just above (typeof n !== "string"
      // && typeof n !== "number") first shipped without "bigint" in the
      // allow-list, breaking compile-mandate's own internal
      // encodeUintArray(arr) => hex32(arr.length) + arr.map(hex32) - a real,
      // legitimate caller that passes bigints, not external input. Caught
      // live by test/skill-cli.live.ts, not this file, because this file
      // had no direct hex32 coverage at all - added here so the fast suite
      // guards it too.
      expect(hex32(5n)).to.equal("0".repeat(63) + "5");
      expect(hex32(0n)).to.equal("0".repeat(64));
    });
  });
});
