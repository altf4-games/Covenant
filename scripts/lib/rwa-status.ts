/**
 * Client for Binance's public RWA asset-market-status endpoint.
 *
 * This is NOT the documented, HMAC-authenticated RWA Data API at
 * web3.binance.com/en/dev-docs - it's a separate, public, unauthenticated
 * endpoint (no X-OC-* headers, just Accept-Encoding/User-Agent) that isn't
 * mentioned on that site at all. It was found the only place it's
 * documented: binance-tokenized-securities-info/SKILL.md in the
 * binance-skills-hub GitHub repo, whose own description calls it
 * "Ondo tokenized US stock data" - tested live against real bStocks
 * (NVDAB, chainId 56) and it works identically for bStocks (type: 3).
 * See docs/partner-feedback/friction-log.md B15 for the live test that
 * established this, and B6 for the one real gap that testing did find
 * (bStocks' independent reference price field comes back null).
 */

const ASSET_MARKET_STATUS_URL =
  "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai";

const REQUEST_HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.1 (Skill)",
};

/** Mirrors the documented Reason Codes table in binance-tokenized-securities-info/SKILL.md. */
export type ReasonCode =
  | "TRADING"
  | "MARKET_CLOSED"
  | "MARKET_PAUSED"
  | "ASSET_PAUSED"
  | "ASSET_LIMITED"
  | "UNSUPPORTED"
  | "MARKET_MAINTENANCE";

export interface AssetMarketStatus {
  openState: boolean;
  marketStatus: string | null;
  reasonCode: ReasonCode;
  reasonMsg: string | null;
  nextOpenTime: number | null;
  nextCloseTime: number | null;
}

interface AssetMarketStatusResponse {
  code: string;
  message: string | null;
  data: AssetMarketStatus;
  success: boolean;
}

export async function fetchAssetMarketStatus(chainId: number, contractAddress: string): Promise<AssetMarketStatus> {
  const url = new URL(ASSET_MARKET_STATUS_URL);
  url.searchParams.set("chainId", String(chainId));
  url.searchParams.set("contractAddress", contractAddress);

  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`RWA asset-market-status request failed: HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as AssetMarketStatusResponse;
  if (!body.success || body.code !== "000000") {
    throw new Error(`RWA asset-market-status returned an error: code=${body.code} message=${body.message}`);
  }

  return body.data;
}

/**
 * Only `TRADING` means the guard should allow trades. Every other reason
 * code - closed, market-wide pause, asset-specific pause or limit, or even
 * an unrecognized/unsupported code - is treated as halted. This is
 * deliberately conservative: a mandate should never trade on a status the
 * oracle can't positively confirm as open.
 */
export function isHalted(status: Pick<AssetMarketStatus, "openState" | "reasonCode">): boolean {
  return !(status.openState && status.reasonCode === "TRADING");
}

/**
 * Converts a decimal price string from the RWA dynamic endpoint (e.g.
 * "226.40605755959772329895") into Covenant's 1e18 fixed-point `priceUsd`.
 * Truncates past 18 decimals: the endpoint returns up to 36 for some
 * tokens (xStocks), which `parseUnits` would reject outright.
 */
export function priceToUsdE18(price: string): bigint {
  const trimmed = price.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`not a plain decimal price: "${price}"`);
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}
