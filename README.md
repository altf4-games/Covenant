# Covenant

An on-chain execution mandate for tokenized-stock trades on BSC. A human sets a mandate (which tokens, how much per trade, how many trades a day, until when). An agent proposes swaps against it. A small contract decides, on chain, whether the trade happens, and writes an attestation either way, so the decision is independently verifiable by anyone with an RPC endpoint.

Built for the BNB Hack: Tokenized Stocks Edition.

## Architecture

Everything lives in one contract, [`contracts/Covenant.sol`](contracts/Covenant.sol): the mandate, the oracle feed, and the guard that sits between an agent and PancakeSwap.

A few things worth knowing before reading the code:

- **Denials don't revert.** A reverted transaction discards every state change, including events, so a denial that reverted would leave no on-chain trace. Instead, `guardedSwap` checks the mandate and oracle first; if the trade is denied, it emits `Attestation(..., allowed: false, reason: ...)` and returns without touching any balance. The transaction still mines and costs gas only.
- **Non-custodial.** Covenant never holds trading funds between calls. The caller approves the quote token beforehand; a call that passes the guard pulls exactly `amountIn`, swaps it, and has PancakeSwap deliver the output straight to the caller.
- **Provider pinning, not ticker resolution.** The allowlist is exact addresses, set by the owner. There's no on-chain ticker-to-address lookup, because that's exactly where the two real problems in this space show up: a ticker existing under multiple providers (real NVDAB vs. Ondo's NVDAon), and outright impersonator contracts.

## Running the tests

```bash
npm install
npx hardhat test
```

Two suites:

- `test/Covenant.unit.ts` - fast, runs against an in-memory chain with a minimal mock ERC20 and mock router, so Covenant's own bookkeeping (daily counters, notional checks, the reentrancy guard) can be tested without a network call.
- `test/Covenant.fork.ts` - runs against a real fork of BSC mainnet: real USDT, real NVDAB, the real PancakeSwap V3 SwapRouter, funded by impersonating a real USDT holder. This is what actually proves the mock harness's assumptions hold against the real integration.

The fork tests are slower than a typical Hardhat suite, and that's expected rather than a flake - see "Tests, and what they caught" below.

## Tests, and what they caught

### A missing struct field silently broke every real swap

`contracts/Covenant.sol`'s interface for PancakeSwap's V3 `SwapRouter` was written from memory of the general Uniswap-V3-style `ExactInputSingleParams` shape: `tokenIn`, `tokenOut`, `fee`, `recipient`, `amountIn`, `amountOutMinimum`, `sqrtPriceLimitX96`. It compiled fine and passed every unit test, because the unit suite's mock router was written against the same (wrong) shape.

The fork suite caught it immediately: the very first real swap against the real router reverted with no reason string. Tracing it back, PancakeSwap's actual `ExactInputSingleParams` (confirmed against `github.com/pancakeswap/pancake-v3-contracts`) has an extra `deadline` field sitting between `recipient` and `amountIn`. Solidity happily compiles a struct missing a field - it's still well-formed - but the ABI encoding sent to the real router was garbled from `amountIn` onward, since every field after the missing one was shifted into the wrong position.

Fix: added `deadline` to the interface, matching PancakeSwap's real layout, and pass `block.timestamp` for it (an atomic single-transaction swap doesn't need a real deadline constraint, it's just a value the router's ABI requires). Updated the mock router to match, since it and the real interface need to stay in lockstep for the unit suite to mean anything.

This is exactly the kind of bug a live integration test exists to catch and a mocked-only suite structurally cannot: the mock was internally consistent with itself, just not with reality.

### Fork tests against BSC are genuinely slower than the Hardhat defaults assume

Not a Covenant bug, but real enough to affect how the test suite is written, so it's documented here rather than only in the friction log. Hardhat 3's fork provider fetches remote state via `eth_getProof`, and BSC's state trie returns meaningfully larger proofs per call than Ethereum's. Against a free-tier public RPC, a naive one-fork-per-test structure (via `loadFixture`) pushed total run time past three minutes and past Mocha's default 40-second-per-test timeout.

Fixed by forking and funding once per suite instead of once per test, and by reading transaction results off the receipt (`tx.wait()`) instead of a separate `queryFilter` call - the latter issues its own `eth_getLogs` request, which is an easy way to burn through a free-tier rate limit for data you already have in hand. Full details, including the exact RPC responses, are in [`docs/partner-feedback/friction-log.md`](docs/partner-feedback/friction-log.md) (B12-B14).
