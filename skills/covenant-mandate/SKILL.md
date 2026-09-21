---
name: covenant-mandate
description: |
  Use when the user wants to propose, check, or execute a tokenized-stock trade that must go
  through Covenant's on-chain execution mandate before it can happen - a contract that decides,
  on chain, whether a proposed swap is allowed, and writes an attestation either way. Covers:
  resolving a bare stock ticker (e.g. "NVDA") to the exact provider-pinned contract address a
  mandate actually permits, checking whether a proposed trade would be allowed or denied and why
  before spending a transaction on it, and driving `baw contract-call preview/execute` against
  Covenant once a trade is confirmed allowed. Requires the binance-agentic-wallet skill and
  Developer Mode - Covenant is the contract that decision sits behind, this skill does not sign
  or broadcast anything on its own.
metadata:
  author: covenant-project
  version: '0.1.0'
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

Drives a real on-chain contract, `Covenant.sol` ([contracts/Covenant.sol](../../contracts/Covenant.sol)), that sits between an agent and PancakeSwap. A human sets a mandate once (allowed tokens, max notional per trade, max trades per day, expiry); this skill proposes trades against it, and the contract decides, on chain, whether each one happens.

## Why this skill exists, not just `market-order swap`

`binance-agentic-wallet`'s own `market-order swap` calls PancakeSwap directly - there is no guard in the middle. Routing the same trade through Covenant via `contract-call preview/execute` means the mandate is enforced on chain, not just claimed in a prompt: even Binance's own backend can't override it, and the resulting `Attestation` event is independently verifiable by anyone with an RPC endpoint.

## The one thing that makes this skill necessary, not decorative

Covenant's `guardedSwap` **never reverts on a denial** - see the NatSpec in `Covenant.sol`. A denied trade still emits `Attestation(allowed: false, reason: ...)` and returns, so the refusal has an on-chain trace instead of vanishing with a reverted transaction. The consequence: `baw contract-call preview`'s own simulation will show this call "succeeding" whether the trade is actually allowed or denied - the simulation layer alone cannot distinguish them. **Always run this skill's own `check` command first.** It reads `previewDecision` directly and tells you the real answer before you spend a preview/execute round trip on a call that was already going to be denied.

## Flow

1. **Resolve the ticker.** Run `resolve` with the ticker the user gave you (e.g. `NVDA`). If it refuses with an ambiguity error, **do not guess** - show the user every candidate it listed (provider and chain) and ask them to pick one, or ask which provider Covenant's mandate was actually set up for. See [references/resolve.md](references/resolve.md).
2. **Check the mandate's real decision.** Run `check` with the resolved address and the proposed `amountIn`. Read `decision.allowed` and `decision.reason` directly - this is Covenant's actual answer, not an inference. See [references/check.md](references/check.md).
3. **If denied: stop.** Tell the user the exact reason (`TokenNotAllowed`, `NotionalExceeded`, `DailyLimitExceeded`, `OracleStale`, `OracleHalted`, `MandateExpired`, `MandateInactive`). **Never suggest `market-order swap` or any other unguarded path as a workaround.** A denial is the mandate working as intended, not an error to route around.
4. **If allowed: build the calldata.** Run `build-swap-calldata` with the same token, a PancakeSwap V3 fee tier (2500 = 0.25%, the tier Covenant's fork tests use for NVDAB/USDT - confirm the actual pool fee for other tokens), `amountIn`, and an `amountOutMinimum` you've sized against a real quote (e.g. `baw market-order quote` or PancakeSwap's QuoterV2) with a slippage buffer.
5. **Preview through `baw`.** Run `baw contract-call preview --binanceChainId 56 --from <agentWallet> --to <covenantAddress> --value 0 --inputData <calldata from step 4> --json`. Show the user the parsed transaction and any `risks` - this is Binance's own simulation and risk layer, still worth showing even though it can't tell allow from deny on its own (see above).
6. **Execute only after explicit confirmation**, with `baw contract-call execute --requestId <id from preview> --json`. Report the resulting `txHash` back to the user.

Full syntax for steps 5-6 is in `binance-agentic-wallet`'s own [references/external-sign.md](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md) - this skill doesn't repeat it, only the parts specific to calling Covenant.

## Commands

All three live in [scripts/cli.mjs](scripts/cli.mjs) - self-contained, zero dependencies, Node ≥ 22, same convention as Binance's own shipped skill scripts (see `query-token-info/scripts/cli.mjs` in `binance-skills-hub` for the pattern this follows).

```bash
node scripts/cli.mjs resolve '{"ticker":"NVDA","provider":"bstock"}'
node scripts/cli.mjs check '{"rpcUrl":"https://bsc-dataseed.binance.org","covenantAddress":"0x...","tokenAddress":"0x...","amountIn":"1000000000000000000"}'
node scripts/cli.mjs build-swap-calldata '{"tokenOut":"0x...","fee":2500,"amountIn":"1000000000000000000","amountOutMinimum":"1"}'
```

See [references/resolve.md](references/resolve.md) and [references/check.md](references/check.md) for full parameter and response detail.
