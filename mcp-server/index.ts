#!/usr/bin/env node
/**
 * Covenant MCP server — a thin wrapper, not new logic.
 *
 * Every tool here calls straight into functions that already exist and are
 * already tested: skills/covenant-mandate/scripts/cli.mjs (the Wallet
 * Skill's own resolve/check commands and their exported eth_call helpers)
 * and scripts/lib/rwa-status.ts (the oracle updater's live RWA status
 * fetch). This file adds an MCP interface onto Phase 2's work; it does not
 * duplicate or reimplement any of it. See docs/research/competitor-derived-features.md
 * #1 for why this is in scope at all (cheap, reuses the existing core) and
 * PLAN.md's Phase 2 addendum for where it sits in the build.
 *
 * Run standalone:
 *   npx tsx mcp-server/index.ts
 *
 * Register with an MCP client (e.g. Claude Code, Cursor) by pointing it at
 * that same command - see README.md for the exact config block.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { COMMANDS, ethCall, SELECTORS } from "../skills/covenant-mandate/scripts/cli.mjs";
import { fetchAssetMarketStatus, isHalted } from "../scripts/lib/rwa-status.js";

const server = new McpServer({ name: "covenant-mandate", version: "0.1.0" });

const slot = (data: string, i: number) => "0x" + data.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const asBool = (data: string, i: number) => BigInt(slot(data, i)) !== 0n;
const asUint = (data: string, i: number) => BigInt(slot(data, i));

server.registerTool(
  "resolve_ticker",
  {
    title: "Resolve a stock ticker to its exact contract address",
    description:
      "Resolves a bare ticker (e.g. NVDA) to the exact provider-pinned contract address. Refuses to guess when the ticker is ambiguous across providers or chains - returns every candidate found instead so the caller can disambiguate. See skills/covenant-mandate/references/resolve.md for the two real ambiguity axes this guards against.",
    inputSchema: {
      ticker: z.string().describe("Stock ticker, e.g. \"NVDA\""),
      provider: z.enum(["ondo", "xstock", "bstock"]).optional().describe("Restrict to one provider. Required if the ticker is ambiguous across providers."),
      chainId: z.union([z.string(), z.number()]).optional().describe("Restrict to one chain. Defaults to BSC (56) only when that alone disambiguates."),
    },
  },
  async ({ ticker, provider, chainId }) => {
    try {
      const result = await COMMANDS.resolve({ ticker, provider, chainId });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error: any) {
      const payload = error.matches ? { error: error.message, candidates: error.matches } : { error: error.message };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
    }
  },
);

server.registerTool(
  "get_mandate_status",
  {
    title: "Read a Covenant contract's current mandate",
    description:
      "Reads the mandate (active, max notional per trade, max trades per day, expiry) directly from a deployed Covenant contract via eth_call. Read-only, no gas, no signing.",
    inputSchema: {
      rpcUrl: z.string().describe("BSC JSON-RPC endpoint"),
      covenantAddress: z.string().describe("Deployed Covenant contract address"),
    },
  },
  async ({ rpcUrl, covenantAddress }) => {
    const raw = await ethCall(rpcUrl, covenantAddress, SELECTORS.mandate);
    const result = {
      active: asBool(raw, 0),
      maxNotionalPerTrade: asUint(raw, 1).toString(),
      maxTradesPerDay: asUint(raw, 2).toString(),
      expiry: asUint(raw, 3).toString(),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "check_halt",
  {
    title: "Check a token's live trading/halt status",
    description:
      "Fetches the current trading status for a tokenized stock directly from Binance's live RWA asset-market-status endpoint (real-time, not the contract's cached oracle reading - use get_mandate_status/preview_trade for what the contract itself currently believes). See docs/partner-feedback/friction-log.md B15 for where this endpoint was found and confirmed to work for bStocks despite Binance's own skill describing it as Ondo-only.",
    inputSchema: {
      chainId: z.number().default(56).describe("Binance chain ID, defaults to BSC (56)"),
      contractAddress: z.string().describe("Token contract address (from resolve_ticker)"),
    },
  },
  async ({ chainId, contractAddress }) => {
    const status = await fetchAssetMarketStatus(chainId, contractAddress);
    const result = { ...status, halted: isHalted(status) };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "preview_trade",
  {
    title: "Preview whether Covenant would allow a proposed trade",
    description:
      "Reads Covenant's actual on-chain decision for a proposed trade - allowed or denied, and the exact typed reason - before spending a transaction on it. This is necessary, not redundant with contract-call preview: Covenant's guardedSwap never reverts on a denial (it soft-declines and emits an Attestation event instead, see contracts/Covenant.sol), so a wallet-level simulation alone cannot tell allow from deny. Read-only, no gas, no signing.",
    inputSchema: {
      rpcUrl: z.string().describe("BSC JSON-RPC endpoint"),
      covenantAddress: z.string().describe("Deployed Covenant contract address"),
      tokenAddress: z.string().describe("Exact token address to trade (from resolve_ticker)"),
      amountIn: z.union([z.string(), z.number()]).describe("Proposed trade size, in the quote token's smallest unit (wei)"),
    },
  },
  async ({ rpcUrl, covenantAddress, tokenAddress, amountIn }) => {
    const result = await COMMANDS.check({ rpcUrl, covenantAddress, tokenAddress, amountIn });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
