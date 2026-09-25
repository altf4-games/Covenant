// Shared logic between status-page/index.html and its live test
// (test/status-page.live.ts). No DOM dependency, so it runs in Node too.

export const ABI = [
  "function mandate() view returns (bool active, uint256 maxNotionalPerTradeUsd, uint256 maxTradesPerDay, uint256 expiry)",
  "function tradesUsedToday() view returns (uint256)",
  "function stalenessBound() view returns (uint256)",
  "function decisionTtl() view returns (uint256)",
  "function agent() view returns (address)",
  "function hasOpenDecision() view returns (bool)",
  // Red-team H7: separate from the Mandate struct on purpose - see Covenant.sol.
  "function maxDailyNotionalUsd() view returns (uint256)",
  "function notionalUsedToday() view returns (uint256)",
  // Red-team H11: the last four fields are the mandate/oracle snapshot in
  // force at commit time, added so a decision is provable without replaying
  // MandateSet/OracleUpdated history.
  "event DecisionCommitted(uint256 indexed id, address indexed token, uint8 side, bool allowed, uint8 reason, uint256 amountIn, uint256 quotedOut, uint256 minOut, bytes32 quoteRef, bytes32 researchRef, uint64 expiresAt, uint256 mandateMaxNotionalPerTradeUsd, uint256 mandateMaxTradesPerDay, uint256 mandateExpiry, uint256 oracleUpdatedAt)",
  "event DecisionSettled(uint256 indexed id, bytes32 indexed swapTxHash, uint256 amountOut, uint8 executionMode, bool belowMin)",
  "event DecisionCancelled(uint256 indexed id)",
];

// Mirrors Covenant.DenialReason, in order.
export const DENIAL_REASONS = [
  "None", "MandateInactive", "MandateExpired", "TokenNotAllowed",
  "NotionalExceeded", "DailyLimitExceeded", "OracleStale", "OracleHalted",
  "SlippageTooLoose", "PositionLimit", "DecisionOpen", "ClosedMarketDrift",
  "DailyNotionalExceeded",
];
export const SIDES = ["buy", "sell"];
export const EXECUTION_MODES = ["unknown", "pool", "rfq", "aggregator"];

export const DEFAULT_LOOKBACK_BLOCKS = 500;
export const DEFAULT_LOGS_TIMEOUT_MS = 8_000;

// Real bStock names, for the plain-English decision feed - the same 14
// tickers curated in skills/covenant-mandate/scripts/theme-map.json (real
// BSC addresses, verified live against Binance's RWA token list,
// 2026-09-25), duplicated here rather than imported so this file keeps
// working with a plain relative-path <script type="module"> import in the
// browser, no bundler or JSON-import-assertion support required.
export const TOKEN_NAMES = {
  "0x02fca66c1d1afb4e2a7884261eb00f63598a7436": "NVIDIA (NVDAB)",
  "0x75fd4cf6f8392e41e70391d60c90c0d5211603a1": "AMD (AMDB)",
  "0x76682c454467b3a1150ad8b6a92fc5ee2c21d7ed": "Broadcom (AVGOB)",
  "0xd42a79ebb7f527f40faecd196ffb47ad5e8d6f8c": "Arm (ARMB)",
  "0xe614e2fc6c787035ff51f452e8e826bfd32d5283": "Intel (INTCB)",
  "0x5f7a56e877b9130608bf8be962621011182fefe1": "Qualcomm (QCOMB)",
  "0xab78b89b5bb00236be0b4b20704cbfa04efc711c": "TSMC (TSMB)",
  "0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699": "Micron (MUB)",
  "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a": "Apple (AAPLB)",
  "0x80106cb3ead06659a5ad19df39d9b4733863b9b0": "Microsoft (MSFTB)",
  "0x3f53de71c126bdabae20f9cd64848d317f6c3238": "Alphabet (GOOGLB)",
  "0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00": "Amazon (AMZNB)",
  "0x7425889fe94f9d693e8daefe88bcced6acfef4c0": "Meta (METAB)",
  "0x5b1910eaad6450e50f816082aa078c41f10c292f": "Tesla (TSLAB)",
};

/** Real name if known, else a truncated address - never a raw full address in a sentence. */
export function tokenName(address) {
  return TOKEN_NAMES[address.toLowerCase()] ?? (address.slice(0, 6) + "…" + address.slice(-4));
}

/**
 * A plain-English decision feed: "Denied: NVIDIA's market is halted" instead
 * of a hex reason index, and USD/token names instead of wei and addresses.
 * `fmtAmount` is injected (rather than imported from ethers here) so this
 * function stays usable in a plain Node test without pulling ethers in.
 */
export function describeDecision(d, fmtAmount) {
  const c = d.commit;
  if (!c) return `Decision #${d.id}: settled, but its commit falls outside the scanned block range.`;

  const name = tokenName(c.token);
  const spendLabel = c.side === "buy" ? "USDT" : name;
  const verb = c.side === "buy" ? "Buy" : "Sell";
  const base = `${verb} order: spend ${fmtAmount(c.amountIn)} ${spendLabel} for ${name}`;

  if (!c.allowed) return `${base} — denied: ${c.reason}.`;
  if (d.cancelled) return `${base} — allowed, then abandoned without trading.`;
  if (d.settle) {
    const receiveLabel = c.side === "buy" ? name : "USDT";
    const belowNote = d.settle.belowMin ? " (below the minimum accepted)" : "";
    return `${base} — filled, received ${fmtAmount(d.settle.amountOut)} ${receiveLabel} via ${d.settle.executionMode}${belowNote}.`;
  }
  return `${base} — allowed, awaiting settlement.`;
}

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
        // Red-team H11: the mandate/oracle snapshot in force at commit time.
        mandateMaxNotionalPerTradeUsd: args.mandateMaxNotionalPerTradeUsd,
        mandateMaxTradesPerDay: args.mandateMaxTradesPerDay,
        mandateExpiry: Number(args.mandateExpiry),
        oracleUpdatedAt: Number(args.oracleUpdatedAt),
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
