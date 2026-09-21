#!/usr/bin/env node
// covenant-mandate CLI — self-contained, zero-dep, Node >= 22
// Usage: node cli.mjs <command> '<json_params>'
//
// Commands:
//   resolve              ticker -> exact contract address, refuses to guess across providers
//   check                read Covenant's on-chain mandate/oracle/allowlist state for a token,
//                         and get the guard's actual decision via previewDecision - all read-only
//   build-swap-calldata  ABI-encode a guardedSwap call, ready for `baw contract-call preview --inputData`
//
// Why `check` exists and matters: Covenant's guardedSwap never reverts on a
// denial (see contracts/Covenant.sol's NatSpec) - it soft-declines and emits
// an Attestation event instead. That means `baw contract-call preview`'s own
// simulation will show a call that "succeeds" whether the trade is actually
// allowed or denied; the simulation layer alone cannot tell you which. Only
// reading previewDecision (what `check` does) tells you the real answer
// before you spend a preview/execute round trip on a call you already know
// will be denied.

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
  previewDecision: "0xa1750db0", // previewDecision(address,uint256)
  guardedSwap: "0x0bd0808d", // guardedSwap(address,uint24,uint256,uint256)
  mandate: "0x39b1b96d", // mandate()
  allowedTokens: "0xe744092e", // allowedTokens(address)
  oracleStatus: "0xe863f6a7", // oracleStatus(address)
};

const DENIAL_REASONS = [
  "None",
  "MandateInactive",
  "MandateExpired",
  "TokenNotAllowed",
  "NotionalExceeded",
  "DailyLimitExceeded",
  "OracleStale",
  "OracleHalted",
];

const PROVIDER_NAME = { 1: "ondo", 2: "xstock", 3: "bstock" };
const summarize = (matches) =>
  matches.map((t) => `${t.symbol} (provider=${PROVIDER_NAME[t.type] ?? `type${t.type}`}, chainId=${t.chainId}, ${t.contractAddress})`).join("; ");

const hex32 = (n) => BigInt(n).toString(16).padStart(64, "0");
const addr32 = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const slot = (data, i) => "0x" + data.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const asBool = (data, i) => BigInt(slot(data, i)) !== 0n;
const asUint = (data, i) => BigInt(slot(data, i));

async function ethCall(rpcUrl, to, calldata) {
  const body = { jsonrpc: "2.0", method: "eth_call", params: [{ to, data: calldata }, "latest"], id: 1 };
  const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (json.error) throw Object.assign(new Error(`eth_call failed: ${json.error.message}`), { exitCode: 1 });
  return json.result;
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

    const listUrl = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";
    const listResp = await call({ url: listUrl });
    const tokens = listResp.data ?? [];
    const wantedTicker = String(ticker).toUpperCase();
    let matches = tokens.filter((t) => String(t.ticker).toUpperCase() === wantedTicker);
    if (matches.length === 0) {
      throw Object.assign(new Error(`resolve: no token found for ticker "${ticker}" on any provider`), { exitCode: 1 });
    }

    // Axis 1: provider.
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

  /** { rpcUrl, covenantAddress, tokenAddress, amountIn } -> full on-chain guard state + decision, read-only. */
  async check({ rpcUrl, covenantAddress, tokenAddress, amountIn }) {
    if (!rpcUrl || !covenantAddress || !tokenAddress || amountIn === undefined) {
      throw Object.assign(new Error("check requires { rpcUrl, covenantAddress, tokenAddress, amountIn }"), { exitCode: 1 });
    }

    const [allowedRaw, mandateRaw, oracleRaw, decisionRaw] = await Promise.all([
      ethCall(rpcUrl, covenantAddress, SELECTORS.allowedTokens + addr32(tokenAddress)),
      ethCall(rpcUrl, covenantAddress, SELECTORS.mandate),
      ethCall(rpcUrl, covenantAddress, SELECTORS.oracleStatus + addr32(tokenAddress)),
      ethCall(rpcUrl, covenantAddress, SELECTORS.previewDecision + addr32(tokenAddress) + hex32(amountIn)),
    ]);

    const reasonIndex = Number(asUint(decisionRaw, 0));
    return {
      tokenAddress,
      allowlisted: asBool(allowedRaw, 0),
      mandate: {
        active: asBool(mandateRaw, 0),
        maxNotionalPerTrade: asUint(mandateRaw, 1).toString(),
        maxTradesPerDay: asUint(mandateRaw, 2).toString(),
        expiry: asUint(mandateRaw, 3).toString(),
      },
      oracle: {
        halted: asBool(oracleRaw, 0),
        updatedAt: asUint(oracleRaw, 1).toString(),
      },
      decision: {
        allowed: reasonIndex === 0,
        reason: DENIAL_REASONS[reasonIndex] ?? `UNKNOWN(${reasonIndex})`,
      },
    };
  },

  /** { tokenOut, fee, amountIn, amountOutMinimum } -> ABI-encoded guardedSwap calldata. */
  async buildSwapCalldata({ tokenOut, fee, amountIn, amountOutMinimum }) {
    if (!tokenOut || fee === undefined || amountIn === undefined || amountOutMinimum === undefined) {
      throw Object.assign(new Error("build-swap-calldata requires { tokenOut, fee, amountIn, amountOutMinimum }"), { exitCode: 1 });
    }
    const calldata = SELECTORS.guardedSwap + addr32(tokenOut) + hex32(fee) + hex32(amountIn) + hex32(amountOutMinimum);
    return { calldata };
  },
};

// ---- exports (for unit testing; direct execution still works - see dispatch below) ----
export { COMMANDS, call, ethCall, SELECTORS, DENIAL_REASONS, hex32, addr32 };

// ---- CLI dispatch (only runs when executed directly, not when imported) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, paramsStr] = process.argv.slice(2);
  const commandKey = { resolve: "resolve", check: "check", "build-swap-calldata": "buildSwapCalldata" }[cmd];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("Usage: node cli.mjs <command> '<json_params>'\n\nCommands:");
    console.log("  resolve              { ticker, provider? }");
    console.log("  check                { rpcUrl, covenantAddress, tokenAddress, amountIn }");
    console.log("  build-swap-calldata  { tokenOut, fee, amountIn, amountOutMinimum }");
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
