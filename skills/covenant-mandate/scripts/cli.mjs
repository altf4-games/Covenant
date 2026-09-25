#!/usr/bin/env node
// covenant-mandate CLI — self-contained, zero-dep, Node >= 22
// Usage: node cli.mjs <command> '<json_params>'
//
// Commands:
//   resolve                ticker -> exact contract address, refuses to guess across providers
//   survey                 ticker -> BSC listing + real tradability for all three providers at once,
//                          including any provider that isn't listed on BSC or is listed but dead
//   check                  read Covenant's mandate/token/oracle state and the decision `commit`
//                          would make right now, via previewDecision - read-only
//   build-commit-calldata  ABI-encode commit(...), for `baw contract-call preview --inputData`
//   build-settle-calldata  ABI-encode settle(...), after the real swap has landed
//   build-cancel-calldata  ABI-encode cancel(...), to abandon an approved decision
//   hash-ref               SHA-256 of a raw response, for commit's quoteRef/researchRef
//   compile-mandate         plain-English mandate text -> resolved tokens, a human summary,
//                          and one setMandateForTokens calldata (Feature 2, redesigned - see
//                          docs/partner-feedback/friction-log.md A10 for why this reads a
//                          small local theme-map.json instead of a live RWA sector filter)
//   build-set-mandate-for-tokens-calldata  ABI-encode setMandateForTokens(...) directly
//   classify-execution-mode  swap tx `to` address -> aggregator/pool/unknown for settle,
//                          never guesses rfq specifically (see KNOWN_ROUTERS below)
//
// Why `check` exists: Covenant's `commit` never reverts on a denial (see
// contracts/Covenant.sol) - it records the refusal as an event instead. So
// `baw contract-call preview` simulates a successful call whether the trade
// would be allowed or denied. Reading previewDecision first tells you the
// real answer before spending a transaction on it.

// ---- inline HTTP helper (self-contained, zero dependency) ----
const TIMEOUT_MS = 10_000;
const UA = { "Accept-Encoding": "identity", "User-Agent": "binance-web3/1.1 (Skill)" };

async function call({ url, method = "GET", body, headers = {} }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const opts = { method, headers: { ...UA, ...headers }, signal: ctrl.signal };
  if (method === "POST") {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body || {});
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    clearTimeout(timer);
    throw Object.assign(new Error("Network request failed"), { exitCode: 3 });
  }
  clearTimeout(timer);
  const data = await res.json();
  if (res.status >= 400) throw Object.assign(new Error(`HTTP ${res.status}`), { exitCode: 1, body: data });
  return data;
}

// ---- minimal ABI encode/decode for exactly the calls this skill makes ----
// Selectors below were computed once with ethers (keccak256 of the function
// signature) and verified against the real deployed contract on a BSC fork
// via a raw eth_call that was cross-checked against ethers' own typed call -
// see the commit history for the verification script. Hardcoded here rather
// than computed at runtime because Node's built-in crypto module has no
// Keccak-256 (only NIST SHA3, which differs), so computing them zero-dep
// would mean shipping a hand-rolled hash implementation - a worse tradeoff
// than a documented, verified constant.
const SELECTORS = {
  previewDecision: "0xa40ecbbc", // previewDecision(uint8,address,uint256,uint256,uint256)
  commit: "0x9009cb23", // commit(uint8,address,uint256,uint256,uint256,bytes32,bytes32)
  settle: "0x4d205d19", // settle(uint256,bytes32,uint256,uint8)
  cancel: "0x40e58ee5", // cancel(uint256)
  mandate: "0x39b1b96d", // mandate()
  tokenConfig: "0xfe136c4e", // tokenConfig(address)
  oracleStatus: "0xe863f6a7", // oracleStatus(address)
  openDecisionId: "0xb9975ad2", // openDecisionId()
  hasOpenDecision: "0x47ca1608", // hasOpenDecision()
  tradesUsedToday: "0x673009a9", // tradesUsedToday()
  agent: "0xf5ff5c76", // agent()
  // Red-team H7.
  maxDailyNotionalUsd: "0x5b8f6f8e", // maxDailyNotionalUsd()
  notionalUsedToday: "0x96ae41f0", // notionalUsedToday()
  setMaxDailyNotionalUsd: "0x884dc5bf", // setMaxDailyNotionalUsd(uint256)
  // Feature 2 (redesigned, friction-log A10).
  setMandateForTokens: "0xc0139456", // setMandateForTokens(uint256,uint256,uint256,address[],uint16[],uint256[],uint16[])
};

// Mirrors Covenant.DenialReason, in order. Append-only on the contract side.
const DENIAL_REASONS = [
  "None",
  "MandateInactive",
  "MandateExpired",
  "TokenNotAllowed",
  "NotionalExceeded",
  "DailyLimitExceeded",
  "OracleStale",
  "OracleHalted",
  "SlippageTooLoose",
  "PositionLimit",
  "DecisionOpen",
  "ClosedMarketDrift",
  "DailyNotionalExceeded",
];

const SIDES = { buy: 0, sell: 1 };
const EXECUTION_MODES = { unknown: 0, pool: 1, rfq: 2, aggregator: 3 };

// ---- execution-mode classification, for settle's executionMode field ----
// Neither `baw market-order quote` nor `market-order list` carries a field
// saying whether a fill was RFQ or pool (checked against the real raw JSON
// in docs/evidence/day1-gate-{quote,swap}.json - despite mentor guidance in
// docs/research/opus-2026-09-24/c-predecessors-and-sponsor-intent.md saying
// to "read the execution-mode field on every response", no such field is
// actually present in a real response). The only real signal available is
// the swap transaction's `to` address, and that signal only goes so far:
// Binance's own router settles both RFQ and pool fills through the same
// address (the Day-1 real swap did, with multiple intermediate hops -
// docs/evidence/day1-gate-swap.json), so a route through it is recorded as
// `aggregator`, never guessed as `rfq` or `pool` specifically (this rule
// was already correct in skills/covenant-mandate/references/loop.md before
// this function existed - this just makes it code instead of only prose).
// A route through a known direct-DEX router (PancakeSwap V3, used directly
// in test/Covenant.fork.ts and scripts/chaos-fork.ts, since there's no
// Binance backend on a fork) is unambiguous: `pool`. Anything else: `unknown`.
const KNOWN_ROUTERS = {
  "0xb300000b72deaeb607a12d5f54773d1c19c7028d": "aggregator", // Binance's router, real Day-1 fill
  "0x1b81d678ffb9c0263b24a97847620c99d213eb14": "pool", // PancakeSwap V3 SwapRouter
};

/** { to } -> "aggregator" | "pool" | "unknown". Never returns "rfq" - see comment above. */
function classifyExecutionMode({ to }) {
  if (!to) return "unknown";
  return KNOWN_ROUTERS[String(to).toLowerCase()] ?? "unknown";
}

/** A 0x-prefixed 32-byte hex value, or 32 zero bytes when omitted. */
function bytes32(value, name) {
  if (value === undefined || value === null || value === "") return "0".repeat(64);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw Object.assign(new Error(`${name} must be a 0x-prefixed 32-byte hex value`), { exitCode: 1 });
  }
  return value.slice(2).toLowerCase();
}

function sideIndex(side) {
  const index = SIDES[String(side).toLowerCase()];
  if (index === undefined) throw Object.assign(new Error(`side must be "buy" or "sell", got "${side}"`), { exitCode: 1 });
  return index;
}

const PROVIDER_NAME = { 1: "ondo", 2: "xstock", 3: "bstock" };
const summarize = (matches) =>
  matches.map((t) => `${t.symbol} (provider=${PROVIDER_NAME[t.type] ?? `type${t.type}`}, chainId=${t.chainId}, ${t.contractAddress})`).join("; ");

const hex32 = (n) => BigInt(n).toString(16).padStart(64, "0");
const addr32 = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const slot = (data, i) => "0x" + data.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const asBool = (data, i) => BigInt(slot(data, i)) !== 0n;
const asUint = (data, i) => BigInt(slot(data, i));

// ---- dynamic-array ABI encoding for setMandateForTokens (Feature 2) ----
// Every array element here is a value type (address/uint16/uint256), so
// like any non-packed array each element still takes one full 32-byte
// word - encodeXArray below never packs uint16 into fewer bytes than
// hex32 would. Verified byte-for-byte against ethers' own encoder in
// test/skill-cli.live.ts.
const encodeAddressArray = (arr) => hex32(arr.length) + arr.map(addr32).join("");
const encodeUintArray = (arr) => hex32(arr.length) + arr.map(hex32).join("");

async function ethCall(rpcUrl, to, calldata) {
  const body = { jsonrpc: "2.0", method: "eth_call", params: [{ to, data: calldata }, "latest"], id: 1 };
  const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (json.error) throw Object.assign(new Error(`eth_call failed: ${json.error.message}`), { exitCode: 1 });
  return json.result;
}

/** Same as ethCall, but tries each URL in rpcUrls in sequence until one answers. */
async function ethCallWithFailover(to, calldata, { rpcUrls } = {}) {
  const urls = rpcUrls ?? DEFAULT_BSC_RPCS;
  let lastError;
  for (const rpcUrl of urls) {
    try {
      return { result: await ethCall(rpcUrl, to, calldata), rpcUrl };
    } catch (err) {
      lastError = err;
    }
  }
  throw Object.assign(
    new Error(`all RPCs failed for eth_call: ${lastError?.message ?? "unknown error"}`),
    { exitCode: 1 },
  );
}

// ---- survey: real tradability, cross-checked against on-chain state ----
// Free-tier BSC RPCs individually rate-limit or restrict eth_getLogs (see
// docs/partner-feedback/friction-log.md B10) - tried in sequence, first one
// to answer wins.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Shared default RPC list for anything that needs to work unattended (a
// judge's environment, a cron job) without depending on one free-tier
// endpoint staying up - see friction-log.md B12-B14 for the flakiness this
// is guarding against, found live while forking against a single endpoint.
const DEFAULT_BSC_RPCS = ["https://bsc.publicnode.com", "https://bsc-dataseed1.defibit.io", "https://bsc-dataseed.binance.org"];

async function jsonRpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/**
 * Same as jsonRpc, but tries each URL in rpcUrls in sequence until one
 * answers, instead of depending on a single endpoint. Returns which RPC
 * actually answered alongside the result, so a caller can report it.
 */
async function jsonRpcWithFailover(method, params, { rpcUrls = DEFAULT_BSC_RPCS } = {}) {
  let lastError;
  for (const rpcUrl of rpcUrls) {
    try {
      return { result: await jsonRpc(rpcUrl, method, params), rpcUrl };
    } catch (err) {
      lastError = err;
    }
  }
  throw Object.assign(
    new Error(`all RPCs failed for ${method}: ${lastError?.message ?? "unknown error"}`),
    { exitCode: 1 },
  );
}

/**
 * Counts real Transfer events for a token over a recent block window, tried
 * across several RPCs until one answers. This exists because Binance's own
 * `tokenInfo.volume24h` figure was found, live, to be flatly wrong for at
 * least one xStock (TSLAx reported volume24h="12433648121" while zero real
 * Transfer events occurred in the prior ~6.7 hours of real chain data) -
 * see friction-log.md. `survey` reports both numbers, labeled, rather than
 * trusting Binance's reported figure alone for a tradability call.
 */
async function countRecentTransfers(tokenAddress, { blocksBack = 3000, rpcUrls = DEFAULT_BSC_RPCS } = {}) {
  for (const rpcUrl of rpcUrls) {
    try {
      const tip = BigInt(await jsonRpc(rpcUrl, "eth_blockNumber", []));
      const window = BigInt(blocksBack);
      // Math.max(0, someBigInt) throws - Math.max coerces every argument
      // with ToNumber, which rejects BigInt outright. Caught live: every
      // attempt was failing silently inside this function's own try/catch,
      // making every RPC look "rate-limited" when the real cause was here.
      const fromBigInt = tip > window ? tip - window : 0n;
      const fromBlock = "0x" + fromBigInt.toString(16);
      const logs = await jsonRpc(rpcUrl, "eth_getLogs", [{ fromBlock, toBlock: "latest", address: tokenAddress, topics: [TRANSFER_TOPIC] }]);
      return { transferCount: logs.length, blocksBack, rpcUrl };
    } catch {
      // try the next RPC
    }
  }
  return { transferCount: null, blocksBack, rpcUrl: null, note: "all liquidity-check RPCs failed or rate-limited" };
}

async function fetchDynamic(chainId, contractAddress) {
  const url = "https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai";
  try {
    const resp = await call({ url: `${url}?chainId=${chainId}&contractAddress=${contractAddress}` });
    return resp.data ?? null;
  } catch {
    return null;
  }
}

// ---- commands ----
const COMMANDS = {
  /**
   * { ticker, provider?, chainId? } -> resolved token, or a refusal listing
   * every candidate that matched.
   *
   * Two independent axes of ambiguity exist for a bare ticker, and testing
   * this live (not assumed from docs) found both are real: the same ticker
   * can resolve to multiple *providers* (verified-facts.md's DRAMon vs
   * DRAMB), and, less obviously, even a single provider can list the same
   * ticker on *multiple chains* (real NVDA-on-Ondo exists on Ethereum,
   * BSC, and Solana simultaneously). An earlier version of this function
   * only guarded the first axis - `{ ticker: "NVDA", provider: "ondo" }`
   * silently returned the Ethereum-mainnet address instead of BSC's, the
   * exact class of bug this whole function exists to prevent, just one
   * dimension deeper. Both axes are now required to collapse to exactly one
   * match before anything is returned; only a `chainId` default (56, this
   * project's only target chain) is applied implicitly, and only when doing
   * so already yields a single match.
   */
  async resolve({ ticker, provider, chainId }) {
    if (!ticker) throw Object.assign(new Error("resolve requires { ticker }"), { exitCode: 1 });
    const PROVIDER_TYPE = { ondo: 1, xstock: 2, bstock: 3 };
    if (provider !== undefined && !(provider in PROVIDER_TYPE)) {
      throw Object.assign(new Error(`resolve: unknown provider "${provider}". Expected one of: ondo, xstock, bstock`), { exitCode: 1 });
    }

    // The endpoint honors a server-side `?type=` filter (verified live,
    // 2026-09-25: `?type=3` returns exactly the 80 real bstock listings,
    // nothing else) - pass it whenever `provider` narrows the request
    // up front, instead of always fetching every provider's full list
    // and filtering client-side.
    const listBaseUrl = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";
    const listUrl = provider !== undefined ? `${listBaseUrl}?type=${PROVIDER_TYPE[provider]}` : listBaseUrl;
    const listResp = await call({ url: listUrl });
    const tokens = listResp.data ?? [];
    const wantedTicker = String(ticker).toUpperCase();
    let matches = tokens.filter((t) => String(t.ticker).toUpperCase() === wantedTicker);
    if (matches.length === 0) {
      throw Object.assign(new Error(`resolve: no token found for ticker "${ticker}" on any provider`), { exitCode: 1 });
    }

    // Axis 1: provider (already applied server-side above when given; this
    // still runs so the "no provider given, multiple types matched" branch
    // below is reached correctly when provider is undefined).
    if (provider !== undefined) {
      matches = matches.filter((t) => t.type === PROVIDER_TYPE[provider]);
      if (matches.length === 0) {
        throw Object.assign(new Error(`resolve: no ${provider} token found for ticker "${ticker}"`), { exitCode: 1 });
      }
    } else {
      const distinctTypes = new Set(matches.map((t) => t.type));
      if (distinctTypes.size > 1) {
        throw Object.assign(
          new Error(
            `resolve: "${ticker}" is ambiguous across providers - specify one explicitly: ` +
              summarize(matches),
          ),
          { exitCode: 2, matches },
        );
      }
    }

    // Axis 2: chain. Apply the BSC default only if it already narrows to one match.
    if (matches.length > 1) {
      const distinctChains = new Set(matches.map((t) => t.chainId));
      if (chainId !== undefined) {
        matches = matches.filter((t) => t.chainId === String(chainId));
      } else {
        const bscOnly = matches.filter((t) => t.chainId === "56");
        if (bscOnly.length === 1) {
          matches = bscOnly;
        } else if (distinctChains.size > 1) {
          throw Object.assign(
            new Error(`resolve: "${ticker}" is ambiguous across chains - specify chainId explicitly: ` + summarize(matches)),
            { exitCode: 2, matches },
          );
        }
      }
    }

    if (matches.length !== 1) {
      throw Object.assign(
        new Error(`resolve: "${ticker}" still resolves to ${matches.length} candidates after filtering - refusing to guess: ` + summarize(matches)),
        { exitCode: 2, matches },
      );
    }
    return { resolved: matches[0] };
  },

  /**
   * { ticker } -> BSC status for all three providers (ondo, xstock, bstock)
   * at once, each explicitly labeled "live", "dead", or "not-listed-on-bsc".
   *
   * `resolve` deliberately refuses to guess when a ticker is ambiguous -
   * this command is the other half: instead of picking one, report on
   * every provider so the caller (a human or an agent) can see the full
   * picture and make an informed choice, including providers that exist
   * but aren't actually tradeable. xStocks in particular is real, deployed,
   * and essentially dead on BSC (verified-facts.md §3); this command proves
   * that on demand rather than citing a stale research snapshot, and
   * cross-checks Binance's own reported volume against real on-chain
   * Transfer events rather than trusting either source alone - see
   * countRecentTransfers's doc comment for why that check exists at all.
   */
  async survey({ ticker }) {
    if (!ticker) throw Object.assign(new Error("survey requires { ticker }"), { exitCode: 1 });

    const listUrl = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";
    const listResp = await call({ url: listUrl });
    const tokens = listResp.data ?? [];
    const wantedTicker = String(ticker).toUpperCase();
    const matches = tokens.filter((t) => String(t.ticker).toUpperCase() === wantedTicker);

    const listings = Object.entries(PROVIDER_NAME).map(([type, providerName]) => ({
      providerName,
      listing: matches.find((t) => t.type === Number(type) && t.chainId === "56"),
    }));

    // fetchDynamic (a plain GET to Binance's own API) is fine to run
    // concurrently, but the on-chain eth_getLogs checks are run one at a
    // time, deliberately, not via Promise.all. Firing three concurrent
    // eth_getLogs calls at the same free-tier RPC - one per provider - was
    // caught live tripping that RPC's per-IP burst limit even though a
    // single isolated call a moment earlier worked fine and returned real
    // data. Sequential is slower but actually reliable; see friction-log.md.
    const dynamics = await Promise.all(listings.map(({ listing }) => (listing ? fetchDynamic(56, listing.contractAddress) : Promise.resolve(null))));

    const providers = [];
    for (let i = 0; i < listings.length; i++) {
      const { providerName, listing } = listings[i];
      if (!listing) {
        providers.push({ provider: providerName, status: "not-listed-on-bsc" });
        continue;
      }

      const dynamic = dynamics[i];
      const transferCheck = await countRecentTransfers(listing.contractAddress);
      const onChainActivity = transferCheck.transferCount;
      // "dead" requires the independent on-chain check to actually have
      // run and come back zero - if every RPC failed, that's "unknown",
      // not "dead". Otherwise trust the on-chain count over Binance's own
      // reported figure, per the real discrepancy this command exists to
      // catch (see countRecentTransfers).
      let status;
      if (onChainActivity === null) status = "unknown - on-chain check failed";
      else if (onChainActivity === 0) status = "dead";
      else status = "live";

      providers.push({
        provider: providerName,
        status,
        chainId: "56",
        contractAddress: listing.contractAddress,
        symbol: listing.symbol,
        binanceReported: { price: dynamic?.tokenInfo?.price ?? null, volume24h: dynamic?.tokenInfo?.volume24h ?? null },
        onChainVerified: transferCheck,
      });
    }

    return { ticker: wantedTicker, providers };
  },

  /**
   * { rpcUrl, covenantAddress, side, tokenAddress, amountIn, quotedOut, minOut }
   *   -> the mandate, token and oracle state, plus the decision `commit`
   *      would make right now. Read-only. Amounts are in 18-decimal base units.
   */
  async check({ rpcUrl, covenantAddress, side, tokenAddress, amountIn, quotedOut, minOut }) {
    if (!rpcUrl || !covenantAddress || side === undefined || !tokenAddress || amountIn === undefined || quotedOut === undefined || minOut === undefined) {
      throw Object.assign(
        new Error("check requires { rpcUrl, covenantAddress, side, tokenAddress, amountIn, quotedOut, minOut }"),
        { exitCode: 1 },
      );
    }
    const sideArg = hex32(sideIndex(side));

    const [configRaw, mandateRaw, oracleRaw, usedRaw, openRaw, decisionRaw, maxDailyRaw, dailyUsedRaw] = await Promise.all([
      ethCall(rpcUrl, covenantAddress, SELECTORS.tokenConfig + addr32(tokenAddress)),
      ethCall(rpcUrl, covenantAddress, SELECTORS.mandate),
      ethCall(rpcUrl, covenantAddress, SELECTORS.oracleStatus + addr32(tokenAddress)),
      ethCall(rpcUrl, covenantAddress, SELECTORS.tradesUsedToday),
      ethCall(rpcUrl, covenantAddress, SELECTORS.hasOpenDecision),
      ethCall(
        rpcUrl,
        covenantAddress,
        SELECTORS.previewDecision + sideArg + addr32(tokenAddress) + hex32(amountIn) + hex32(quotedOut) + hex32(minOut),
      ),
      // Red-team H7: not part of the Mandate struct (a separate setter, so
      // tightening it doesn't require re-setting the rest of the mandate).
      ethCall(rpcUrl, covenantAddress, SELECTORS.maxDailyNotionalUsd),
      ethCall(rpcUrl, covenantAddress, SELECTORS.notionalUsedToday),
    ]);

    const reasonIndex = Number(asUint(decisionRaw, 0));
    return {
      side: String(side).toLowerCase(),
      tokenAddress,
      token: {
        allowed: asBool(configRaw, 0),
        maxSlippageBps: Number(asUint(configRaw, 1)),
        maxPositionUsd: asUint(configRaw, 2).toString(),
        maxClosedMarketDriftBps: Number(asUint(configRaw, 3)),
      },
      mandate: {
        active: asBool(mandateRaw, 0),
        maxNotionalPerTradeUsd: asUint(mandateRaw, 1).toString(),
        maxTradesPerDay: asUint(mandateRaw, 2).toString(),
        expiry: asUint(mandateRaw, 3).toString(),
        tradesUsedToday: asUint(usedRaw, 0).toString(),
        decisionOpen: asBool(openRaw, 0),
        maxDailyNotionalUsd: asUint(maxDailyRaw, 0).toString(),
        notionalUsedToday: asUint(dailyUsedRaw, 0).toString(),
      },
      oracle: {
        halted: asBool(oracleRaw, 0),
        priceUsd: asUint(oracleRaw, 1).toString(),
        updatedAt: asUint(oracleRaw, 2).toString(),
        sessionOpen: asBool(oracleRaw, 3),
        lastCloseUsd: asUint(oracleRaw, 4).toString(),
      },
      decision: {
        allowed: reasonIndex === 0,
        reason: DENIAL_REASONS[reasonIndex] ?? `UNKNOWN(${reasonIndex})`,
      },
    };
  },

  /**
   * { side, tokenAddress, amountIn, quotedOut, minOut, quoteRef?, researchRef? }
   *   -> commit calldata. quoteRef/researchRef are 32-byte hashes, zero if omitted.
   */
  async buildCommitCalldata({ side, tokenAddress, amountIn, quotedOut, minOut, quoteRef, researchRef }) {
    if (side === undefined || !tokenAddress || amountIn === undefined || quotedOut === undefined || minOut === undefined) {
      throw Object.assign(
        new Error("build-commit-calldata requires { side, tokenAddress, amountIn, quotedOut, minOut }"),
        { exitCode: 1 },
      );
    }
    const calldata =
      SELECTORS.commit +
      hex32(sideIndex(side)) +
      addr32(tokenAddress) +
      hex32(amountIn) +
      hex32(quotedOut) +
      hex32(minOut) +
      bytes32(quoteRef, "quoteRef") +
      bytes32(researchRef, "researchRef");
    return { calldata };
  },

  /**
   * { to } -> "aggregator" | "pool" | "unknown", from the swap transaction's
   * `to` address alone. See the KNOWN_ROUTERS comment above for exactly
   * what this can and can't tell you - it deliberately never returns "rfq".
   */
  async classifyExecutionMode({ to }) {
    if (!to) throw Object.assign(new Error("classify-execution-mode requires { to }"), { exitCode: 1 });
    return { executionMode: classifyExecutionMode({ to }) };
  },

  /**
   * { decisionId, swapTxHash, amountOut, executionMode }
   *   -> settle calldata. amountOut must be the ERC-20 Transfer amount the
   *      wallet really received, not market-order list's toTokenActualQty,
   *      which is in share units for bStocks (friction-log.md C17).
   */
  async buildSettleCalldata({ decisionId, swapTxHash, amountOut, executionMode }) {
    if (decisionId === undefined || !swapTxHash || amountOut === undefined || executionMode === undefined) {
      throw Object.assign(
        new Error("build-settle-calldata requires { decisionId, swapTxHash, amountOut, executionMode }"),
        { exitCode: 1 },
      );
    }
    const mode = EXECUTION_MODES[String(executionMode).toLowerCase()];
    if (mode === undefined) {
      throw Object.assign(new Error(`executionMode must be one of ${Object.keys(EXECUTION_MODES).join(", ")}`), { exitCode: 1 });
    }
    const calldata = SELECTORS.settle + hex32(decisionId) + bytes32(swapTxHash, "swapTxHash") + hex32(amountOut) + hex32(mode);
    return { calldata };
  },

  /** { decisionId } -> cancel calldata. */
  async buildCancelCalldata({ decisionId }) {
    if (decisionId === undefined) throw Object.assign(new Error("build-cancel-calldata requires { decisionId }"), { exitCode: 1 });
    return { calldata: SELECTORS.cancel + hex32(decisionId) };
  },

  /**
   * { maxNotionalPerTradeUsd, maxTradesPerDay, expiry, tokens, maxSlippageBpsList,
   *   maxPositionUsdList, maxClosedMarketDriftBpsList } -> setMandateForTokens calldata.
   * Every *List array must be the same length as `tokens` - the contract checks this
   * too (ArrayLengthMismatch), but failing here first gives a clearer message.
   */
  async buildSetMandateForTokensCalldata({
    maxNotionalPerTradeUsd,
    maxTradesPerDay,
    expiry,
    tokens,
    maxSlippageBpsList,
    maxPositionUsdList,
    maxClosedMarketDriftBpsList,
  }) {
    if (
      maxNotionalPerTradeUsd === undefined || maxTradesPerDay === undefined || expiry === undefined
      || !Array.isArray(tokens) || !Array.isArray(maxSlippageBpsList) || !Array.isArray(maxPositionUsdList)
      || !Array.isArray(maxClosedMarketDriftBpsList)
    ) {
      throw Object.assign(
        new Error(
          "build-set-mandate-for-tokens-calldata requires { maxNotionalPerTradeUsd, maxTradesPerDay, expiry, tokens, maxSlippageBpsList, maxPositionUsdList, maxClosedMarketDriftBpsList }",
        ),
        { exitCode: 1 },
      );
    }
    const n = tokens.length;
    if (maxSlippageBpsList.length !== n || maxPositionUsdList.length !== n || maxClosedMarketDriftBpsList.length !== n) {
      throw Object.assign(new Error(`build-set-mandate-for-tokens-calldata: tokens has ${n} entries but the *List arrays don't all match`), { exitCode: 1 });
    }
    const HEAD_WORDS = 7;
    const tokensEncoded = encodeAddressArray(tokens);
    const slipEncoded = encodeUintArray(maxSlippageBpsList);
    const posEncoded = encodeUintArray(maxPositionUsdList);
    const driftEncoded = encodeUintArray(maxClosedMarketDriftBpsList);

    const offsetTokens = HEAD_WORDS * 32;
    const offsetSlip = offsetTokens + tokensEncoded.length / 2;
    const offsetPos = offsetSlip + slipEncoded.length / 2;
    const offsetDrift = offsetPos + posEncoded.length / 2;

    const calldata =
      SELECTORS.setMandateForTokens +
      hex32(maxNotionalPerTradeUsd) +
      hex32(maxTradesPerDay) +
      hex32(expiry) +
      hex32(offsetTokens) +
      hex32(offsetSlip) +
      hex32(offsetPos) +
      hex32(offsetDrift) +
      tokensEncoded +
      slipEncoded +
      posEncoded +
      driftEncoded;
    return { calldata };
  },

  /**
   * { text, durationDays? } -> resolves a plain-English mandate sentence
   * against skills/covenant-mandate/scripts/theme-map.json (Feature 2,
   * redesigned - see docs/partner-feedback/friction-log.md A10) and returns
   * the matched theme, its pinned tokens, a human-readable summary, and one
   * setMandateForTokens calldata that sets the whole mandate in a single
   * owner transaction.
   *
   * This is regex/keyword extraction, not an LLM call - zero dependencies,
   * same convention as the rest of this file - so it recognizes a specific,
   * documented shape rather than arbitrary phrasing. It refuses (never
   * guesses) when the theme or the dollar/trade-count/percentage fields
   * aren't found, the same "never guess" rule `resolve` follows for tickers.
   *
   * Recognized shape (case-insensitive), matching the example sentence in
   * FEATURES-V2-2026-09-24.md: "Only AI-chip stocks, at most $1 per trade,
   * 3 trades a day, no weekend premium over 1%."
   *   - theme: any theme_map.json label or key appearing anywhere in `text`
   *   - per-trade cap: `$<number> per trade`
   *   - trades per day: `<number> trades (a|per) day`
   *   - closed-market drift bound: `premium (over|above) <number>%`
   *   - optional slippage: `slippage (of|up to)? <number>%` (default 100 bps / 1%)
   *   - optional position cap: `position cap $<number>` (default 10x the per-trade cap)
   */
  async compileMandate({ text, durationDays }) {
    if (typeof text !== "string" || text.length === 0) {
      throw Object.assign(new Error("compile-mandate requires { text }"), { exitCode: 1 });
    }
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const mapPath = fileURLToPath(new URL("./theme-map.json", import.meta.url));
    const themeMap = JSON.parse(readFileSync(mapPath, "utf8"));

    const lower = text.toLowerCase();
    // Normalized (letters/digits only, trailing "s" stripped) so "AI-chip
    // stocks" matches theme key "ai-chips" and label "AI chips" without
    // requiring the exact punctuation or plural form.
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
    const textNorm = normalize(text);
    let matchedKey;
    for (const [key, theme] of Object.entries(themeMap.themes)) {
      if (textNorm.includes(normalize(key)) || textNorm.includes(normalize(theme.label))) {
        matchedKey = key;
        break;
      }
    }
    if (!matchedKey) {
      const known = Object.values(themeMap.themes).map((t) => t.label).join(", ");
      throw Object.assign(
        new Error(`compile-mandate: no known theme found in "${text}" - refusing to guess. Known themes: ${known}`),
        { exitCode: 2 },
      );
    }
    const theme = themeMap.themes[matchedKey];
    const tickers = Object.keys(theme.tickers);
    const tokens = tickers.map((t) => theme.tickers[t]);

    const perTradeMatch = lower.match(/\$(\d+(?:\.\d+)?)\s*per trade/);
    if (!perTradeMatch) {
      throw Object.assign(new Error(`compile-mandate: no "$<amount> per trade" found in "${text}" - refusing to guess`), { exitCode: 2 });
    }
    const maxNotionalUsd = perTradeMatch[1];

    const tradesMatch = lower.match(/(\d+)\s*trades?\s*(?:a|per)\s*day/);
    if (!tradesMatch) {
      throw Object.assign(new Error(`compile-mandate: no "<n> trades a day" found in "${text}" - refusing to guess`), { exitCode: 2 });
    }
    const maxTradesPerDay = tradesMatch[1];

    const driftMatch = lower.match(/premium\s*(?:over|above)\s*(\d+(?:\.\d+)?)%/);
    if (!driftMatch) {
      throw Object.assign(new Error(`compile-mandate: no "premium over <n>%" found in "${text}" - refusing to guess`), { exitCode: 2 });
    }
    const driftBps = Math.round(Number(driftMatch[1]) * 100);

    const slippageMatch = lower.match(/slippage\s*(?:of|up to)?\s*(\d+(?:\.\d+)?)%/);
    const slippageBps = slippageMatch ? Math.round(Number(slippageMatch[1]) * 100) : 100;

    const positionMatch = lower.match(/position cap\s*\$(\d+(?:\.\d+)?)/);
    const maxPositionUsd = positionMatch ? positionMatch[1] : String(Number(maxNotionalUsd) * 10);

    const days = durationDays ?? 30;
    const nowSec = Math.floor(Date.now() / 1000);
    const expiry = nowSec + days * 24 * 60 * 60;

    const E18 = 1_000_000_000_000_000_000n;
    const toBase = (usd) => (BigInt(Math.round(Number(usd) * 1e6)) * E18) / 1_000_000n;
    const maxNotionalBase = toBase(maxNotionalUsd);
    const maxPositionBase = toBase(maxPositionUsd);

    const n = tokens.length;
    const { calldata } = await COMMANDS.buildSetMandateForTokensCalldata({
      maxNotionalPerTradeUsd: maxNotionalBase,
      maxTradesPerDay,
      expiry,
      tokens,
      maxSlippageBpsList: Array(n).fill(slippageBps),
      maxPositionUsdList: Array(n).fill(maxPositionBase),
      maxClosedMarketDriftBpsList: Array(n).fill(driftBps),
    });

    const summary =
      `Theme "${theme.label}" -> ${tickers.join(", ")} (${n} token${n === 1 ? "" : "s"}). ` +
      `Max $${maxNotionalUsd} per trade, ${maxTradesPerDay} trades/day, expires in ${days} days. ` +
      `Slippage bound ${slippageBps / 100}%, position cap $${maxPositionUsd} per token, ` +
      `no more than ${driftBps / 100}% premium/discount to last close while the NYSE is shut.`;

    return { theme: matchedKey, label: theme.label, tickers, tokens, maxNotionalUsd, maxTradesPerDay, expiry, slippageBps, maxPositionUsd, driftBps, summary, calldata };
  },

  /**
   * { text } -> 0x-prefixed SHA-256 of the exact text, for commit's quoteRef
   * or researchRef. SHA-256 rather than keccak256 because Node ships it and
   * this script has no dependencies; the contract only needs 32 bytes.
   * Hash the raw response exactly as received so anyone can re-derive it.
   */
  async hashRef({ text }) {
    if (typeof text !== "string" || text.length === 0) throw Object.assign(new Error("hash-ref requires { text }"), { exitCode: 1 });
    const { createHash } = await import("node:crypto");
    return { ref: "0x" + createHash("sha256").update(text, "utf8").digest("hex") };
  },
};

// ---- exports (for unit testing; direct execution still works - see dispatch below) ----
export {
  COMMANDS,
  call,
  ethCall,
  ethCallWithFailover,
  SELECTORS,
  DENIAL_REASONS,
  SIDES,
  EXECUTION_MODES,
  hex32,
  addr32,
  countRecentTransfers,
  fetchDynamic,
  jsonRpcWithFailover,
  DEFAULT_BSC_RPCS,
};

// ---- CLI dispatch (only runs when executed directly, not when imported) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, paramsStr] = process.argv.slice(2);
  const commandKey = {
    resolve: "resolve",
    survey: "survey",
    check: "check",
    "build-commit-calldata": "buildCommitCalldata",
    "build-settle-calldata": "buildSettleCalldata",
    "build-cancel-calldata": "buildCancelCalldata",
    "hash-ref": "hashRef",
    "compile-mandate": "compileMandate",
    "build-set-mandate-for-tokens-calldata": "buildSetMandateForTokensCalldata",
    "classify-execution-mode": "classifyExecutionMode",
  }[cmd];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("Usage: node cli.mjs <command> '<json_params>'\n\nCommands:");
    console.log("  resolve                { ticker, provider?, chainId? }");
    console.log("  survey                 { ticker }");
    console.log("  check                  { rpcUrl, covenantAddress, side, tokenAddress, amountIn, quotedOut, minOut }");
    console.log("  build-commit-calldata  { side, tokenAddress, amountIn, quotedOut, minOut, quoteRef?, researchRef? }");
    console.log("  build-settle-calldata  { decisionId, swapTxHash, amountOut, executionMode }");
    console.log("  build-cancel-calldata  { decisionId }");
    console.log("  hash-ref               { text }");
    console.log("  compile-mandate        { text, durationDays? }");
    console.log("  build-set-mandate-for-tokens-calldata  { maxNotionalPerTradeUsd, maxTradesPerDay, expiry, tokens, maxSlippageBpsList, maxPositionUsdList, maxClosedMarketDriftBpsList }");
    console.log("  classify-execution-mode  { to }");
    process.exit(0);
  }

  if (!commandKey) {
    console.error(`Unknown command: ${cmd}\nRun with --help to see available commands.`);
    process.exit(1);
  }

  let params = {};
  if (paramsStr) {
    try {
      params = JSON.parse(paramsStr);
    } catch {
      console.error("Invalid JSON params");
      process.exit(1);
    }
  }

  try {
    const result = await COMMANDS[commandKey](params);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(err.message);
    if (err.matches) console.log(JSON.stringify(err.matches, null, 2));
    process.exit(err.exitCode || 1);
  }
}
