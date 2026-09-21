# check

Read Covenant's real on-chain state for a token and get the guard's actual decision for a proposed trade - all read-only, no transaction, no gas.

## Why this is the step that actually matters

Covenant's `guardedSwap` never reverts on a denial (see the contract-level NatSpec in `contracts/Covenant.sol`); it soft-declines and emits an `Attestation(allowed: false, reason: ...)` event instead, so the refusal leaves an on-chain trace instead of vanishing with the rest of a reverted transaction's state. That design choice has a direct consequence for this skill: `baw contract-call preview`'s own simulation cannot tell you whether a proposed trade will be allowed or denied - it will report a "successful" simulation either way, because the call itself doesn't fail. **`check` is the only way to know the real answer before spending a preview/execute round trip on it.**

## Syntax

```bash
node scripts/cli.mjs check '{"rpcUrl":"<RPC_URL>","covenantAddress":"<COVENANT_ADDRESS>","tokenAddress":"<TOKEN_ADDRESS>","amountIn":"<AMOUNT_WEI>"}'
```

| Parameter | Required | Description |
|---|---|---|
| `rpcUrl` | Yes | Any BSC JSON-RPC endpoint. Public endpoints work; see `docs/partner-feedback/friction-log.md` B12 for which free-tier ones actually serve current state reliably. |
| `covenantAddress` | Yes | The deployed Covenant contract. |
| `tokenAddress` | Yes | The exact token address from `resolve` - never a bare ticker. |
| `amountIn` | Yes | Proposed trade size, in the quote token's smallest unit (USDT wei - 18 decimals on BSC). |

## Example

```bash
$ node scripts/cli.mjs check '{"rpcUrl":"https://bsc-dataseed.binance.org","covenantAddress":"0x...","tokenAddress":"0x02fca66c1d1afb4e2a7884261eb00f63598a7436","amountIn":"1000000000000000000"}'
{
  "tokenAddress": "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
  "allowlisted": true,
  "mandate": {
    "active": true,
    "maxNotionalPerTrade": "50000000000000000000",
    "maxTradesPerDay": "10",
    "expiry": "1792571679"
  },
  "oracle": {
    "halted": false,
    "updatedAt": "1789979683"
  },
  "decision": {
    "allowed": true,
    "reason": "None"
  }
}
```

## Reading `decision.reason`

One of: `None` (allowed), `MandateInactive`, `MandateExpired`, `TokenNotAllowed`, `NotionalExceeded`, `DailyLimitExceeded`, `OracleStale`, `OracleHalted` - these mirror `Covenant.sol`'s `DenialReason` enum exactly. Surface the reason to the user in plain language; don't just say "denied."

- `TokenNotAllowed` almost always means either the wrong provider's address was resolved (go back to `resolve`), or the mandate genuinely never allowlisted this token - ask the user which.
- `OracleStale` means the on-chain oracle hasn't been refreshed recently enough to trust (see `scripts/oracle-updater.ts`) - this is an operational gap, not something the user can fix by retrying.
- `DailyLimitExceeded` will clear on its own at the next UTC day boundary - tell the user when, using `mandate.maxTradesPerDay` and the current time, rather than just "try again later."
