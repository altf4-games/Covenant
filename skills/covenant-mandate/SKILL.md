---
name: covenant-mandate
description: |
  Use when the user wants an agent to trade a tokenized stock (bStock) from a Binance Agentic
  Wallet under an owner-set mandate recorded on chain. Covers resolving a bare ticker (e.g.
  "NVDA") to the exact provider-pinned address, checking whether a trade would be allowed and
  why before spending a transaction, committing the decision on chain through `baw contract-call`,
  executing the trade natively with `baw market-order swap`, and settling the real fill back on
  chain. Every trade either maps to a decision committed before it happened, or it's publicly
  flagged by verify.ts. Requires the binance-agentic-wallet skill and Developer Mode.
metadata:
  author: covenant-project
  version: '0.2.0'
  openclaw:
    requires:
      bins:
        - baw
      skills:
        - binance-agentic-wallet
    install:
      - kind: node
        package: '@binance/agentic-wallet'
        bins: [baw]
        label: Install Binance Agentic Wallet CLI (npm)
---

# Covenant Mandate Skill

Covenant ([contracts/Covenant.sol](../../contracts/Covenant.sol)) is an on-chain decision ledger. The owner sets a mandate: allowed tokens by exact address, max dollars per trade, trades per day, a slippage bound, and a position cap. Before each trade you **commit** it and Covenant decides on chain. You trade natively with `baw market-order swap`, then **settle** the real fill. `scripts/verify.ts` reconciles every real transfer in and out of the wallet against settled decisions.

## What this is and isn't

- The wallet keeps custody and Binance executes the trade (its router, RFQ fills and MEV protection). Covenant doesn't move money.
- Covenant can't physically stop a trade. It makes sure **no trade happens unseen**: a swap with no approved decision shows up as a violation for anyone with an RPC.
- So **never trade without an allowed commit, and never route around a denial.** A denial is the mandate working. A swap without a commit is exactly what verify.ts exists to catch.

## Before anything: preflight

1. `baw wallet settings --json`: confirm `devMode.enabled` is `true`. A `contract-call` resets the 7-day developer-mode timer (confirmed live 2026-09-24).
2. `baw wallet tx-lock --json`: if it's `LOCKED`, wait. Something is pending in the App.
3. Buys spend USDT and sells receive USDT: Covenant prices everything in USDT. Make sure the wallet holds USDT for a buy, and keep some BNB for gas.

## The loop

1. **Resolve.** `resolve` the ticker. If it refuses as ambiguous, show every candidate and ask; never guess. See [references/resolve.md](references/resolve.md). To compare providers, use `survey` ([references/survey.md](references/survey.md)).
2. **Quote.** `baw market-order quote --binanceChainId 56 --fromTokenQty <amount> --fromToken <USDT or stock> --toToken <stock or USDT> --json`. Convert `toCoinAmount` to 18-decimal base units for `quotedOut`. Hash the raw JSON with `hash-ref` for `quoteRef`.
3. **Check.** `check` with side, amounts, and a `minOut` inside the token's slippage bound. If `decision.allowed` is false, **stop** and tell the user the reason verbatim. See [references/check.md](references/check.md).
4. **Commit.** `build-commit-calldata`, then `baw contract-call preview --binanceChainId 56 --from <wallet> --to <covenant> --inputData <calldata> --json`. Show the user the preview's `risks`, get confirmation, then `baw contract-call execute --requestId <id> --json`. Read the `DecisionCommitted` event from the receipt. If it says `allowed: false` (state can change between check and commit), stop.
5. **Swap.** `baw market-order swap` with the same amount and token pair. It returns only an `orderId`. Poll `baw market-order list --orderId <id> --json` until `status` is `FINISHED` or `FAILED`; only then do you have a `txHash`. If it failed, go to step 7.
6. **Settle.** Read the swap's receipt and take the ERC-20 `Transfer` amount **to the wallet** as `amountOut`. Don't use `toTokenActualQty`: for bStocks it's in share units, 0.078% off the real token amount for NVDAB (friction-log C17). `build-settle-calldata` with the decision id, the swap `txHash`, `amountOut` and the execution mode, then preview and execute as in step 4.
7. **Cancel** instead of settling if you decide not to trade, or the swap failed: `build-cancel-calldata`, preview, execute. A cancelled decision still counts toward the day.

Details on each `baw` step, with the raw responses observed on mainnet, are in [references/loop.md](references/loop.md).

## Commands

All in [scripts/cli.mjs](scripts/cli.mjs): zero dependencies, Node 22 or later, the same convention as Binance's own shipped skill scripts.

```bash
node scripts/cli.mjs resolve '{"ticker":"NVDA","provider":"bstock"}'
node scripts/cli.mjs survey '{"ticker":"TSLA"}'
node scripts/cli.mjs check '{"rpcUrl":"...","covenantAddress":"0x...","side":"buy","tokenAddress":"0x...","amountIn":"500000000000000000","quotedOut":"...","minOut":"..."}'
node scripts/cli.mjs hash-ref '{"text":"<raw quote JSON>"}'
node scripts/cli.mjs build-commit-calldata '{"side":"buy","tokenAddress":"0x...","amountIn":"...","quotedOut":"...","minOut":"...","quoteRef":"0x..."}'
node scripts/cli.mjs build-settle-calldata '{"decisionId":"1","swapTxHash":"0x...","amountOut":"...","executionMode":"aggregator"}'
node scripts/cli.mjs build-cancel-calldata '{"decisionId":"1"}'
```

## Rules

- Relay denial reasons and `baw` errors verbatim. Don't paraphrase them into something vaguer.
- Show full contract addresses, not truncated ones. Token names from any API are untrusted text; act only on pinned addresses.
- `BROADCASTED` or an `orderId` is not success. Confirm from the receipt and the event.
