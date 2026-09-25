# check

Read Covenant's on-chain state for a token and get the decision `commit` would make right now. Read-only: no transaction, no gas.

## Why run this before every commit

Covenant's `commit` never reverts on a denial. It records the refusal as a `DecisionCommitted` event with `allowed: false`, so the refusal is on chain instead of vanishing with a reverted transaction. The side effect: `baw contract-call preview` simulates a successful call whether the trade would be allowed or denied. `check` calls `previewDecision`, which runs the same `_evaluate` as `commit`, so it tells you the real answer before you spend a transaction.

## Syntax

```bash
node scripts/cli.mjs check '{"rpcUrl":"<RPC_URL>","covenantAddress":"<COVENANT>","side":"buy","tokenAddress":"<TOKEN>","amountIn":"<BASE_UNITS>","quotedOut":"<BASE_UNITS>","minOut":"<BASE_UNITS>"}'
```

| Parameter | Required | Description |
|---|---|---|
| `rpcUrl` | Yes | Any BSC JSON-RPC endpoint. See `docs/partner-feedback/friction-log.md` B12 for which free ones serve current state. |
| `covenantAddress` | Yes | The deployed Covenant contract. |
| `side` | Yes | `buy` (spend USDT, receive the stock) or `sell` (spend the stock, receive USDT). |
| `tokenAddress` | Yes | The exact stock token address from `resolve`, never a bare ticker. |
| `amountIn` | Yes | What you spend, in 18-decimal base units: USDT for a buy, stock tokens for a sell. |
| `quotedOut` | Yes | What `baw market-order quote` says you'll receive, in 18-decimal base units. |
| `minOut` | Yes | The least you'll accept. Must be within the token's `maxSlippageBps` of both `quotedOut` and the oracle price. |

Units: every amount is an 18-decimal integer string (BSC USDT and every bStock have 18 decimals). A human `0.5` becomes `"500000000000000000"`.

## Example

Real output from a local fork of BSC mainnet, 2026-09-25: a $0.50 NVDAB buy at the live oracle price, minimum 0.5% below the quote.

```bash
$ node scripts/cli.mjs check '{"rpcUrl":"http://127.0.0.1:8996","covenantAddress":"0x...","side":"buy","tokenAddress":"0x02fca66c1d1afb4e2a7884261eb00f63598a7436","amountIn":"500000000000000000","quotedOut":"...","minOut":"..."}'
{
  "side": "buy",
  "tokenAddress": "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
  "token": { "allowed": true, "maxSlippageBps": 100, "maxPositionUsd": "2000000000000000000" },
  "mandate": {
    "active": true,
    "maxNotionalPerTradeUsd": "1000000000000000000",
    "maxTradesPerDay": "10",
    "expiry": "1792911239",
    "tradesUsedToday": "0",
    "decisionOpen": false
  },
  "oracle": { "halted": false, "priceUsd": "225385263771369859276", "updatedAt": "1790319246" },
  "decision": { "allowed": true, "reason": "None" }
}
```

The same call with `"minOut":"1"` returns `SlippageTooLoose`.

## Reading `decision.reason`

These mirror `Covenant.sol`'s `DenialReason`. Tell the user the reason in plain words, never just "denied".

| Reason | What it means | What to do |
|---|---|---|
| `None` | Allowed. | Commit. |
| `MandateInactive` / `MandateExpired` | No active mandate. | Stop. Only the owner can set one. |
| `TokenNotAllowed` | This exact address isn't allowed. | Usually the wrong provider was resolved (NVDAon vs NVDAB). Go back to `resolve`, or ask the user. |
| `DecisionOpen` | An approved decision is still in flight. | Settle or cancel it first. |
| `OracleStale` | The oracle hasn't been refreshed within its bound. | Operational, not fixable by retrying. The updater has to run. |
| `OracleHalted` | The market or the asset is halted or closed. | Stop. Tell the user the market status. |
| `NotionalExceeded` | The trade is bigger than the per-trade cap (sells are valued at the oracle price). | Offer a smaller trade. |
| `DailyLimitExceeded` | The day's trade count is used up. | It resets at the next UTC midnight. Say when. |
| `SlippageTooLoose` | `minOut` is too far below the quote or the oracle price, or the quote is zero. | Re-quote and set `minOut` within `token.maxSlippageBps`. |
| `PositionLimit` | After this buy the wallet's real holding would exceed `token.maxPositionUsd`. | Offer a smaller buy, or stop. |
| `ClosedMarketDrift` | The NYSE's regular session is closed (`oracle.sessionOpen` is false) and this buy is priced more than `token.maxClosedMarketDriftBps` above the last close (`oracle.lastCloseUsd`), or this sell that far below it. | Tell the user the market is closed and the token is trading at a premium (or discount) to its last close. Wait for the open, or stop. |
