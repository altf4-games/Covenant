// Shared logic between status-page/index.html and its live test
// (test/status-page.live.ts) - deliberately has no DOM dependency so it can
// be imported and exercised directly in Node, the same pattern already used
// for skills/covenant-mandate/scripts/cli.mjs and test/skill-cli.live.ts.

export const ABI = [
  "function mandate() view returns (bool active, uint256 maxNotionalPerTrade, uint256 maxTradesPerDay, uint256 expiry)",
  "function tradesUsedToday() view returns (uint256)",
  "function stalenessBound() view returns (uint256)",
  "event Attestation(address indexed caller, address indexed tokenOut, uint256 amountIn, uint256 amountOut, bool allowed, uint8 reason)",
];

export const DENIAL_REASONS = [
  "None", "MandateInactive", "MandateExpired", "TokenNotAllowed",
  "NotionalExceeded", "DailyLimitExceeded", "OracleStale", "OracleHalted",
];

export const DEFAULT_LOOKBACK_BLOCKS = 500;
export const DEFAULT_LOGS_TIMEOUT_MS = 8_000;

/**
 * Reads Attestation events, bounded by a real client-side timeout.
 *
 * This exists because of a genuine Hardhat bug, not a hypothetical one:
 * against a *forked* RPC (`hardhat node --fork`), `eth_getLogs` hangs
 * indefinitely - no error, no timeout - the instant the queried range
 * includes even one block from before the fork point (confirmed live,
 * millisecond-precise boundary, docs/partner-feedback/friction-log.md B16).
 * ethers/ethers.js has no built-in per-call timeout for this, and we can't
 * fix Hardhat's fork provider from here, so the only real fix available is
 * to race the call against our own timeout and fail loudly with a message
 * that actually explains what's going on, instead of a UI that just spins
 * forever with zero feedback - which is what this page did before this was
 * added, confirmed by getting stuck on it live.
 *
 * @param {import("ethers").Contract} covenant
 * @param {{fromBlock: number, toBlock?: number | "latest", timeoutMs?: number}} options
 * @returns {Promise<import("ethers").EventLog[]>}
 */
export async function fetchAttestations(covenant, { fromBlock, toBlock = "latest", timeoutMs = DEFAULT_LOGS_TIMEOUT_MS }) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `eth_getLogs timed out after ${timeoutMs}ms. If this RPC is a forked node ` +
            `(e.g. "hardhat node --fork"), this almost always means fromBlock=${fromBlock} ` +
            `is before the fork's own starting block - Hardhat's fork provider hangs ` +
            `instead of erroring in that case. Pass a fromBlock at or after the actual ` +
            `fork/deployment block. See docs/partner-feedback/friction-log.md B16.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([covenant.queryFilter(covenant.filters.Attestation(), fromBlock, toBlock), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function resolveFromBlock(explicitFromBlock, latestBlock) {
  if (explicitFromBlock !== undefined && explicitFromBlock !== null && explicitFromBlock !== "") {
    return Number(explicitFromBlock);
  }
  return Math.max(0, latestBlock - DEFAULT_LOOKBACK_BLOCKS);
}
