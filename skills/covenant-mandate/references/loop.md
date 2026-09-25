# The commit -> swap -> settle loop, as observed on mainnet

Everything here comes from real calls on BSC mainnet on 2026-09-24. The raw responses are in `docs/evidence/day1-gate-*.json`.

## `contract-call preview` / `execute`

```bash
baw contract-call preview --binanceChainId 56 --from <wallet> --to <covenant> --inputData <calldata> --json
baw contract-call execute --requestId <requestId> --json
```

- Against a freshly deployed, **BscScan-verified** contract, preview came back with no risk flags and `requireConfirmation: false`. Execute returned `BROADCASTED` with a `txHash` right away, with no App confirmation needed.
- If preview ever returns `requireConfirmation: true`, execute returns `PENDING_CONFIRMATION` with no `txHash`. There is no `contract-call result` command. Find the hash afterwards with `baw wallet tx-history`.
- Preview's `parsedTx` only shows the 4-byte selector as `action`. It doesn't decode arguments or events, and `simulationResult` shows a success for an allowed and a denied commit alike. That's why `check` exists.
- Get the decision id and outcome from the `DecisionCommitted` event in the execute transaction's receipt, not from the preview.

## `market-order quote` / `swap`

```bash
baw market-order quote --binanceChainId 56 --fromTokenQty 0.5 --fromToken <USDT> --toToken <NVDAB> --json
baw market-order swap  --binanceChainId 56 --fromTokenQty 0.5 --fromToken <USDT> --toToken <NVDAB> --json
baw market-order list  --orderId <orderId> --json
```

- The quote worked without any API-key error (another hackathon entrant reported `40101` at this step).
- `swap` returns **only an `orderId`**. The fill and its `txHash` appear only in `market-order list`, once `status` is `FINISHED`. Poll until it's `FINISHED` or `FAILED`.
- No App confirmation was needed for the swap.
- The Day-1 fill went through Binance's router contract (`0xb300000b72deaeb607a12d5f54773d1c19c7028d`) with several hops, not straight to one pool. The responses have no field saying whether a fill was RFQ or pool - checked the raw JSON directly (`docs/evidence/day1-gate-{quote,swap}.json`), not just the summarized fields; there is genuinely nothing to read. Record `aggregator` when the swap transaction's `to` is that router, and `unknown` otherwise; don't guess `rfq` or `pool`. `node scripts/cli.mjs classify-execution-mode '{"to":"<swap tx to address>"}'` applies this rule in code now, against the same real router address plus PancakeSwap V3's (the fork's stand-in execution venue, `pool`).

## The amount to settle with

`market-order list` reported `toTokenActualQty: "0.001578888415748593"`. The ERC-20 `Transfer` to the wallet in the same transaction was `0.001577660642762526`. The first figure is in bStock *share* units, the second in *token* units, and the ratio is NVDAB's shares multiplier (1.000778). `balanceOf` moves by the token amount.

**Settle with the `Transfer` amount to the wallet from the swap receipt.** verify.ts compares settles against those real transfers, so settling with `toTokenActualQty` would flag an honest trade. The quote's `toCoinAmount` is in share units too, but the difference is far inside any sensible slippage bound, so it's fine as `quotedOut`.
