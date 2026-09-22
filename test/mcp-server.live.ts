import { expect } from "chai";
import { spawn, ChildProcess } from "node:child_process";
import { ethers } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import covenantArtifact from "../artifacts/contracts/Covenant.sol/Covenant.json" with { type: "json" };

// Real MCP protocol, real spawned server subprocess, real spawned fork node,
// real deployed contract, real live Binance RWA endpoint - nothing here is
// mocked. The server itself is a thin wrapper (mcp-server/index.ts) around
// already-tested logic (skills/covenant-mandate/scripts/cli.mjs,
// scripts/lib/rwa-status.ts); this suite proves the MCP interface onto that
// logic actually works end to end, the same way a real MCP client would use it.
const RPC_PORT = 8991;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const BSC_FORK_URL = "https://bsc-mainnet.public.blastapi.io";
const FUNDED_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // hardhat node's well-known account #0

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const NVDAB = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"; // real bStocks NVDA
const PANCAKE_V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const BSC_BINANCE_CHAIN_ID = 56;

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`RPC at ${url} did not become ready within ${timeoutMs}ms`);
}

function firstTextResult(result: any): any {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`expected a text content block, got: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

describe("Covenant MCP server (live, real subprocess speaking real MCP protocol)", function () {
  this.timeout(120_000);

  let nodeProcess: ChildProcess;
  let covenantAddress: string;
  let mcpClient: Client;
  let mcpTransport: StdioClientTransport;

  before(async function () {
    nodeProcess = spawn(
      "npx",
      ["hardhat", "node", "--fork", BSC_FORK_URL, "--chain-id", "56", "--port", String(RPC_PORT)],
      { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" },
    );
    await waitForRpc(RPC_URL, 60_000);

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const signer = new ethers.Wallet(FUNDED_PRIVATE_KEY, provider);
    const factory = new ethers.ContractFactory(covenantArtifact.abi, covenantArtifact.bytecode, signer);
    const covenant = await factory.deploy(USDT, PANCAKE_V3_SWAP_ROUTER, signer.address, 900);
    await covenant.waitForDeployment();
    covenantAddress = await covenant.getAddress();

    await (await (covenant as any).setAllowedToken(NVDAB, true)).wait();
    const latest = (await provider.getBlock("latest"))!.timestamp;
    await (await (covenant as any).setMandate(ethers.parseUnits("50", 18), 10n, latest + 30 * 24 * 60 * 60)).wait();
    await (await (covenant as any).updateOracle(NVDAB, false)).wait();

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
    nodeProcess?.kill();
  });

  it("lists exactly the five tools this server is supposed to expose", async function () {
    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).to.deep.equal(["check_halt", "get_mandate_status", "preview_trade", "resolve_ticker", "survey_providers"]);
  });

  describe("survey_providers", function () {
    it("reports a real dead xStock as dead, cross-checked against real on-chain Transfer events", async function () {
      const result = await mcpClient.callTool({ name: "survey_providers", arguments: { ticker: "TSLA" } });
      const payload = firstTextResult(result);
      const xstock = payload.providers.find((p: any) => p.provider === "xstock");
      expect(xstock.status).to.equal("dead");
      expect(xstock.onChainVerified.transferCount).to.equal(0);
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

  it("get_mandate_status reads the real mandate just set on the real deployed contract", async function () {
    const result = await mcpClient.callTool({
      name: "get_mandate_status",
      arguments: { rpcUrl: RPC_URL, covenantAddress },
    });
    const payload = firstTextResult(result);
    expect(payload.active).to.equal(true);
    expect(payload.maxNotionalPerTrade).to.equal(ethers.parseUnits("50", 18).toString());
    expect(payload.maxTradesPerDay).to.equal("10");
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
    it("reports the real allowed decision for an amount within the real mandate", async function () {
      const result = await mcpClient.callTool({
        name: "preview_trade",
        arguments: { rpcUrl: RPC_URL, covenantAddress, tokenAddress: NVDAB, amountIn: ethers.parseUnits("5", 18).toString() },
      });
      const payload = firstTextResult(result);
      expect(payload.decision.allowed).to.equal(true);
      expect(payload.decision.reason).to.equal("None");
    });

    it("reports NotionalExceeded for a real amount above the real mandate cap", async function () {
      const result = await mcpClient.callTool({
        name: "preview_trade",
        arguments: { rpcUrl: RPC_URL, covenantAddress, tokenAddress: NVDAB, amountIn: ethers.parseUnits("999", 18).toString() },
      });
      const payload = firstTextResult(result);
      expect(payload.decision.allowed).to.equal(false);
      expect(payload.decision.reason).to.equal("NotionalExceeded");
    });
  });
});
