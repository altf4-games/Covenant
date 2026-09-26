// Type-only re-declaration of status-page/lib.mjs's exported shapes - a
// plain .mjs file outside `src` that TS's bundler resolution won't
// type-check directly against (see the @ts-expect-error in covenant.ts).
// The real behavior is defined and tested in test/status-page.live.ts, in
// the main project's Node/Mocha suite.
export interface Boss {
  name: string;
  icon: string;
  flagship?: boolean;
}

export interface CommitInfo {
  token: string;
  side: "buy" | "sell";
  allowed: boolean;
  reason: string;
  amountIn: bigint;
  quotedOut: bigint;
  minOut: bigint;
  expiresAt: number;
  mandateMaxNotionalPerTradeUsd: bigint;
  mandateMaxTradesPerDay: bigint;
  mandateExpiry: number;
  oracleUpdatedAt: number;
  blockNumber: number;
  txHash: string;
}

export interface SettleInfo {
  swapTxHash: string;
  amountOut: bigint;
  executionMode: string;
  belowMin: boolean;
  txHash: string;
}

export interface Decision {
  id: string;
  commit: CommitInfo | null;
  settle: SettleInfo | null;
  cancelled: boolean;
}
