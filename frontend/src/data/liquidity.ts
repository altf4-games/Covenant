/**
 * Real, cited liquidity data for the territory map - GeckoTerminal reserves
 * as recorded in docs/research/verified-facts.md (2026-09-20) and
 * docs/partner-feedback/friction-log.md B8/B9. Not invented, not
 * estimated: these are the same numbers the project's own written research
 * already committed to disk before this map existed.
 */
export type Platform = "bstock" | "ondo" | "xstock";

export interface TerritoryToken {
  ticker: string;
  /** Short shop-sign name - what the underlying stock/fund is, not the wrapper ticker. */
  name: string;
  platform: Platform;
  reservesUsd: number;
  volume24hUsd: number;
  address?: string;
  note?: string;
}

export const TERRITORY_TOKENS: TerritoryToken[] = [
  // bStocks land - verified-facts.md "Liquidity (GeckoTerminal, Sunday 2026-09-20)"
  { ticker: "QQQB", name: "NASDAQ 100", platform: "bstock", reservesUsd: 8_875_815, volume24hUsd: 27_604_448, address: "0x205812CdBed920aFf76C6580abD681a46D11efc7", note: "name() typo: \"Invesqo QQQ\" instead of \"Invesco\", friction B9" },
  { ticker: "NVDAB", name: "NVIDIA", platform: "bstock", reservesUsd: 3_065_200, volume24hUsd: 6_090_585, address: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436" },
  { ticker: "SPYB", name: "S&P 500", platform: "bstock", reservesUsd: 2_149_825, volume24hUsd: 6_011_759, address: "0x7138b48df7D98D7e3cc221BfE7192D0a178182D8" },
  // MSTRB, METAB, COINB: reserves/volume are verified (verified-facts.md
  // "Liquidity" table), but no contract address for these three was ever
  // independently confirmed there - not invented here either.
  { ticker: "MSTRB", name: "STRATEGY", platform: "bstock", reservesUsd: 175_003, volume24hUsd: 238_789, note: "address not independently verified - see docs/research/verified-facts.md" },
  { ticker: "MSFTB", name: "MICROSOFT", platform: "bstock", reservesUsd: 201_716, volume24hUsd: 5_450, address: "0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0" },
  { ticker: "METAB", name: "META", platform: "bstock", reservesUsd: 56_603, volume24hUsd: 11_390, note: "address not independently verified - see docs/research/verified-facts.md" },
  { ticker: "COINB", name: "COINBASE", platform: "bstock", reservesUsd: 73_214, volume24hUsd: 778, note: "address not independently verified - see docs/research/verified-facts.md" },

  // Ondo territory - verified-facts.md §2 "viable only as a second leg"
  { ticker: "NVDAon", name: "NVIDIA", platform: "ondo", reservesUsd: 13_500, volume24hUsd: 1_300, address: "0xa9ee28c80f960b889dfbd1902055218cba016f75", note: "~200x thinner than NVDAB" },

  // xStocks wasteland - friction-log B8, "commercially dead"
  { ticker: "TSLAx", name: "TESLA", platform: "xstock", reservesUsd: 324, volume24hUsd: 0, address: "0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0", note: "$0.00 24h volume - genuinely deployed, not tradeable" },
  // AAPLx: verified-facts.md only reports "pools hold under $2" in prose, no
  // per-pool address was recorded - not invented here.
  { ticker: "AAPLx", name: "APPLE", platform: "xstock", reservesUsd: 2, volume24hUsd: 0, note: "pools hold under $2; address not independently verified" },
];

export const PLATFORM_LABEL: Record<Platform, { name: string; blurb: string; color: string }> = {
  bstock: { name: "bSTOCKS TOWN", blurb: "Busy shops", color: "#3ecf8e" },
  ondo: { name: "ONDO VILLAGE", blurb: "One tiny shop", color: "#6ea8fe" },
  xstock: { name: "xSTOCKS WASTELAND", blurb: "Nobody trades here", color: "#e7c98f" },
};

/** "$8.9M", "$13.5K", "$324" - short enough for a shop sign. */
export function fmtUsdShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
