// Shared logic between status-page/index.html and its live test
// (test/status-page.live.ts). No DOM dependency, so it runs in Node too.

export const ABI = [
  "function mandate() view returns (bool active, uint256 maxNotionalPerTradeUsd, uint256 maxTradesPerDay, uint256 expiry)",
  "function tradesUsedToday() view returns (uint256)",
  "function stalenessBound() view returns (uint256)",
  "function decisionTtl() view returns (uint256)",
  "function agent() view returns (address)",
  "function hasOpenDecision() view returns (bool)",
  "event DecisionCommitted(uint256 indexed id, address indexed token, uint8 side, bool allowed, uint8 reason, uint256 amountIn, uint256 quotedOut, uint256 minOut, bytes32 quoteRef, bytes32 researchRef, uint64 expiresAt)",
  "event DecisionSettled(uint256 indexed id, bytes32 indexed swapTxHash, uint256 amountOut, uint8 executionMode, bool belowMin)",
  "event DecisionCancelled(uint256 indexed id)",
];

// Mirrors Covenant.DenialReason, in order.
export const DENIAL_REASONS = [
  "None", "MandateInactive", "MandateExpired", "TokenNotAllowed",
  "NotionalExceeded", "DailyLimitExceeded", "OracleStale", "OracleHalted",
  "SlippageTooLoose", "PositionLimit", "DecisionOpen",
];
export const SIDES = ["buy", "sell"];
export const EXECUTION_MODES = ["unknown", "pool", "rfq", "aggregator"];

export const DEFAULT_LOOKBACK_BLOCKS = 500;
export const DEFAULT_LOGS_TIMEOUT_MS = 8_000;

/**
 * Reads all of Covenant's decision events in one eth_getLogs call, bounded
 * by a client-side timeout.
 *
 * The timeout exists because of a real Hardhat bug: against a forked RPC
 * (`hardhat node --fork`), eth_getLogs hangs forever, with no error, as
 * soon as the range includes a block from before the fork point
 * (docs/partner-feedback/friction-log.md B16). ethers has no per-call
 * timeout, so the call is raced against one that fails with an explanation
 * instead of leaving the page spinning.
 *
 * @param {import("ethers").Contract} covenant
 * @param {{fromBlock: number, toBlock?: number | "latest", timeoutMs?: number}} options
 * @returns {Promise<import("ethers").EventLog[]>}
 */
export async function fetchDecisionEvents(covenant, { fromBlock, toBlock = "latest", timeoutMs = DEFAULT_LOGS_TIMEOUT_MS }) {
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
    const events = await Promise.race([covenant.queryFilter("*", fromBlock, toBlock), timeout]);
    const wanted = new Set(["DecisionCommitted", "DecisionSettled", "DecisionCancelled"]);
    return events.filter((e) => wanted.has(e.fragment?.name ?? e.eventName));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Joins commit, settle and cancel events into one record per decision id,
 * oldest first. A decision whose commit falls outside the scanned range but
 * whose settle falls inside it is kept, with `commit: null`.
 */
export function joinDecisions(events) {
  const byId = new Map();
  const get = (id) => {
    const key = id.toString();
    if (!byId.has(key)) byId.set(key, { id: key, commit: null, settle: null, cancelled: false });
    return byId.get(key);
  };
  for (const e of events) {
    const name = e.fragment?.name ?? e.eventName;
    const args = e.args;
    if (name === "DecisionCommitted") {
      get(args.id).commit = {
        token: args.token,
        side: SIDES[Number(args.side)] ?? "unknown",
        allowed: args.allowed,
        reason: DENIAL_REASONS[Number(args.reason)] ?? `unknown(${args.reason})`,
        amountIn: args.amountIn,
        quotedOut: args.quotedOut,
        minOut: args.minOut,
        expiresAt: Number(args.expiresAt),
        blockNumber: e.blockNumber,
        txHash: e.transactionHash,
      };
    } else if (name === "DecisionSettled") {
      get(args.id).settle = {
        swapTxHash: args.swapTxHash,
        amountOut: args.amountOut,
        executionMode: EXECUTION_MODES[Number(args.executionMode)] ?? "unknown",
        belowMin: args.belowMin,
        txHash: e.transactionHash,
      };
    } else if (name === "DecisionCancelled") {
      get(args.id).cancelled = true;
    }
  }
  return [...byId.values()].sort((x, y) => Number(BigInt(x.id) - BigInt(y.id)));
}

export function resolveFromBlock(explicitFromBlock, latestBlock) {
  if (explicitFromBlock !== undefined && explicitFromBlock !== null && explicitFromBlock !== "") {
    return Number(explicitFromBlock);
  }
  return Math.max(0, latestBlock - DEFAULT_LOOKBACK_BLOCKS);
}
