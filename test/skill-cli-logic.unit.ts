import { expect } from "chai";
import { ethers } from "ethers";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };
import { COMMANDS } from "../skills/covenant-mandate/scripts/cli.mjs";

// Mutation testing of the skill CLI (flip a comparison, change a default, swap a
// hash) found most of compileMandate's defaults and regexes, resolve's
// disambiguation, survey's verdicts, the bytes32 anchor and the router table
// were only exercised by live suites, or not at all. All of it is pure or
// stub-able, so it is pinned here with no network.
const iface = new ethers.Interface(covenantArtifact.abi);
const TOKEN = "0x" + "aa".repeat(20);
const SENTENCE = "Only AI-chip stocks, at most $1 per trade, 3 trades a day, no weekend premium over 1%.";
const E18 = 10n ** 18n;

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "not refused";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("covenant-mandate skill CLI: compile-mandate (unit, no network)", function () {
  it("compiles the example sentence into exactly the mandate it describes", async function () {
    const now = Math.floor(Date.now() / 1000);
    const r = await COMMANDS.compileMandate({ text: SENTENCE });
    expect(r.theme).to.equal("ai-chips");
    expect(r.tickers).to.deep.equal(["NVDA", "AMD", "AVGO", "ARM", "INTC", "QCOM", "TSM", "MU"]);
    expect([r.maxNotionalUsd, r.maxTradesPerDay, r.slippageBps, r.maxPositionUsd, r.driftBps]).to.deep.equal(["1", "3", 100, "10", 100]);
    expect(r.expiry).to.be.within(now + 30 * 86_400 - 5, now + 30 * 86_400 + 5);

    const [maxNotional, maxTrades, expiry, tokens, slippage, position, drift] = iface.decodeFunctionData("setMandateForTokens", r.calldata);
    expect(maxNotional).to.equal(E18);
    expect(maxTrades).to.equal(3n);
    expect(expiry).to.equal(BigInt(r.expiry));
    expect([...tokens].map((t: string) => t.toLowerCase())).to.deep.equal(r.tokens);
    expect([...slippage]).to.deep.equal(Array(8).fill(100n));
    expect([...position]).to.deep.equal(Array(8).fill(10n * E18));
    expect([...drift]).to.deep.equal(Array(8).fill(100n));
  });

  it("takes every optional part from the text, and honours the duration", async function () {
    const now = Math.floor(Date.now() / 1000);
    const r = await COMMANDS.compileMandate({
      text: "AI chips, at most $0.123456 per trade, 2 trades per day, premium above 0.126%, slippage up to 2.5%, position cap $7.5",
      durationDays: 7,
    });
    expect(r.slippageBps).to.equal(250);
    expect(r.driftBps).to.equal(13); // 12.6 bps rounds to 13, it doesn't truncate to 12
    expect(r.expiry).to.be.within(now + 7 * 86_400 - 5, now + 7 * 86_400 + 5);
    const [maxNotional, , , , , position] = iface.decodeFunctionData("setMandateForTokens", r.calldata);
    expect(maxNotional).to.equal(123_456_000_000_000_000n); // six decimals of a dollar survive
    expect([...position]).to.deep.equal(Array(8).fill((75n * E18) / 10n));
  });

  it("recognises a theme however it is written: plural or not, hyphenated or spaced", async function () {
    for (const phrase of ["AI-chip stocks", "AI chips", "an ai chip basket", "Magnificent 7"]) {
      const r = await COMMANDS.compileMandate({ text: `${phrase}, at most $1 per trade, 1 trade a day, premium over 1%` });
      expect(r.tokens.length, phrase).to.be.greaterThan(0);
    }
  });

  it("allows a bound of exactly 100% and refuses one past it", async function () {
    const base = "AI chips, at most $1 per trade, 3 trades a day";
    expect((await COMMANDS.compileMandate({ text: `${base}, premium over 100%` })).driftBps).to.equal(10_000);
    expect((await COMMANDS.compileMandate({ text: `${base}, premium over 1%, slippage of 100%` })).slippageBps).to.equal(10_000);
    expect(await refusal(() => COMMANDS.compileMandate({ text: `${base}, premium over 100.01%` }))).to.match(/over 100%/);
    expect(await refusal(() => COMMANDS.compileMandate({ text: `${base}, premium over 1%, slippage of 100.01%` }))).to.match(/over 100%/);
  });

  it("reads multi-digit amounts and counts whole, not just their first digit", async function () {
    const r = await COMMANDS.compileMandate({ text: "AI chips, at most $25 per trade, 12 trades a day, premium over 10%" });
    expect([r.maxNotionalUsd, r.maxTradesPerDay, r.driftBps, r.maxPositionUsd]).to.deep.equal(["25", "12", 1000, "250"]);
  });
});

describe("covenant-mandate skill CLI: refusals, encoders and tables (unit, no network)", function () {
  it("a token address must be a string of exactly 20 bytes: an array holding one is refused with the same clear message", async function () {
    const args = { side: "buy" as const, amountIn: "1", quotedOut: "1", minOut: "1" };
    for (const bad of [["0x" + "aa".repeat(20)], 5, null, "0x" + "aa".repeat(21)]) {
      expect(await refusal(() => COMMANDS.buildCommitCalldata({ ...args, tokenAddress: bad as never })), String(bad)).to.match(/not a 0x-prefixed 20-byte address|requires/);
    }
  });

  it("bytes32 values must be exactly 32 bytes: trailing characters are refused, and an omitted ref is 32 zero bytes", async function () {
    const good = "0x" + "ab".repeat(32);
    const args = { side: "buy" as const, tokenAddress: TOKEN, amountIn: "1", quotedOut: "1", minOut: "1" };
    expect(await refusal(() => COMMANDS.buildCommitCalldata({ ...args, quoteRef: good + "ff" }))).to.match(/32-byte/);
    expect(await refusal(() => COMMANDS.buildCommitCalldata({ ...args, quoteRef: good.slice(0, -2) }))).to.match(/32-byte/);
    expect(await refusal(() => COMMANDS.buildSettleCalldata({ decisionId: "1", swapTxHash: good + "0", amountOut: "1", executionMode: "pool" }))).to.match(/32-byte/);
    const omitted = (await COMMANDS.buildCommitCalldata(args)).calldata;
    expect(omitted.endsWith("0".repeat(128))).to.equal(true);
  });

  it("setMandateForTokens refuses arrays of different lengths before building anything", async function () {
    const base = { maxNotionalPerTradeUsd: "1", maxTradesPerDay: "1", expiry: "9999999999", tokens: [TOKEN, TOKEN] };
    expect(await refusal(() => COMMANDS.buildSetMandateForTokensCalldata({ ...base, maxSlippageBpsList: [1, 1], maxPositionUsdList: [1], maxClosedMarketDriftBpsList: [1, 1] }))).to.match(/don't all match/);
    expect(await refusal(() => COMMANDS.buildSetMandateForTokensCalldata({ ...base, maxSlippageBpsList: [1, 1], maxPositionUsdList: [1, 1], maxClosedMarketDriftBpsList: [1] }))).to.match(/don't all match/);
  });

  it("hash-ref is SHA-256, the standard vector included", async function () {
    expect((await COMMANDS.hashRef({ text: "abc" })).ref).to.equal("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("classifies a swap's router: Binance's is an aggregator, PancakeSwap V3's a pool, anything else unknown, never rfq", async function () {
    const mode = async (to: string) => (await COMMANDS.classifyExecutionMode({ to })).executionMode;
    expect(await mode("0xB300000b72DEAEb607a12d5f54773d1c19c7028d")).to.equal("aggregator");
    expect(await mode("0x1b81D678ffb9C0263b24A97847620C99d213eB14")).to.equal("pool");
    expect(await mode("0x" + "12".repeat(20))).to.equal("unknown");
    expect(await refusal(() => COMMANDS.classifyExecutionMode({ to: "" }))).to.match(/requires/);
  });

  it("execution modes encode as the contract's enum: unknown 0, pool 1, rfq 2, aggregator 3", async function () {
    const swap = "0x" + "11".repeat(32);
    for (const [name, index] of Object.entries({ unknown: 0, pool: 1, rfq: 2, aggregator: 3 })) {
      const { calldata } = await COMMANDS.buildSettleCalldata({ decisionId: "1", swapTxHash: swap, amountOut: "5", executionMode: name as never });
      expect(iface.decodeFunctionData("settle", calldata)[3]).to.equal(BigInt(index));
    }
  });
});

describe("covenant-mandate skill CLI: resolve, survey and HTTP handling against a stubbed network (unit)", function () {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const stubFetch = (handler: (url: string, init?: { method?: string; body?: string }) => { status?: number; body: unknown }) => {
    globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const { status = 200, body } = handler(String(url), init);
      return { status, ok: status < 400, json: async () => body };
    }) as unknown as typeof fetch;
  };
  const listing = (ticker: string, type: number, chainId: string, addr: string) => ({ ticker, symbol: `${ticker}${type}`, type, chainId, contractAddress: addr });

  it("with no chain given, picks the BSC listing out of several chains, and refuses when BSC itself is ambiguous", async function () {
    const A = "0x" + "01".repeat(20), B = "0x" + "02".repeat(20), C = "0x" + "03".repeat(20);
    stubFetch(() => ({ body: { data: [listing("FOO", 1, "1", A), listing("FOO", 1, "56", B), listing("FOO", 1, "101", C)] } }));
    expect((await COMMANDS.resolve({ ticker: "FOO", provider: "ondo" })).resolved.contractAddress).to.equal(B);
    stubFetch(() => ({ body: { data: [listing("FOO", 1, "1", A), listing("FOO", 1, "56", B), listing("FOO", 1, "56", C)] } }));
    expect(await refusal(() => COMMANDS.resolve({ ticker: "FOO", provider: "ondo" }))).to.match(/ambiguous across chains/);
  });

  it("refuses a ticker that two providers list, even on the same chain", async function () {
    stubFetch(() => ({ body: { data: [listing("BAR", 1, "56", "0x" + "01".repeat(20)), listing("BAR", 3, "56", "0x" + "02".repeat(20))] } }));
    expect(await refusal(() => COMMANDS.resolve({ ticker: "BAR" }))).to.match(/ambiguous across providers/);
  });

  it("survey: no transfers is dead, a few is live, and an RPC that never answers is unknown, not dead", async function () {
    const ADDR = { dead: "0x" + "d0".repeat(20), live: "0x" + "d1".repeat(20), unknown: "0x" + "d2".repeat(20) };
    const perCall: Record<string, number | "error"> = { [ADDR.dead]: 0, [ADDR.live]: 1, [ADDR.unknown]: "error" };
    stubFetch((url, init) => {
      if (url.includes("stock/detail/list")) {
        return { body: { data: [listing("BAZ", 1, "56", ADDR.dead), listing("BAZ", 2, "56", ADDR.live), listing("BAZ", 3, "56", ADDR.unknown)] } };
      }
      if (url.includes("rwa/dynamic")) return { body: { data: { tokenInfo: { price: "1", volume24h: "999" } } } };
      const rpc = JSON.parse(init!.body!);
      if (rpc.method === "eth_blockNumber") return { body: { jsonrpc: "2.0", id: 1, result: "0x100000" } };
      const n = perCall[rpc.params[0].address];
      if (n === "error") return { body: { jsonrpc: "2.0", id: 1, error: { message: "rate limited" } } };
      return { body: { jsonrpc: "2.0", id: 1, result: Array(n).fill({}) } };
    });
    const byProvider = Object.fromEntries((await COMMANDS.survey({ ticker: "BAZ" })).providers.map((p: any) => [p.provider, p]));
    expect(byProvider.ondo.status).to.equal("dead");
    expect(byProvider.ondo.onChainVerified.transferCount).to.equal(0);
    expect(byProvider.xstock.status).to.equal("live");
    expect(byProvider.xstock.onChainVerified.transferCount).to.equal(3); // one per 5,000-block range, three ranges
    expect(byProvider.xstock.onChainVerified.blocksScanned).to.equal(15_000);
    expect(byProvider.bstock.status).to.match(/^unknown/);
    // what Binance reports is shown, labelled, and not what decides the status
    expect(byProvider.ondo.binanceReported.volume24h).to.equal("999");
  });

  it("call() treats any HTTP error status as an error, including a 404", async function () {
    stubFetch(() => ({ status: 404, body: { message: "not found" } }));
    const { call } = await import("../skills/covenant-mandate/scripts/cli.mjs");
    let caught: any;
    try {
      await call({ url: "http://example.test" });
    } catch (e) {
      caught = e;
    }
    expect(caught?.message).to.equal("HTTP 404");
    expect(caught?.exitCode).to.equal(1);
    expect(caught?.body).to.deep.equal({ message: "not found" });
  });
});
