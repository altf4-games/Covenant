/**
 * Continuous off-hours logging (Phase 2 addendum #5,
 * docs/research/competitor-derived-features.md).
 *
 * Appends one real JSON line to data/off-hours-log.jsonl every time it's
 * run, covering real NVDA across all three providers at once (bstock,
 * ondo, xstock) - halt/market status, and on-chain price vs. the
 * provider's own reported "reference" price where one exists (see
 * friction-log.md B6: that field is null for bStocks, real for Ondo).
 * Run this on a schedule (5 minutes, matching the pace this idea was
 * borrowed from) and it turns "checked once on a Sunday" into a genuine
 * time series covering market open, close, and the gap in between - the
 * Dev Experience Report explicitly asks for "off-hours behavior" as
 * observed data, not a one-off spot check.
 *
 * Usage: npx tsx scripts/off-hours-logger.ts
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchAssetMarketStatus, isHalted } from "./lib/rwa-status.js";
import { fetchDynamic } from "../skills/covenant-mandate/scripts/cli.mjs";

const DEFAULT_LOG_PATH = new URL("../data/off-hours-log.jsonl", import.meta.url).pathname;
// A function, not a module-level constant: resolved at call time, not import
// time. A `const` here would read process.env.OFF_HOURS_LOG_PATH once, at
// the moment this module is first imported - too early for a test to
// redirect it by setting the env var in a `before` hook, since ES module
// imports are evaluated before any test code runs. Caught writing the live
// test for this file, before it ever got a chance to clobber the real log.
function resolveLogPath(): string {
  return process.env.OFF_HOURS_LOG_PATH || DEFAULT_LOG_PATH;
}

const BSC_BINANCE_CHAIN_ID = 56;

// Real NVDA across all three providers, verified in docs/research/verified-facts.md
// and re-verified live in skills/covenant-mandate/scripts/cli.mjs's own tests.
const TRACKED_TOKENS: Array<{ symbol: string; provider: "bstock" | "ondo" | "xstock"; contractAddress: string }> = [
  { symbol: "NVDAB", provider: "bstock", contractAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436" },
  { symbol: "NVDAon", provider: "ondo", contractAddress: "0xa9ee28c80f960b889dfbd1902055218cba016f75" },
  { symbol: "NVDAx", provider: "xstock", contractAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d" },
];

export async function pollToken(token: (typeof TRACKED_TOKENS)[number]) {
  const [status, dynamic] = await Promise.all([
    fetchAssetMarketStatus(BSC_BINANCE_CHAIN_ID, token.contractAddress).catch((error: Error) => ({ error: error.message })),
    fetchDynamic(BSC_BINANCE_CHAIN_ID, token.contractAddress),
  ]);

  if ("error" in status) {
    return { symbol: token.symbol, provider: token.provider, error: status.error };
  }

  return {
    symbol: token.symbol,
    provider: token.provider,
    openState: status.openState,
    reasonCode: status.reasonCode,
    halted: isHalted(status),
    onChainPrice: dynamic?.tokenInfo?.price ?? null,
    referencePrice: dynamic?.stockInfo?.price ?? null,
    binanceReportedVolume24h: dynamic?.tokenInfo?.volume24h ?? null,
  };
}

export async function logOnePoll() {
  const polledAt = new Date().toISOString();
  const tokens = await Promise.all(TRACKED_TOKENS.map(pollToken));
  const entry = { polledAt, tokens };
  const logPath = resolveLogPath();

  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");

  return entry;
}

export { TRACKED_TOKENS, resolveLogPath };

if (import.meta.url === `file://${process.argv[1]}`) {
  logOnePoll()
    .then((entry) => {
      console.log(`[${entry.polledAt}] logged ${entry.tokens.length} tokens to ${resolveLogPath()}`);
      for (const t of entry.tokens) {
        if ("error" in t) {
          console.log(`  ${t.symbol} (${t.provider}): ERROR - ${t.error}`);
        } else {
          console.log(`  ${t.symbol} (${t.provider}): open=${t.openState} reason=${t.reasonCode} halted=${t.halted} onChain=${t.onChainPrice} reference=${t.referencePrice}`);
        }
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
