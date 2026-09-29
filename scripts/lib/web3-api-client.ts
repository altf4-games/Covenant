/**
 * A minimal client for the documented, HMAC-signed Binance Web3 API
 * (web3.binance.com/build/api/v1/...) - red-team finding H10: "All Binance
 * calls go to public, unauthenticated `bapi` endpoints... The Web3 API key
 * obtained in Phase 0 is used nowhere."
 *
 * This is deliberately a second, independent classification source, not a
 * replacement for scripts/lib/rwa-status.ts. rwa-status.ts (the public,
 * unauthenticated `bapi` endpoints) is still the price/status oracle feed -
 * it's the one confirmed live to carry bStocks' data at all (friction-log.md
 * B15). This client's job is narrower and real: before the oracle updater
 * posts a price for a token address, confirm that address is genuinely
 * listed as an RWA token on Binance's own authenticated Market API. A
 * misconfigured or stale token address (the wrong provider, a since-delisted
 * token) would otherwise post silently; this catches it before it reaches
 * chain, using the one part of the Web3 API stack the rest of this project
 * doesn't touch.
 *
 * Signing follows web3.binance.com/en/dev-docs/authentication.md exactly -
 * verified live, 2026-09-25, while investigating friction-log.md A10/A11:
 *   preHash = timestamp (ISO8601 ms) + method + "/build" + path + "?" + query + body
 *   signature = base64(HMAC-SHA256(preHash, secretKey))
 * sent as X-OC-APIKEY / X-OC-TIMESTAMP / X-OC-SIGN headers. GET only here.
 */
import { createHmac } from "node:crypto";

const BASE_URL = "https://web3.binance.com";
const BUILD_PREFIX = "/build";

export interface Web3ApiCredentials {
  apiKey: string;
  secretKey: string;
}

export function loadWeb3ApiCredentials(env: NodeJS.ProcessEnv = process.env): Web3ApiCredentials | null {
  const apiKey = env.WEB3_API_KEY;
  const secretKey = env.WEB3_API_SECRET;
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

/**
 * How far this machine's clock is behind (negative: ahead of) Binance's, in ms,
 * learned from a rejected request. The API rejects a timestamp outside its
 * receive window with HTTP 401 code 40103 and names its own time in the message
 * ("Timestamp outside recv_window. serverTime=..."). A laptop clock 19 seconds
 * slow was enough to fail every signed call, so the first such error corrects
 * the clock once and retries.
 */
let clockOffsetMs = 0;
export const resetClockOffset = () => {
  clockOffsetMs = 0;
};

/** One signed GET call against the documented Web3 API. Throws on a non-zero business `code`. */
export async function web3ApiGet(
  creds: Web3ApiCredentials,
  path: string,
  params: Record<string, string | number> = {},
): Promise<any> {
  const queryStr = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const fullPath = queryStr ? `${path}?${queryStr}` : path;
  const signedPath = BUILD_PREFIX + fullPath;

  for (let attempt = 0; ; attempt++) {
    const timestamp = new Date(Date.now() + clockOffsetMs).toISOString();
    const preHash = timestamp + "GET" + signedPath + "";
    const signature = createHmac("sha256", creds.secretKey).update(preHash, "utf8").digest("base64");

    const res = await fetch(BASE_URL + signedPath, {
      method: "GET",
      headers: {
        "X-OC-APIKEY": creds.apiKey,
        "X-OC-TIMESTAMP": timestamp,
        "X-OC-SIGN": signature,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { code?: number; msg?: string; data?: unknown };
    if (body.code === 40103 && attempt === 0) {
      const serverTime = /serverTime=([0-9T:.-]+Z)/.exec(body.msg ?? "")?.[1];
      const server = serverTime ? Date.parse(serverTime) : NaN;
      if (Number.isFinite(server)) {
        clockOffsetMs = server - Date.now();
        continue;
      }
    }
    if (!res.ok || body.code !== 0) {
      throw new Error(`Web3 API GET ${path} failed: HTTP ${res.status} code=${body.code} msg=${body.msg}`);
    }
    return body.data;
  }
}

export interface RwaTokenListing {
  binanceChainId: string;
  tokenContractAddress: string;
  platformId: string;
  tokenSymbol: string;
}

/**
 * Fetches the authenticated RWA token list, filtered by `platformId` (the
 * doc's own word, "platform", is silently ignored - see friction-log.md
 * A10). No sector/theme filter exists server-side despite the docs and the
 * hackathon Tracks tab both claiming one (A10) - this only ever filters by
 * platform.
 */
export async function fetchAuthenticatedRwaTokens(creds: Web3ApiCredentials, platformId: string): Promise<RwaTokenListing[]> {
  const data = await web3ApiGet(creds, "/api/v1/dex/market/rwa/tokens", { platformId });
  return data as RwaTokenListing[];
}

/**
 * Confirms `tokenAddress` is genuinely listed under `platformId` on the
 * authenticated Market API before the caller trusts it. Returns the
 * matching listing (so the caller can log its real symbol), or null if it
 * isn't there - a real, chain-and-address-exact check, not a guess.
 */
export async function verifyTokenListed(
  creds: Web3ApiCredentials,
  platformId: string,
  chainId: number,
  tokenAddress: string,
): Promise<RwaTokenListing | null> {
  const listings = await fetchAuthenticatedRwaTokens(creds, platformId);
  const wantChain = String(chainId);
  const wantAddress = tokenAddress.toLowerCase();
  return listings.find((t) => t.binanceChainId === wantChain && t.tokenContractAddress.toLowerCase() === wantAddress) ?? null;
}
