# Covenant

An on-chain execution mandate for tokenized-stock trades on BSC. A human sets a mandate (which tokens, how much per trade, how many trades a day, until when). An agent proposes swaps against it. A small contract decides, on chain, whether the trade happens, and writes an attestation either way, so the decision is independently verifiable by anyone with an RPC endpoint.

Built for the BNB Hack: Tokenized Stocks Edition.

## Architecture

Everything lives in one contract, [`contracts/Covenant.sol`](contracts/Covenant.sol): the mandate, the oracle feed, and the guard that sits between an agent and PancakeSwap.

A few things worth knowing before reading the code:

- **Denials don't revert.** A reverted transaction discards every state change, including events, so a denial that reverted would leave no on-chain trace. Instead, `guardedSwap` checks the mandate and oracle first; if the trade is denied, it emits `Attestation(..., allowed: false, reason: ...)` and returns without touching any balance. The transaction still mines and costs gas only.
- **Non-custodial.** Covenant never holds trading funds between calls. The caller approves the quote token beforehand; a call that passes the guard pulls exactly `amountIn`, swaps it, and has PancakeSwap deliver the output straight to the caller.
- **Provider pinning, not ticker resolution.** The allowlist is exact addresses, set by the owner. There's no on-chain ticker-to-address lookup, because that's exactly where the two real problems in this space show up: a ticker existing under multiple providers (real NVDAB vs. Ondo's NVDAon), and outright impersonator contracts. Ticker resolution happens off chain, in the skill (below) - and refuses to guess rather than silently picking one.

Two more pieces sit around the contract:

- [`skills/covenant-mandate/`](skills/covenant-mandate/) - a Binance Wallet Skill (zero-dep `scripts/cli.mjs`, Node ≥22, matching Binance's own shipped-skill convention) that resolves tickers to exact addresses, reads Covenant's real on-chain decision for a proposed trade before spending a transaction on it, and drives `baw contract-call preview/execute` against Covenant once a trade is confirmed allowed. See its `SKILL.md` for why the guard's non-reverting denial design makes this skill's own `check` command necessary, not decorative.
- [`status-page/index.html`](status-page/index.html) - a single static file, no backend, no build step. Reads mandate state and `Attestation` events straight from any RPC + contract address.

## Running the tests

```bash
npm install
npx hardhat test
```

Four suites, 35 tests total:

- `test/Covenant.unit.ts` - fast, runs against an in-memory chain with a minimal mock ERC20 and mock router, so Covenant's own bookkeeping (daily counters, notional checks, the reentrancy guard) can be tested without a network call.
- `test/Covenant.fork.ts` - runs against a real fork of BSC mainnet: real USDT, real NVDAB, the real PancakeSwap V3 SwapRouter, funded by impersonating a real USDT holder. This is what actually proves the mock harness's assumptions hold against the real integration.
- `test/oracle-updater.live.ts` - calls Binance's real public RWA status endpoint over the network (not mocked), writes the real result on chain, and reads it back.
- `test/skill-cli.live.ts` - spawns a real `hardhat node --fork`, deploys a real Covenant to it, and drives the Wallet Skill's own CLI commands against that real JSON-RPC server, the same way it's actually invoked in production.

The fork and live suites are slower than a typical Hardhat suite, and that's expected rather than a flake - see "Tests, and what they caught" below.

## Running the status page

```bash
python3 -m http.server 4173 --directory status-page
```

Open `http://localhost:4173`, and point it at any RPC URL and a deployed Covenant address (or pass them as `?rpc=...&contract=...&fromBlock=...` query params). `scripts/seed-status-page-demo.ts` deploys a Covenant to a local `hardhat node --fork` and generates a few real allow/deny events, if you want something to look at immediately.

## Tests, and what they caught

### A missing struct field silently broke every real swap

`contracts/Covenant.sol`'s interface for PancakeSwap's V3 `SwapRouter` was written from memory of the general Uniswap-V3-style `ExactInputSingleParams` shape: `tokenIn`, `tokenOut`, `fee`, `recipient`, `amountIn`, `amountOutMinimum`, `sqrtPriceLimitX96`. It compiled fine and passed every unit test, because the unit suite's mock router was written against the same (wrong) shape.

The fork suite caught it immediately: the very first real swap against the real router reverted with no reason string. Tracing it back, PancakeSwap's actual `ExactInputSingleParams` (confirmed against `github.com/pancakeswap/pancake-v3-contracts`) has an extra `deadline` field sitting between `recipient` and `amountIn`. Solidity happily compiles a struct missing a field - it's still well-formed - but the ABI encoding sent to the real router was garbled from `amountIn` onward, since every field after the missing one was shifted into the wrong position.

Fix: added `deadline` to the interface, matching PancakeSwap's real layout, and pass `block.timestamp` for it (an atomic single-transaction swap doesn't need a real deadline constraint, it's just a value the router's ABI requires). Updated the mock router to match, since it and the real interface need to stay in lockstep for the unit suite to mean anything.

This is exactly the kind of bug a live integration test exists to catch and a mocked-only suite structurally cannot: the mock was internally consistent with itself, just not with reality.

### Fork tests against BSC are genuinely slower than the Hardhat defaults assume

Not a Covenant bug, but real enough to affect how the test suite is written, so it's documented here rather than only in the friction log. Hardhat 3's fork provider fetches remote state via `eth_getProof`, and BSC's state trie returns meaningfully larger proofs per call than Ethereum's. Against a free-tier public RPC, a naive one-fork-per-test structure (via `loadFixture`) pushed total run time past three minutes and past Mocha's default 40-second-per-test timeout.

Fixed by forking and funding once per suite instead of once per test, and by reading transaction results off the receipt (`tx.wait()`) instead of a separate `queryFilter` call - the latter issues its own `eth_getLogs` request, which is an easy way to burn through a free-tier rate limit for data you already have in hand. Full details, including the exact RPC responses, are in [`docs/partner-feedback/friction-log.md`](docs/partner-feedback/friction-log.md) (B12-B14).

### The ticker resolver silently picked the wrong chain, one axis deeper than the bug it was written to prevent

`skills/covenant-mandate/scripts/cli.mjs`'s `resolve` command exists specifically to stop a bare ticker like `NVDA` from silently resolving to the wrong token - the documented trap being a ticker existing under multiple *providers* (real `DRAMon` vs. `DRAMB`). The first version guarded exactly that: given a ticker with no explicit provider, it refused if more than one provider matched.

Testing it live against Binance's real token list found a second, real axis of the same problem that the design had missed entirely: a single provider can list the same ticker on multiple *chains* at once. Real `NVDAon` (Ondo) exists on Ethereum, BSC, and Solana simultaneously. Given `{ ticker: "NVDA", provider: "ondo" }` - provider fully specified, seemingly unambiguous - the first version returned `matches[0]`: the Ethereum-mainnet address, not BSC's, with no error and no indication anything was wrong. For a project scoped to BSC only, that's a silent wrong-chain resolution, not a crash - the worse kind of bug.

Fix: `resolve` now requires both the provider axis and the chain axis to collapse to exactly one match before returning anything. The only implicit default left in is a BSC (`56`) default when that alone already narrows the result to one match - since this project only ever targets BSC, applying that default is safe; picking an arbitrary chain when multiple remain is not. Covered by a regression test in `test/skill-cli.live.ts` that asserts the specific case that broke (`provider: "ondo"`, no `chainId`, must return BSC's address).

This is the same category of finding as the PancakeSwap `deadline` bug above: caught only because the test called the real endpoint with real data instead of asserting against values the test itself had assumed.

### `??` isn't enough for values coming from `.env`, and two scripts talking past each other

Two real bugs, found in the same ten minutes wiring up `.env` for the first time.

First: `hardhat.config.ts`'s `BSC_RPC_URL` and `oracle-updater.ts`'s `ORACLE_TOKEN_ADDRESS`/`ORACLE_BINANCE_CHAIN_ID` all used `process.env.X ?? default`. That's correct for a variable that's either set or completely absent - but `.env.example` ships those keys present and deliberately blank (`BSC_RPC_URL=`), and once `.env` actually got loaded (see below), `process.env.BSC_RPC_URL` became `""` - present, not `undefined`. `??` only falls back on `null`/`undefined`, so the empty string sailed straight through and Hardhat rejected it as an invalid URL. Fixed by switching to `||` everywhere a `.env` value has a default, across `hardhat.config.ts`, `scripts/deploy.ts`, and `scripts/oracle-updater.ts`.

Second, underneath the first one: none of this could even reproduce until `.env` was actually being loaded, because nothing loaded it - `hardhat.config.ts` never called anything like `dotenv/config`. Fixed with Node 22's built-in `process.loadEnvFile()`, no new dependency needed.

Third, once `.env` was loading and the URL bug was fixed, `oracle-updater.ts` still failed - `could not decode result data (value="0x")` reading back `oracleStatus`. The real cause: `--network bscFork` is an `edr-simulated` network, which means every single `npx hardhat run ... --network bscFork` invocation spins up its own fresh, throwaway in-process chain and discards it when the script exits. `deploy.ts` and `oracle-updater.ts`, run as two separate commands, were each deploying to / reading from a *different, unrelated* ephemeral chain - the contract `deploy.ts` had just verified moments earlier was simply gone by the time `oracle-updater.ts` started. (The transaction to update it still "succeeded," because sending calldata to an address with no contract code doesn't revert - it's silently a no-op, which is what made this confusing rather than a clean failure.) Fixed by adding a `localhost` network in `hardhat.config.ts` - a real `http` network pointed at a persistent, separately-run `hardhat node --fork` process - so state actually persists between separate script invocations the way a real deployment needs to. `bscFork`'s per-run isolation is exactly right for the test suite; it's just the wrong tool for "deploy once, then run other scripts against that same deployment later."
