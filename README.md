# Covenant

An on-chain execution mandate for tokenized-stock trades on BSC. A human sets a mandate (which tokens, how much per trade, how many trades a day, until when). An agent proposes swaps against it. A small contract decides, on chain, whether the trade happens, and writes an attestation either way, so the decision is independently verifiable by anyone with an RPC endpoint.

Built for the BNB Hack: Tokenized Stocks Edition. Everything on this page is backed by a real transaction against real deployed bytecode - no card, panel, or claim here comes from a mock.

The closest verified prior art in this category (Harness, ETHOnline 2026, Ledger's "AI Agents x Ledger" 1st place) enforces a single daily spend budget with no reasoned per-decision record. Covenant's guard evaluates a richer mandate - spend limits, halt status, provider-pinned allowlisting - and attests every decision, allow or deny, verifiable by anyone reading chain state. And unlike an advisory critique-agent pattern that rates a decision after the fact, Covenant's guard is the actual precondition for execution: the trade cannot happen unless the guard says yes.

## Architecture

Everything lives in one contract, [`contracts/Covenant.sol`](contracts/Covenant.sol): the mandate, the oracle feed, and the guard that sits between an agent and PancakeSwap.

A few things worth knowing before reading the code:

- **Denials don't revert.** A reverted transaction discards every state change, including events, so a denial that reverted would leave no on-chain trace. Instead, `guardedSwap` checks the mandate and oracle first; if the trade is denied, it emits `Attestation(..., allowed: false, reason: ...)` and returns without touching any balance. The transaction still mines and costs gas only.
- **Preview and execute share one code path, not two.** `previewDecision` (the read-only call the skill's `check` command uses) and `guardedSwap` both call the same internal `_evaluate` - there's no separate simulation logic that could quietly drift from what actually executes. Directly tested in `test/Covenant.unit.ts`'s "preview/execute agreement" suite: call `previewDecision`, then call `guardedSwap` on the identical input, and assert the real `Attestation` reports exactly what was previewed.
- **Non-custodial.** Covenant never holds trading funds between calls. The caller approves the quote token beforehand; a call that passes the guard pulls exactly `amountIn`, swaps it, and has PancakeSwap deliver the output straight to the caller.
- **Provider pinning, not ticker resolution.** The allowlist is exact addresses, set by the owner. There's no on-chain ticker-to-address lookup, because that's exactly where the two real problems in this space show up: a ticker existing under multiple providers (real NVDAB vs. Ondo's NVDAon), and outright impersonator contracts. Ticker resolution happens off chain, in the skill (below) - and refuses to guess rather than silently picking one.

Two more pieces sit around the contract:

- [`skills/covenant-mandate/`](skills/covenant-mandate/) - a Binance Wallet Skill (zero-dep `scripts/cli.mjs`, Node ≥22, matching Binance's own shipped-skill convention) that resolves tickers to exact addresses, reads Covenant's real on-chain decision for a proposed trade before spending a transaction on it, and drives `baw contract-call preview/execute` against Covenant once a trade is confirmed allowed. See its `SKILL.md` for why the guard's non-reverting denial design makes this skill's own `check` command necessary, not decorative.
- [`status-page/index.html`](status-page/index.html) - a single static file, no backend, no build step. Reads mandate state and `Attestation` events straight from any RPC + contract address.
- [`mcp-server/index.ts`](mcp-server/index.ts) - an MCP server exposing the skill's own reads (`resolve_ticker`, `survey_providers`, `get_mandate_status`, `check_halt`, `preview_trade`) as MCP tools, so any MCP-capable agent (not just one driving `baw` directly) can query the mandate and the guard's real decision. Thin wrapper, no new logic - see the file's own header comment.

The skill's `resolve` refuses to guess when a ticker is ambiguous; its sibling command, `survey`, is the other half - report on all three providers (ondo, xstock, bstock) for a ticker at once, each labeled `not-listed-on-bsc`, `dead`, or `live`. "Dead" isn't taken from Binance's own reported `volume24h` - that figure was found, live, to be unreliable (see "Tests, and what they caught" below) - it's independently verified against real `eth_getLogs` Transfer-event activity on chain.

## Off-hours logging

`scripts/off-hours-logger.ts` polls real NVDA across all three providers (halt/market status, on-chain price, and reference price where one exists) and appends one real JSON line to [`data/off-hours-log.jsonl`](data/off-hours-log.jsonl). Run it once:

```bash
npx tsx scripts/off-hours-logger.ts
```

Or continuously, via cron (self-disabling - see `scripts/off-hours-cron.sh`'s own comments; it removes its own crontab entry once past the submission deadline, no manual cleanup needed):

```bash
crontab -e
# */15 * * * * /path/to/covenant/scripts/off-hours-cron.sh >> /path/to/covenant/data/off-hours-cron.log 2>&1
```

On macOS, `cron` needs Full Disk Access (System Settings → Privacy & Security) to reliably access files outside a few default locations - if the log file isn't growing, check that first before assuming the script is broken.

**Gaps in the data are expected and real, not a bug.** Confirmed live: the very first scheduled fire (11:01) succeeded, but the next one (11:15) was silently skipped because the Mac itself was asleep at that moment (`pmset -g log` showed a wake event at 11:20:41 - cron can't fire while the whole machine is suspended). On a laptop, any stretch where the lid was closed or it idle-slept shows up as a missing entry rather than a steady 15-minute cadence. Left as-is deliberately rather than forcing `caffeinate`/`pmset disablesleep` - the gaps are themselves honest data about running unattended infrastructure on a laptop, not something to paper over.

## Judge-runnable verification

A judge doesn't have this project's Agentic Wallet, developer mode, or bStock jurisdiction clearance - they can't reproduce a live trade themselves. `scripts/judge.ts` doesn't ask them to: point it at a deployed Covenant and a list of tx hashes, and it independently re-fetches each transaction's real receipt from chain, finds its `Attestation` event, and decodes it - allow/deny and the exact typed reason - without trusting anything this project says about it.

```bash
COVENANT_ADDRESS=0x... npm run judge
```

Reads the tx hash list from `JUDGE_TX_HASHES` (comma-separated) or [`data/judge-tx-hashes.json`](data/judge-tx-hashes.json). That file is empty until Phase 3's real BSC mainnet transactions exist - pointing this at mainnet then is a config change (RPC URL, contract address, that file), not new development. Built and live-tested now, against this project's own fork transactions, so the mechanism is proven before it has anything real to point at.

## Chaos-fork demo

`scripts/chaos-fork.ts` (`npm run chaos-fork`) is a one-command, standalone script that forks BSC mainnet, deploys a real Covenant, and then deliberately tries to break its own mandate - a scam impersonator token, a notional over the cap, a trade while the oracle reports a halt - plus one legitimate trade for contrast. Covenant's guard never reverts (see "Denials don't revert" above), so what a reverting design would show as a rejected transaction, this shows as a real `Attestation` event, independently re-decoded by `judge.ts`'s own `verifyAttestationTx` rather than printed from the script's own memory of what it just did.

```bash
npm run chaos-fork
```

A real run, reproducible from this exact script (fork state, so these hashes exist on that local fork, not BscScan - the real, independently-verifiable mainnet equivalent is what Phase 3's deployment adds to `judge.ts`'s tx list above):

| Attempt | tx hash | block | Result |
|---|---|---|---|
| Scam impersonator token | `0x3e9a1a87ccc7ecfed6c5bee9ed6e71422cd4422fe578857a185759ef38ece52d` | 123380137 | denied, `TokenNotAllowed` |
| Notional above the 10 USDT cap | `0x8d5b9ca4d7c2f4e9368967092311110a390fa4b6805e7fb33e8bf21ab075ba05` | 123380138 | denied, `NotionalExceeded` |
| Trade while oracle reports a halt | `0x6803b736a51898747bcee245f701d46392d40c4fa848fe4173cb82d04c2e26ed` | 123380140 | denied, `OracleHalted` |
| Same mandate, within cap, oracle healthy | `0xf613b4f37274d22fd2d8fde26314c95fad79fb3c1f2174de421758094a287dc1` | 123380142 | allowed, real swap executed |

`test/chaos-fork.live.ts` runs this exact command as a real subprocess and asserts on its real stdout - not a reimplementation of the script's logic, the actual thing a judge would type.

## Running the MCP server

```bash
npm run mcp-server
```

Speaks standard MCP over stdio. To register it with an MCP client (Claude Code, Cursor, etc.), point it at this repo:

```json
{
  "mcpServers": {
    "covenant-mandate": {
      "command": "npx",
      "args": ["tsx", "mcp-server/index.ts"],
      "cwd": "/path/to/covenant"
    }
  }
}
```

## Running the tests

```bash
npm install
npx hardhat test
```

Nine suites, 59 tests total:

- `test/Covenant.unit.ts` - fast, runs against an in-memory chain with a minimal mock ERC20 and mock router, so Covenant's own bookkeeping (daily counters, notional checks, the reentrancy guard) can be tested without a network call. Includes a dedicated "preview/execute agreement" pair proving `previewDecision` and `guardedSwap` never disagree on identical input.
- `test/Covenant.fork.ts` - runs against a real fork of BSC mainnet: real USDT, real NVDAB, the real PancakeSwap V3 SwapRouter, funded by impersonating a real USDT holder. This is what actually proves the mock harness's assumptions hold against the real integration.
- `test/oracle-updater.live.ts` - calls Binance's real public RWA status endpoint over the network (not mocked), writes the real result on chain, and reads it back.
- `test/skill-cli.live.ts` - spawns a real `hardhat node --fork`, deploys a real Covenant to it, and drives the Wallet Skill's own CLI commands against that real JSON-RPC server, the same way it's actually invoked in production.
- `test/status-page.live.ts` - spawns another real `hardhat node --fork`, deploys a real Covenant, generates two real denied trades, and proves the status page's event-reading logic both returns real data fast on a safe block range and fails fast (not hangs) on one that crosses the fork boundary - see "Tests, and what they caught" for why this suite's test order specifically matters.
- `test/mcp-server.live.ts` - spawns the MCP server itself as a real subprocess and drives it with the real `@modelcontextprotocol/sdk` client over the real MCP protocol (stdio), against a real forked node and a real deployed Covenant. Nothing about the MCP layer is mocked.
- `test/off-hours-logger.live.ts` - polls Binance's real live endpoints and writes real JSON lines to a real (temp) log file, confirming the logger that actually runs on cron works the way it's actually invoked.
- `test/judge.live.ts` - generates real deny and allow transactions against a real fork, then proves `judge.ts` independently re-derives the correct verdict from each real receipt - including a real tx hash that was never mined, to prove it reports a real failure rather than a false pass, and a genuinely dead RPC listed ahead of a working one, to prove the failover actually engages.
- `test/chaos-fork.live.ts` - spawns `npm run chaos-fork` itself as a real subprocess, the exact command a judge runs, and asserts on its real stdout rather than reimplementing the script's logic.

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

### The status page's real killer bug was only found by actually running it in a browser - so it got a real test, not just a writeup

Every bug above was caught by an automated test. This one wasn't - it took manually driving `status-page/index.html` against a real fork in a real browser to discover that a query range crossing the fork's boundary makes Hardhat's `eth_getLogs` hang forever (`docs/partner-feedback/friction-log.md` B16). Documenting that in the friction log was necessary but not sufficient: the page itself still had no actual defense against it, and "found once by hand" isn't the same as "verified to stay fixed."

Fixed properly, in two parts. First, the actual fix: `status-page/lib.mjs`'s `fetchAttestations` races the real `eth_getLogs` call against a client-side timeout, so a boundary-crossing query now fails in a few seconds with a message that names the real cause and points at the friction log entry, instead of a UI that spins forever with zero feedback. Second, `test/status-page.live.ts` - a live suite, spawning a real `hardhat node --fork`, deploying a real Covenant, generating two real denied trades - that exercises exactly this: a safe, locally-mined block range returns the real events in under 2 seconds, and a range crossing the fork boundary is asserted to reject within the timeout window rather than hang.

Writing that test caught two more real things in the process, not staged, found live running it:

- The "safe" boundary isn't `forkStartBlock` itself - a query starting *at* the fork's own pinned block still needs the same remote lookup as anything before it and hangs identically. Only blocks mined locally *after* the fork point are actually safe. The first version of the test used `fromBlock: forkStartBlock` and failed with the exact timeout error it was supposed to prove doesn't happen; fixed to `forkStartBlock + 1`.
- The node-wide degradation from a single hung `eth_getLogs` call - suspected from the manual browser session, where even unrelated calls started failing after one boundary-crossing query - reproduced automatically too: with the boundary-crossing test running before the safe-range one, the safe-range test started failing on a call that had worked moments earlier against a fresh node. Fixed by reordering the suite so the boundary-crossing (node-degrading) test runs last, and documented directly in the suite's own comments so the ordering requirement doesn't look accidental to the next person reading it.

### `Math.max(0, someBigInt)` throws, silently, inside a try/catch that made every RPC look broken

Building `survey` (compares a ticker's real BSC tradability across all three providers - see `docs/partner-feedback/friction-log.md` B17 for what it found on Binance's side), the independent on-chain check kept reporting `"all liquidity-check RPCs failed or rate-limited"` for every single provider, on every ticker, including tokens already proven extremely liquid moments earlier by an isolated manual `curl`.

The real cause had nothing to do with the RPCs. `countRecentTransfers`'s window-size math was `Math.max(0, BigInt(tip) - BigInt(blocksBack))` - and `Math.max` calls `ToNumber` on every argument, which throws `TypeError: Cannot convert a BigInt value to a number` for any BigInt input. That threw on the very first line of every attempt, was caught by the function's own `try { ... } catch { /* try the next RPC */ }` (there to handle real, expected RPC failures), and surfaced as a generic "all RPCs failed" message that pointed everywhere except the actual bug. `Math.max(0, 5n)` failing outright in the Node REPL is what actually found it, not the survey output itself.

Fixed by comparing the two `BigInt`s directly (`tip > window ? tip - window : 0n`) instead of routing them through `Math.max`. Once fixed, the same three providers that had all reported "unknown" a moment before returned real, sharply different numbers on the same call - `NVDAB` (bStock): 2177 real Transfer events in the same ~3000-block window `NVDAx` (xStock) had only 3 in. That contrast is real data `survey` is built to surface; the bug had been silently hiding all of it behind one bad line of arithmetic.

### `judge.ts` assumed helper functions were exported that never were

Writing `scripts/judge.ts`, importing `asBool`/`asUint` from `skills/covenant-mandate/scripts/cli.mjs` (used elsewhere in that file to decode `eth_call` results) failed immediately with `SyntaxError: The requested module does not provide an export named 'asBool'`. They're real functions in that file - just never added to its `export { ... }` line, because nothing outside the file had needed them directly before. Fixed by duplicating the two one-liners locally in `judge.ts` rather than widening `cli.mjs`'s public export surface for something this small - a static import error, not a runtime one, so it was caught immediately on the first run rather than silently.

### A "dead" provider stopped being dead between when the test was written and when it was rerun

`test/skill-cli.live.ts`'s GME survey test originally asserted all three legs by name: bstock live, ondo dead, xstock dead - verified live at the time of writing, not assumed. Rerunning the full suite days later, that exact assertion failed: `AssertionError: expected 'live' to equal 'dead'` on ondo's leg.

Re-checked independently outside the test harness before touching anything, per the same no-dummy-data standard the rest of this project holds to - a direct `COMMANDS.survey({ ticker: "GME" })` call showed ondo's `GMEon` now has 3 real `Transfer` events in the same 3000-block window that had zero when the test was written. Real on-chain activity, not a test bug, not an RPC flake, not stale caching - the token genuinely started trading between then and now.

The actual bug was in the test's design, not the code under test: it pinned a specific provider's liveness label to a single point-in-time snapshot, as if a tokenized-equity venue's activity were a fixed property instead of something that changes hour to hour. Fixed by keeping the assertions that are actually stable (bstock dominates, xstock stays genuinely dead, bstock's count exceeds ondo's) and deriving the expected label for ondo from its own freshly-observed transfer count instead of hardcoding what that count used to be. The lesson generalizes past this one test: any live-data assertion about which venues are "dead" needs to either re-derive its own expectation from the same call it's checking, or be treated as time-bound and revisited, not treated as a fixed fact once verified.

### `judge.ts` trusted a single RPC, which quietly undermined the reason it exists

`survey`'s `countRecentTransfers` already tries several BSC RPCs in sequence, precisely because a single free-tier endpoint was found live to be flaky (`docs/partner-feedback/friction-log.md` B12-B14). `scripts/judge.ts` was written later, for a different purpose, and didn't reuse that pattern - it called a single hardcoded RPC directly for both `eth_getTransactionReceipt` and the mandate `eth_call`. Nothing in the existing test suite caught this, because `test/judge.live.ts` always pointed it at one perfectly healthy local fork.

The problem only became visible auditing the script against its own stated purpose: its module doc comment says a judge can verify everything "without needing your exact account setup" - but if the one RPC it depends on is down or rate-limited the moment a judge runs `npm run judge`, the whole verification fails for a reason that has nothing to do with whether Covenant actually works. A script whose entire job is independence from this project's setup shouldn't itself be a single point of failure.

Fixed by generalizing the failover pattern instead of writing a second copy of it: `cli.mjs` gained `jsonRpcWithFailover` and `ethCallWithFailover` (both call sites `survey` already needed, made reusable), and `judge.ts`'s `verifyAttestationTx`/`runJudge` now accept either one RPC (what the live tests still use, deliberately - no failover needed against a controlled local fork) or a list. The real CLI entrypoint now builds that list from `BSC_RPC_URL` plus `cli.mjs`'s own `DEFAULT_BSC_RPCS`. Proven with a live test, not just a type change: `test/judge.live.ts` now lists a genuinely dead RPC (`http://127.0.0.1:1`, nothing listens there) ahead of the real working one and asserts the call still succeeds - failover that was never exercised against a real failure isn't verified, just hoped for.

### `chaos-fork.ts`'s first real run hit a genuine nonce race, not a mock failure

Building `scripts/chaos-fork.ts` - a standalone demo that fires several real sequential transactions from one signer against a real fork - the first actual run failed partway through with `NONCE_EXPIRED: nonce has already been used`, on a transaction sent after several earlier ones had already succeeded and been awaited to a receipt. Every send in the script was already correctly `await`-chained to the previous one's `.wait()`, so this wasn't a missing-await bug - the script was doing exactly what looked correct and still hit a real nonce desync.

The cause: the script used a raw `ethers.Wallet`, which by default re-queries `getNonce("pending")` fresh on every single transaction rather than tracking it locally. Under enough back-to-back sends on one local node, that re-query pattern can race with the node's own mempool bookkeeping and hand back a nonce that's already been consumed - a real, documented class of issue with unmanaged nonce handling, not something specific to this script's logic. `test/judge.live.ts`'s own fixture sends fewer transactions from the same kind of raw `Wallet` and had simply never sent enough in a row to hit it.

Fixed by switching to `ethers.NonceManager`, which tracks the next nonce locally after each send instead of re-querying the node every time - the documented fix for exactly this class of race. Confirmed by rerunning the script for real afterward: same fork state, same four real transactions, same tx hashes, no error. `test/chaos-fork.live.ts` now runs the exact real command (`npm run chaos-fork`) as a subprocess on every test run, specifically so a regression here shows up as a failing test instead of only surfacing the next time someone happens to run the script by hand.
