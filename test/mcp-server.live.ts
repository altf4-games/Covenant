import { expect } from "chai";
import { ethers } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startForkNode, setupCovenant, buyAt, isWeb3ApiGeoBlocked } from "../scripts/lib/local-fork.js";

// Real MCP protocol, real spawned server subprocess, real spawned fork node,
// real deployed contract (via the real deploy script), real live Binance
// endpoints - nothing here is mocked. The server is a thin wrapper
// (mcp-server/index.ts) around already-tested logic; this suite proves the
// MCP interface onto it works end to end, the way a real client uses it.
const RPC_PORT = 8991;
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real bStocks NVDA
const BSC_BINANCE_CHAIN_ID = 56;
const E18 = 10n ** 18n;

function firstTextResult(result: any): any {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`expected a text content block, got: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

describe("Covenant MCP server (live, real subprocess speaking real MCP protocol)", function () {
  this.timeout(120_000);

  let node: Awaited<ReturnType<typeof startForkNode>>;
  let env: Awaited<ReturnType<typeof setupCovenant>>;
  let RPC_URL: string;
  let covenantAddress: string;
  let mcpClient: Client;
  let mcpTransport: StdioClientTransport;

  before(async function () {
    node = await startForkNode(RPC_PORT);
    RPC_URL = node.rpcUrl;
    try {
      env = await setupCovenant(RPC_URL, { maxNotionalUsd: "50" });
    } catch (err) {
      if (isWeb3ApiGeoBlocked(err)) return this.skip();
      throw err;
    }
    covenantAddress = env.covenantAddress;

    mcpTransport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "mcp-server/index.ts"],
      cwd: new URL("..", import.meta.url).pathname,
    });
    mcpClient = new Client({ name: "covenant-mcp-test-client", version: "1.0.0" });
    await mcpClient.connect(mcpTransport);
  });

  after(async function () {
    await mcpClient?.close();
    node?.stop();
  });

  it("lists exactly the five tools this server is supposed to expose", async function () {
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).to.deep.equal(["check_halt", "get_mandate_status", "preview_trade", "resolve_ticker", "survey_providers"]);
  });

  describe("survey_providers", function () {
    it("shows a real, nearly-idle xStock as a sliver of its bStock's on-chain activity", async function () {
      const result = await mcpClient.callTool({ name: "survey_providers", arguments: { ticker: "TSLA" } });
      const payload = firstTextResult(result);
      const xstock = payload.providers.find((p: any) => p.provider === "xstock");
      const bstock = payload.providers.find((p: any) => p.provider === "bstock");
      expect(xstock.onChainVerified.transferCount).to.be.lessThan(bstock.onChainVerified.transferCount / 10);
    });
  });

  describe("resolve_ticker", function () {
    it("refuses to guess a real ambiguous ticker (NVDA, no provider given)", async function () {
      const result = await mcpClient.callTool({ name: "resolve_ticker", arguments: { ticker: "NVDA" } });
      expect((result as any).isError).to.equal(true);
      const payload = firstTextResult(result);
      expect(payload.candidates.length).to.be.greaterThan(1);
    });

    it("resolves DRAM to the real bStock address when the provider is given", async function () {
      const result = await mcpClient.callTool({ name: "resolve_ticker", arguments: { ticker: "DRAM", provider: "bstock" } });
      const payload = firstTextResult(result);
      expect(payload.resolved.contractAddress.toLowerCase()).to.equal("0x93862d63fd9fd488b1328e9b47717d75e994a84b");
    });
  });

  it("refuses a malformed address or a non-http RPC URL at the boundary, before any network call", async function () {
    for (const args of [
      { rpcUrl: RPC_URL, covenantAddress: "0x123" },
      { rpcUrl: "file:///etc/passwd", covenantAddress },
      { rpcUrl: "not a url", covenantAddress },
    ]) {
      let refused = false;
      try {
        const result = await mcpClient.callTool({ name: "get_mandate_status", arguments: args });
        refused = (result as any).isError === true;
      } catch {
        refused = true;
      }
      expect(refused, JSON.stringify(args)).to.equal(true);
    }
  });

  it("get_mandate_status reads the real mandate just set on the real deployed contract", async function () {
    const result = await mcpClient.callTool({
      name: "get_mandate_status",
      arguments: { rpcUrl: RPC_URL, covenantAddress },
    });
    const payload = firstTextResult(result);
    expect(payload.active).to.equal(true);
    expect(payload.maxNotionalPerTradeUsd).to.equal(ethers.parseUnits("50", 18).toString());
    expect(payload.maxTradesPerDay).to.equal("10");
    expect(payload.tradesUsedToday).to.equal("0");
    expect(payload.decisionOpen).to.equal(false);
    expect(payload.agent.toLowerCase()).to.equal(env.agentAddress.toLowerCase());
    // Red-team H7: disabled by default on a fresh deploy (setupCovenant
    // doesn't set it), so both read back as zero here.
    expect(payload.maxDailyNotionalUsd).to.equal("0");
    expect(payload.notionalUsedToday).to.equal("0");
  });

  it("check_halt reads real, live status from Binance for real NVDAB", async function () {
    const result = await mcpClient.callTool({
      name: "check_halt",
      arguments: { chainId: BSC_BINANCE_CHAIN_ID, contractAddress: NVDAB },
    });
    const payload = firstTextResult(result);
    expect(payload).to.have.property("reasonCode");
    expect(payload).to.have.property("halted");
    expect(typeof payload.halted).to.equal("boolean");
  });

  describe("preview_trade", function () {
    it("reports the real allowed decision for a $5 buy at the live price", async function () {
      const a = buyAt(env.livePrice, 5n * E18);
      const result = await mcpClient.callTool({
        name: "preview_trade",
        arguments: { rpcUrl: RPC_URL, covenantAddress, side: "buy", tokenAddress: NVDAB, amountIn: a.amountIn.toString(), quotedOut: a.quotedOut.toString(), minOut: a.minOut.toString() },
      });
      const payload = firstTextResult(result);
      expect(payload.decision.allowed).to.equal(true);
      expect(payload.decision.reason).to.equal("None");
    });

    it("reports NotionalExceeded for a real amount above the real mandate cap", async function () {
      const a = buyAt(env.livePrice, 999n * E18);
      const result = await mcpClient.callTool({
        name: "preview_trade",
        arguments: { rpcUrl: RPC_URL, covenantAddress, side: "buy", tokenAddress: NVDAB, amountIn: a.amountIn.toString(), quotedOut: a.quotedOut.toString(), minOut: a.minOut.toString() },
      });
      const payload = firstTextResult(result);
      expect(payload.decision.allowed).to.equal(false);
      expect(payload.decision.reason).to.equal("NotionalExceeded");
    });
  });
});
