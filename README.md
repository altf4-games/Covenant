# Covenant

An on-chain mandate for an AI agent trading tokenized stocks from a Binance Agentic Wallet. The owner sets the rules: which stocks by exact address, dollars per trade, trades per day, a slippage bound, a position cap, and how far from its last NYSE close a stock may trade while the NYSE is shut. Before every trade the agent commits it to Covenant, and the contract decides on chain whether the mandate allows it. The wallet then trades natively with `baw market-order swap`, and the agent settles the real fill back on chain. `scripts/verify.ts` reconciles every real transfer in and out of the wallet against settled decisions, so a trade made without an approved decision shows up for anyone with an RPC.

Built for the BNB Hack: Tokenized Stocks Edition. Every claim on this page is backed by a real transaction, re-read from chain: on a fork of BSC mainnet against the real deployed tokens and live Binance data, and for the Agentic Wallet leg, on BSC mainnet itself (`docs/evidence/`). Covenant's own mainnet deployment is the last step of the build, done once.

**What it claims, and what it doesn't.** Covenant doesn't hold funds and can't physically stop the wallet from trading; Binance's own wallet guardrails (daily limit, token scope, session expiry) are the hard, private limit. What Covenant adds is market-aware and public: halt status, a closed-market drift rule, exact-address provider pinning, slippage checked against both the agent's quote and an oracle price, a position cap read from the wallet's real balance, and a public record of every decision, allow or deny. The claim is **no trade can happen unseen**, not "no trade can happen".

The closest verified prior art (Harness, ETHOnline 2026, Ledger's "AI Agents x Ledger" 1st place) enforces a single daily budget with no reasoned per-decision record. Covenant evaluates a richer mandate and records every decision on chain. And unlike an advisory critic agent that rates a decision after the fact, Covenant's decision comes before the trade: a trade without an approved decision committed in advance is a detectable violation.

## Architecture

One contract, [`contracts/Covenant.sol`](contracts/Covenant.sol), and three keys that must all differ: the **owner** sets the mandate, the **oracle updater** posts market status and price, and the **agent** (the Agentic Wallet) commits and settles. The contract rejects any overlap, so the agent can't post its own oracle.

The loop:

1. **`commit(side, token, amountIn, quotedOut, minOut, quoteRef, researchRef)`**, agent only. Covenant checks the mandate (active, not expired), the token (allowed by exact address), that no other approved decision is in flight, the oracle (fresh, not halted), the notional (buys in USDT, sells through the oracle price), the day's trade count, the slippage bound (`minOut` against both the quote and the oracle price), and for buys, the position cap. While the NYSE is closed it also applies the closed-market drift rule. It records the decision and emits `DecisionCommitted`, allowed or denied.
2. **The trade**, natively: `baw market-order swap`, through Binance's router, RFQ fills and MEV protection. Covenant never touches the money.
3. **`settle(id, swapTxHash, amountOut, executionMode)`**, agent only, with the real swap's hash and the real amount received. `cancel(id)` abandons an approved decision instead.

Worth knowing before reading the code:

- **Denials don't revert.** A reverted transaction would discard its own event, leaving no trace of the refusal. `commit` records the denial and returns, so refusals are on chain too, at gas cost only.
- **One `_evaluate`, two callers.** `previewDecision` (read-only, what the skill's `check` uses) and `commit` run the same internal function, so a preview can't drift from the real decision. Tested directly in `test/Covenant.unit.ts`.
- **Feature 3, the position cap, reads real state.** `commit` calls `balanceOf(agent)` on the stock token at decision time and denies with `PositionLimit` if the post-trade holding would exceed the owner's cap. It uses the larger of the quote and the oracle's output, so an understated quote can't slip past it.
- **Feature 1, the closed-market drift rule, answers this hackathon's opening problem.** The organizers' pitch: a tokenized stock "trades straight through the weekend, priced off a reference that has not updated in two days". While the NYSE's regular session is closed, `commit` denies a buy priced more than the owner's bound above the token's price at the last NYSE close, or a sell that far below it (`ClosedMarketDrift`). Binance's status endpoint can't say when the NYSE is shut (for bStocks it reports `TRADING` around the clock, friction-log C18), so the oracle takes the session from a NYSE calendar built from nyse.com's own holiday and early-close table, and the last-close price from the token's hourly candle ending exactly at that close. On 2026-09-25 at 07:21 UTC, with the NYSE shut, NVDAB was 0.84% above Thursday's close; the chaos-fork run below refuses a buy at that premium.
- **Provider pinning, not ticker resolution.** The allowlist is exact addresses. A ticker exists under several providers (NVDAB vs Ondo's NVDAon), and impersonator tokens exist, so resolution happens off chain in the skill, which refuses to guess.
- **Feature 2, the plain-English mandate compiler, redesigned around a real constraint.** The owner writes a sentence like *"Only AI-chip stocks, at most $1 per trade, 3 trades a day, no weekend premium over 1%"*; `compile-mandate` in the skill's CLI resolves the theme against [`skills/covenant-mandate/scripts/theme-map.json`](skills/covenant-mandate/scripts/theme-map.json) - a small, self-maintained ticker→theme map of real bStock addresses - and produces one `setMandateForTokens` transaction that configures the mandate and every token in the theme at once. This is a redesign, not the original pitch: the RWA API's advertised sector filter (Magnificent 7 / AI Chips / ETF / Buffett Portfolio) doesn't exist server-side (friction-log A10, 13+ real signed calls with every plausible parameter value returning the same unfiltered 488-token list). `Covenant.sol` gained `setMandateForTokens` for this - a genuine batch setter, not a loop of separate transactions dressed up as one - so "one owner transaction sets the whole mandate" is literally true even when the theme spans eight tokens.

Around the contract:

- [`skills/covenant-mandate/`](skills/covenant-mandate/): a Binance Wallet Skill (zero-dependency `scripts/cli.mjs`, Node 22 or later) that resolves tickers, checks a trade's decision before spending gas, and builds the commit, settle and cancel calldata that `baw contract-call` carries. Its `SKILL.md` and `references/loop.md` describe the loop as observed live on mainnet.
- [`status-page/index.html`](status-page/index.html): one static file, no backend. Reads the mandate and every decision straight from any RPC.
- [`mcp-server/index.ts`](mcp-server/index.ts): the skill's reads as MCP tools (`resolve_ticker`, `survey_providers`, `get_mandate_status`, `check_halt`, `preview_trade`), so any MCP-capable agent can query the mandate.
- [`scripts/oracle-updater.ts`](scripts/oracle-updater.ts): posts live market status (RWA asset-market-status endpoint), price (RWA dynamic endpoint), whether the NYSE session is open ([`scripts/lib/nyse-calendar.ts`](scripts/lib/nyse-calendar.ts)), and the last-close price (market K-line endpoint). If any read fails it posts nothing, the oracle goes stale, and every commit is denied.

The skill's `resolve` refuses to guess on an ambiguous ticker; `survey` reports all three providers (ondo, xstock, bstock) at once, each labeled `not-listed-on-bsc`, `dead` or `live`. "Dead" comes from real on-chain `Transfer` activity, not Binance's reported `volume24h`, which was found to be unreliable (see "Tests, and what they caught").

## Explored, measured, removed: `guardedSwap` and the oracle bond

Covenant v1 was a swap router: `guardedSwap` pulled USDT from the caller, checked the mandate, and swapped on PancakeSwap. A red-team review (`docs/research/opus-2026-09-24/a-redteam.md`) found it was opt-in: the same wallet could call `baw market-order swap` and skip it, and with no guarded sell, even the demo would have had to go around it. It also skipped Binance's aggregator, RFQ fills and MEV protection, and made Covenant the execution layer instead of the wallet. v2 moves execution back to the wallet and makes Covenant the decision record.

Phase 2.5 added a slashable bond for the oracle updater. As built it provided no security: the owner was the updater by default, `updateOracle` didn't require a bond, and the bond could be withdrawn in the same block as a false update. It's out of v2. Both designs remain in git history (`0a13c0b` and earlier), with the spec in `docs/research/slashable-guard-spec.md`.

## Red-team holes closed after the v2 rebuild

`docs/research/opus-2026-09-24/a-redteam.md` red-teamed v1. Four findings against v2's design were still open after the rebuild; all four are now fixed, each with a real fork test, not just a code change:

- **H7 (midnight double-burst, no cumulative cap).** The only notional check was per trade, so real daily exposure was `maxNotionalPerTradeUsd x maxTradesPerDay`, doubled by trading across a UTC midnight boundary. `setMaxDailyNotionalUsd` (a separate owner setter, independent of `setMandate` so tightening it never requires re-setting the mandate) now caps cumulative same-day notional; `DailyNotionalExceeded` is a new denial reason. Kept honest: a cap keyed by the UTC calendar day doesn't by itself close the midnight-boundary gap it was added for, and `test/Covenant.unit.ts` has a test that deliberately demonstrates the residual gap still clearing the cap twice within under a minute, rather than claiming the cap fixes something it doesn't.
- **H8 (no scheduled oracle updater).** `oracle-updater.ts` was a one-shot script with nothing to run it. `scripts/oracle-updater-cron.sh` (same self-disabling pattern as the existing off-hours cron: it removes its own crontab line once past the Oct 11 deadline) now exists to run it on a schedule. Not installed automatically - it's the one part of this project that would spend real gas on a timer rather than per deliberate action, so it's opt-in via `crontab -e`, documented in the script itself.
- **H10 (the authenticated Web3 API sits unused).** Every price/status read went through Binance's public, unauthenticated `bapi` endpoints; the HMAC-signed Web3 API key from Phase 0 backed nothing. `scripts/lib/web3-api-client.ts` implements the documented HMAC-SHA256 signing (`authentication.md`, verified live while investigating friction-log A10/A11) and `oracle-updater.ts`'s `readLiveOracle` now cross-checks the token address against Binance's authenticated Market API before trusting a price for it - fail-closed, same as the rest of that function, if the credentials or the listing are missing.
- **H11 (a decision wasn't provable without replaying history).** `DecisionCommitted` used to carry only the trade and the denial reason; proving a decision was evaluated correctly meant replaying `MandateSet`/`OracleUpdated` history to reconstruct what was in force. The event now also carries the mandate's per-trade cap, trade-count cap and expiry, plus the oracle's `updatedAt`, all snapshotted at commit time - a third party can check one event, no replay required.

## Judge-runnable verification

A judge doesn't have this project's Agentic Wallet, developer mode or bStock jurisdiction clearance, so they can't reproduce a trade. They don't need to. Two scripts check this project's claims against chain state and trust nothing else.

**`scripts/judge.ts`** takes a list of transaction hashes, re-fetches each real receipt, and decodes Covenant's own event in it: the decision id, side, token, allowed or denied, the exact reason, and for a settle, the swap hash, amount and execution mode.

```bash
COVENANT_ADDRESS=0x... npm run judge
```

It reads hashes from `JUDGE_TX_HASHES` (comma-separated) or [`data/judge-tx-hashes.json`](data/judge-tx-hashes.json), and tries `BSC_RPC_URL` first, then a list of public BSC RPCs, so a judge isn't depending on one free endpoint being up.

**`scripts/verify.ts`** checks the stronger claim, that no trade happened unseen. It reads every stock-token and USDT transfer in and out of the agent's wallet since Covenant's deployment and matches each trade to the settle that claims it.

```bash
COVENANT_ADDRESS=0x... VERIFY_FROM_BLOCK=<deployment block> npm run verify
```

It flags a trade with no settled decision (`UNMATCHED_TRADE`), a settle pointing at a transaction that moved no stock (`FALSE_SETTLE`), a settled amount that isn't what really arrived (`AMOUNT_MISMATCH`), a fill below the committed minimum (`BELOW_MINIMUM`), a trade before its commit or after its expiry, a wrong token or side, and two decisions claiming one trade. Amounts are compared against the ERC-20 transfers, not Binance's reported fill, which is in share units for bStocks (friction-log C17).

`test/verify.live.ts` proves each verdict with real swaps against live PancakeSwap liquidity on a mainnet fork: an honest buy and an honest sell reconcile clean, and a bypass, a false settle, a settle using Binance's share-unit number, and a swap after expiry are each flagged, with nothing else flagged.

## Chaos-fork demo

`scripts/chaos-fork.ts` (`npm run chaos-fork`) forks BSC mainnet, deploys Covenant with the real deploy script, posts the live NVDAB price, and then tries to break the mandate. Each result is re-read from the transaction's receipt by `judge.ts`, not printed from the script's memory.

```bash
npm run chaos-fork
```

A real run from 2026-09-25, with a mandate of NVDAB only, $2 per trade, a $3 position cap and 1% slippage, at a live price of $225.58. The NYSE was closed and NVDAB was 0.84% above Thursday's close, so the drift bound was set to 0.42%. These hashes exist on that local fork, not on BscScan; Covenant's mainnet deployment is the last build step.

| Attempt | tx hash | block | Result |
|---|---|---|---|
| Impersonator token | `0xbf7f850f8bb02c0d6db0f35152350f6aa310a5c341d6bb8abe213a9d3fbc566f` | 123909274 | denied, `TokenNotAllowed` |
| $50, over the $2 cap | `0xc431d7e97b926c5a5f73b4d10a30b2ca4ab3b6386e7c0e92605046badf53f87a` | 123909275 | denied, `NotionalExceeded` |
| Quote understated 10x to hide a loose minimum | `0x5b08a06aad533cde92e4a6a13644cbaad814fbd5db1da17036d539a39fb7a106` | 123909276 | denied, `SlippageTooLoose` |
| Trade while the oracle reports a halt | `0x6f35371e4db1f362160ff083f908b0c59a17e42fa359601a98608e39bab6a8e5` | 123909278 | denied, `OracleHalted` |
| Buy at the real overnight premium, NYSE closed | `0xf78a3a30914b4f031f22c9cd83ac140729acd54c479b8b3ea4602388bbf57ae0` | 123909282 | denied, `ClosedMarketDrift` |
| $2 more with ~$1.69 already held, over the $3 cap | `0x02180dd72a751084d9b63684d9ed7ee45bbb607d5cfd8a9078ced019c6a6b63c` | 123909286 | denied, `PositionLimit` |
| A stranger commits under the owner's mandate | none | none | reverted, `NotAgent` |
| $1, within every limit | `0x704c9875cee397b7e3b26334500b90be75b26428eaa5137241d7a285d69d125f` | 123909287 | allowed |

`test/chaos-fork.live.ts` runs this exact command as a subprocess and asserts on its real output.

## Try-to-break-it live demo

`scripts/try-to-break-it-demo.ts` (`npm run try-to-break-it`) is the "no trade happens unseen" claim, narrated: one honest commit → swap → settle for contrast, then a real swap with **no commit at all** - exactly what a compromised or careless agent would do - followed by `verify.ts`'s real `reconcile()` catching it live. Pure framing over already fork-tested plumbing (`setupCovenant`, `reconcile`), not new mechanism, so the same script is meant to run unchanged against the real mainnet deploy once that happens.

```bash
npm run try-to-break-it
```

`test/try-to-break-it-demo.live.ts` runs this exact command as a subprocess and asserts on its real output, the same pattern as the chaos-fork test above.

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

## Running the tests

```bash
npm install
npx hardhat test
```

Fifteen suites, 142 tests:

- `test/Covenant.unit.ts` (50): in-memory chain with a mock ERC20. Every denial reason, including Feature 1's drift rule (with the real NVDAB numbers from 2026-09-25) and the red-team H7 daily-notional cap (with a test that deliberately demonstrates its disclosed midnight-boundary limitation rather than hiding it), the three-distinct-roles rule, agent-only commit/settle/cancel (a stranger, the owner and the updater all revert), the settle and cancel lifecycle, the understated-quote attack, Feature 3's position cap, red-team H11's self-describing `DecisionCommitted` event, Feature 2's `setMandateForTokens` batch setter, preview/commit agreement, and H14/H15/H16's fixes (agent-scoped settle/cancel, absurd-amount denials, and the drift-at-worst-price rewrite).
- `test/Covenant.fork.ts` (7): a real fork of BSC mainnet with the real Agentic Wallet impersonated as the agent, so the position cap reads the NVDAB it really bought on Day 1. Includes a full commit, real swap and settle loop against live PancakeSwap liquidity.
- `test/nyse-calendar.ts` (8): the NYSE calendar against real dates, including a holiday, an early close, both daylight-saving switches, and a year with no data (it refuses).
- `test/oracle-updater.live.ts` (4): Binance's real status, price and K-line endpoints, posted on chain by the real updater code and read back; the last close is re-derived independently from a separate K-line fetch.
- `test/skill-cli.live.ts` (17): the skill's own commands against a spawned fork node, including its commit, settle and cancel calldata sent as real transactions, Feature 2's `compile-mandate` turning a real plain-English sentence into one real transaction that configures eight real tokens, and `classify-execution-mode` against the real Day-1 router address.
- `test/status-page.live.ts` (4): the page's event reading, joined per decision, and the fork-boundary timeout. Runs its boundary test last on purpose (see below).
- `test/mcp-server.live.ts` (8): the MCP server as a real subprocess, driven by the real MCP client.
- `test/off-hours-logger.live.ts` (2): the cron logger against Binance's live endpoints.
- `test/judge.live.ts` (8): `judge.ts` against real commits, settles and cancels, decoded field by field against ethers' own parsing, plus a never-mined hash, a wrong contract, and a dead RPC ahead of a working one.
- `test/chaos-fork.live.ts` (1): `npm run chaos-fork` itself, as a subprocess.
- `test/verify.live.ts` (2): `verify.ts` against real swaps, clean and with every kind of violation.

The live suites share `scripts/lib/local-fork.ts`, which deploys with the real `scripts/deploy.ts` and posts the oracle with the real `scripts/oracle-updater.ts`, so every one of them also exercises the path the mainnet deployment will run. They're slower than a typical Hardhat suite; see below for why.

Four more suites need no fork and no network at all - fast, pure-function coverage for logic the live suites above only exercise on the happy path, or don't touch:

- `test/verify.unit.ts` (13): `reconcile()` against a mock JSON-RPC server with crafted logs - H13's overspend repro (a $1-approved buy that really moved $10,000), H14's agent-rotation scoping, a multi-token trade, a revoke, a token disallowed mid-approval, a missed deployment block, and `getLogs` chunk boundaries. The live suite only ever reconciles one honest trade at a time; this is where the actual violation-detection logic gets tested against something trying to slip past it.
- `test/skill-cli.unit.ts` (8): the Wallet Skill CLI's own input validation - `resolve`'s chain-disambiguation refusals, and the calldata builders refusing a negative amount, a `2^256` amount, a JS number that already lost precision, and a ticker where an address belongs.
- `test/status-page-lib.unit.ts` (9): the sell-side wording in `describeDecision`/`guardedVsUnguarded` (the live suite only ever commits buy-side decisions), and `resolveFromBlock`'s input validation (NaN, negative, non-integer).

### What needs a secret, and what needs an archive RPC

Not every test or script here runs the same way. Some need nothing but a public RPC; some need a real API key; a few need an RPC that actually serves old blocks, which most free public BSC endpoints refuse past a shallow window.

| Needs | Examples | Why |
|---|---|---|
| Nothing (public RPC only) | `test/Covenant.unit.ts`, `test/verify.unit.ts`, `test/skill-cli.unit.ts`, `test/status-page-lib.unit.ts`, `test/nyse-calendar.ts` | Pure logic, or a mock chain/RPC - no real network call. |
| `WEB3_API_KEY` / `WEB3_API_SECRET` | `test/oracle-updater.live.ts`, `test/skill-cli.live.ts`, `scripts/oracle-updater.ts` | Reads Binance's RWA Data/Market APIs (real price, real market status). |
| `GEMINI_API_KEY` | `scripts/generate-narration.ts` | Batch play-by-play narration - see "Running the status page" below. |
| An archive-capable RPC (`bsc-dataseed`/`1rpc` verified live to work; `publicnode` refuses old receipts) | `scripts/verify.ts` run against a wide historical range, the frontend's snapshot/re-verification mode | A public RPC's own `eth_getLogs` range cap and receipt-pruning window (docs/partner-feedback/friction-log.md) - `bsc-dataseed` returns "limit exceeded" past a few thousand blocks, `publicnode` won't serve receipts for old transactions at all. `status-page/lib.mjs`'s `fetchDecisionEvents` chunks its own `eth_getLogs` calls (`DEFAULT_LOGS_CHUNK_BLOCKS`) for exactly this reason, mirroring the chunking `scripts/verify.ts` already needed. |
| A forked local node (`hardhat node --fork`) | Every `*.live.ts` and `*.fork.ts` suite, `scripts/chaos-fork.ts`, `scripts/try-to-break-it-demo.ts` | Real on-chain state (the live bStocks contracts, real liquidity) with no risk to the $2 real-mainnet budget. |

## Running the status page

Two versions exist. `frontend/` (React + Vite + Tailwind + Phaser) is the primary one, built for GAMIFICATION-PLAN-2026-09-25.md's presentation layer - boss battles, the Guarded vs. Unguarded Twin, the trading card, and the territory map. `status-page/index.html` is the original zero-build static page; both read the exact same tested logic in `status-page/lib.mjs`, so nothing about the on-chain reads or decision decoding differs between them.

```bash
cd frontend && npm install && npm run dev
```

Open the printed localhost URL and point it at an RPC URL and a deployed Covenant (or pass `?rpc=...&contract=...&fromBlock=...`). `scripts/seed-status-page-demo.ts` deploys to a local `hardhat node --fork` and records a denial, a settled trade and a cancelled one, if you want something to look at - works against either version, since both take the same query params.

`frontend`'s tests (`cd frontend && npm test`, Vitest, Node 22+) cover the game's logic rather than its pixels: the town layout, the road routing, and the battle script for every real `DenialReason`. The rendering itself was checked by playing it in a browser.

### The game

The status page as a small Pokemon-style town, built so a kid could follow what the agent did today. It uses Phaser 3 and Kenney's CC0 "Tiny Town" and "Tiny Dungeon" packs; the license files are in `frontend/public/game/`.

- **Each house is a shop for one real token.** Houses are assigned by real GeckoTerminal pool reserves (`frontend/src/data/liquidity.ts`, from `docs/research/verified-facts.md` and friction log B8/B9), so the biggest house really is the busiest market. bStocks Town is full of shops. Ondo Village has one small one. The two xStocks shops are ruins marked CLOSED ($324 and $2 in their pools, $0 a day traded).
- **The agent walks the roads.** Press start and every real decision replays oldest first. The agent walks from home along the streets to that token's shop (`route()` in `frontend/src/game/logic.ts`; a test walks every pair of places and fails if a route leaves the road). A token with no shop in town, like the impersonator from the bypass demo, sends it to a lot marked MYSTERY.
- **Every trade is a battle.** Allowed trades are battles the agent wins against a Rule Checker knight. Denied trades are battles it loses to the monster for that rule: a Spending Cap cyclops for `NotionalExceeded`, a Weekend Gap Demon for `ClosedMarketDrift`, and so on. Each denial ends with one plain sentence taken from what `Covenant.sol`'s `_evaluate` actually checks, using the real numbers from the commit event, e.g. "Too big! The rules only allow $1 per trade." Then "TRADE BLOCKED - your money is safe."
- **The canvas renders at the screen's real pixel density** and the camera fits the town to any window shape. A forest fills the leftover space instead of black bars. When the menu is open on a wide screen, the town shifts over so the menu never covers a battle.

### Guarded vs. Unguarded Twin

Still shown in the decision list for every real denial: what the wallet would have spent with no mandate at all, computed from `amountIn` Covenant already evaluated at commit time - no second real trade, no invented number (`status-page/lib.mjs`'s `guardedVsUnguarded`).

### Trading card

A real ERC-8004 identity, registered on BSC mainnet (`docs/evidence/erc8004-registration.json`: agentId 358509, tx `0x34fbf9...591f1b`, ~$0.05 real gas, ahead of the single final mainnet deploy pass by explicit choice, since this card needed a real identity to show). The card's rarity tier is a real classification from the loaded decisions' actual track record (`frontend/src/lib/rarity.ts`) - Legendary the moment a real `ClosedMarketDrift` denial lands, Gold once a real denial and a real settle both exist, Silver for real activity short of that, Bronze otherwise. That's exactly the kind of task TypeSafe's Jev model (a classifier, not a text generator - confirmed by reading its own docs, not assumed) is built for; it's wired as a disclosed, deterministic heuristic instead of a live Jev call because a real API key needs a new third-party account this session can't create on your behalf, the same constraint as Gemini's key below.

### Play-by-play narration (needs your own key)

`scripts/generate-narration.ts` batch-generates one sportscaster-style sentence per real decision via Gemini, grounded only in real on-chain fields, and writes `frontend/src/data/narration.json` for the app to read statically (no live API call from the browser, no key exposed client-side). Needs a free `GEMINI_API_KEY` from `aistudio.google.com` - a real account sign-in, so not something this session can do for you; the app renders nothing extra until that file has real entries.

```bash
GEMINI_API_KEY=... npx tsx scripts/generate-narration.ts <rpcUrl> <covenantAddress> <fromBlock>
```

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

### The prediction above came true, in a different file, the same day

The paragraph above ends with: "`test/judge.live.ts`'s own fixture sends fewer transactions from the same kind of raw `Wallet` and had simply never sent enough in a row to hit it." Building Phase 2.5's slashable guard, that fixture's `before()` grew from 6 sequential real transactions to 12 (real bond, real challenge, two real resolutions, added to the existing deploy/mandate/two-trades setup) - and the exact same `NONCE_EXPIRED` error showed up there too, on the first real run. Same cause, same fix: switched that file's raw `ethers.Wallet` to `ethers.NonceManager` as well.

Fixing the nonce race surfaced a second, real issue immediately behind it: the fixture's `this.timeout(120_000)` - fine for 6 real sequential transactions - was too tight for 12 of them against a live free-tier fork. The first few reruns after the nonce fix still failed, with `Error: Timeout of 120000ms exceeded`, which looks identical to a hang unless you actually check. Rather than assume it was hung, temporary timestamped logging was added after every `await` in the fixture (removed once diagnosis was done) - real diagnostic instrumentation, not a guess. It showed the fixture making genuine progress line by line, just slower in total than 120 seconds allowed; a later `console.log` timestamp run in a warmer RPC session completed the same setup in 37 seconds. Fixed by raising the timeout to 180 seconds, matching `test/Covenant.fork.ts`'s own budget for a similarly transaction-heavy fixture - not by cutting real transactions to fit an arbitrary limit, or by silently retrying and hoping.

One separate run during this same diagnosis genuinely did hang - not timed out, actually stuck - specifically on the pre-existing real PancakeSwap swap call that already existed in this fixture before any Phase 2.5 changes touched it. Verified independently before assuming a code bug: a direct `curl` to the fork's underlying RPC (`bsc-mainnet.public.blastapi.io`) a few minutes later answered in under half a second, and the very next full test run completed cleanly end to end. Given how many forks this session had already spun up against the same free-tier endpoint in quick succession (multiple full-suite runs, `chaos-fork.ts` runs, manual diagnostic node starts), the more honest read is transient session-level RPC degradation under sustained load, not a logic bug - consistent with the same class of free-tier flakiness already documented in B12-B14. Recorded here rather than silently retried and forgotten, because "it passed on retry" without writing down why is exactly the kind of unverified claim this project's own no-dummy-data standard exists to rule out.

### Binance's reported fill is in share units; the chain moves token units

Reconciling the Day-1 mainnet buy against the wallet's real balance on a fork: `baw market-order list` reported the fill as `0.001578888415748593` NVDAB, but the ERC-20 `Transfer` that landed was `0.001577660642762526`. NVDAB's own custom event in the same transaction carries both numbers, and they differ by exactly the token's shares multiplier (1.000778). `balanceOf` moves by the token amount; Binance's order API reports the share amount, with no field saying which.

Anything that trusted Binance's number would mismatch chain state on every honest trade. So the skill settles with the `Transfer` amount from the swap receipt, `verify.ts` compares against transfers only, and `test/verify.live.ts` has a case that settles with the share-unit number and must be flagged `AMOUNT_MISMATCH`. Logged as friction-log C17.

### ethers' `getBlock("latest")` was twelve minutes stale after a time jump

`test/verify.live.ts` jumps the fork's clock 700 seconds to test a swap after its decision expired. The swap's router deadline was computed as `getBlock("latest").timestamp + 600`, and the router rejected it with `Transaction too old`. The chain's clock was fine; a probe showed a +700s jump working exactly. A diagnostic in the test itself showed the cause: after `tx.wait()` polling, ethers resolved `"latest"` to its own cached block number, 709 seconds behind the node's real head, and a few blocks behind even before the jump. A fresh provider in a standalone probe didn't reproduce it, which is why the probe alone wasn't enough.

Fixed by reading `eth_getBlockByNumber("latest")` directly over raw RPC for anything time-sensitive. The one production use of `getBlock("latest")` is `deploy.ts`'s mandate expiry, set days ahead, so a few seconds of lag there is harmless.

### Three small ones from the v2 rebuild

- **A minimum exactly at the slippage floor rounds under it.** The fork test first set `minOut = quotedOut * 97 / 100` with a 3% bound. Integer division rounds down, so the minimum landed a hair below the floor and the contract, correctly, would have denied it. Caught reading the test before running it; the test now leaves a margin.
- **The chaos-fork demo's "legitimate" trade was denied, correctly.** Its first v2 run funded the agent with $3.38 of NVDAB to demonstrate the $3 position cap, then ran the contrast trade meant to be allowed. It was denied `PositionLimit`, because the wallet was already over the cap. The contract was right and the scenario was wrong; the demo now funds $1.69, so $2 more crosses the cap and $1 more doesn't.
- **An ethers `Result` loses its named keys when spread.** The unit suite's first v2 run failed 21 tests at once, all reading `undefined` for event fields. The helper did `{ ...parsed.args }`, which keeps an ethers `Result`'s indexed entries but not its names. `parsed.args.toObject()` fixed all 21.

### A summarizer misread NYSE's holiday table; the raw page didn't

Feature 1 needs NYSE's 2026 holidays. A web-fetch summary of nyse.com's calendar page came back confidently listing MLK Day, Memorial Day, Juneteenth, July 3 and Labor Day as 1:00 p.m. early closes, and left Thanksgiving out. That's wrong: those are full closures. Reading the raw HTML showed why. The table has one column per year and every row is a full closure, and the early closes (Nov 27 and Dec 24, 2026) live in the footnotes, which the summary had folded into the wrong rows. The calendar in `scripts/lib/nyse-calendar.ts` is built from the raw table and footnotes. Had the summary been used, the drift rule would have treated five full holidays as trading days and allowed afternoon trades on them at whatever premium the token carried.

### At exactly the drift bound, rounding denies

A buy priced exactly 1% over the last close, with a 1% bound, is denied. `quotedOut = amountIn × 1e18 / price` truncates, which puts the implied price 20,200 wei over the bound (about 1e-16 of the price). It's the same effect as the slippage-floor case above, and it errs toward refusing, the right direction for a guard, so the contract is unchanged. The unit test asserts the denial at the exact bound and an allow just inside it, so the direction can't silently flip.

### Enriching one event for red-team fix H11 broke compilation, not just a test

Adding four fields to `DecisionCommitted` (H11's fix, so a decision is provable without replaying `MandateSet`/`OracleUpdated` history) made `commit()` fail to compile with `HHE910: Stack too deep`, not a logic error - Solidity's legacy codegen ran out of stack slots for the emit's fifteen arguments alongside `commit`'s other locals. The fix is `viaIR: true` in `hardhat.config.ts`, the standard Solidity pipeline for exactly this, not a change to contract behavior. Caught immediately by `npx hardhat compile`, before a single test ran - the kind of bug that only shows up once an event actually carries enough real data to be useful.

### A day-of check with a stopwatch problem: the H7 midnight-burst test denied everything until the timestamps had real headroom

The first version of the H7 double-burst test tried to land a trade at 23:59:58 UTC and a second one four seconds after midnight. Both got denied. The reason: every transaction mines its own block, and Hardhat's default automining timestamp only guarantees strictly increasing, not real-clock-paced - two transactions after the first "23:59:58" jump had already pushed the chain to 00:00:00 before the deliberately-`23:59:58`-timed trade even landed, so both commits ended up in the *same* UTC day and the cumulative cap correctly (but confusingly) denied the second one. Fixed by giving the pre-midnight side fifteen seconds of headroom and the post-midnight side twenty, rather than shaving the gap to the literal minimum the scenario describes.

### The try-to-break-it demo settled its own honest trade with the quote, not the real fill

The first version of `try-to-break-it-demo.ts` (the live "no trade happens unseen" narration) passed the quote's `quotedOut` to `settle`, instead of the real ERC-20 Transfer amount from the swap receipt - the exact mistake friction-log C17 documents and the rest of this codebase is careful to avoid. `scripts/verify.ts`'s own `reconcile()`, run inside the same script as the demo's punchline, caught it immediately: the honest trade came back with 0 matched decisions instead of 1, because the settled amount didn't match what the wallet really received. Fixed by reading the real `Transfer` log off the swap receipt, the same pattern already used in `test/verify.live.ts` and `test/Covenant.fork.ts`. A script whose whole point is proving nothing slips past unnoticed almost shipped with exactly that kind of unnoticed error in itself.

### H12: a zero-size sell during closed-market hours panicked instead of denying cleanly

Found reading `_evaluate` during a pre-deploy audit pass, not by a failing test - the closed-market-drift check's sell branch computes `implied = (quotedOut * 1e18) / amountIn`, with nothing upstream guaranteeing `amountIn != 0`. The buy branch divides by `quotedOut`, which the slippage check above already guarantees is nonzero by the time execution reaches it - but nothing plays the same role for a sell's `amountIn`. A sell with `amountIn = 0` clears the notional, daily and slippage checks trivially (everything they compare against scales with `amountIn`, so they're all comparing against zero), then hits the division and panics.

Confirmed live before touching the contract: a throwaway Hardhat test called `commit` with `Side.Sell`, `amountIn: 0`, a token with a nonzero `maxClosedMarketDriftBps`, and the oracle reporting the market closed. It reverted with `panic code 0x12 (Division or modulo division by zero)` - a real, reproducible crash, not a hypothetical read of the code. That breaks `commit()`'s own documented contract: "Never reverts on a policy denial: a denied commit still mines and emits `DecisionCommitted`." A degenerate agent input shouldn't be able to take down the one guarantee this contract exists to provide.

Fixed by guarding both branches on their actual divisor being nonzero (`quotedOut > 0` for buy, `amountIn > 0` for sell) instead of relying on the earlier check's ordering to protect the sell side too. At the time, a zero-size trade was made to pass this check rather than add a new `DenialReason` - moving no real notional, there's no implied price to measure drift against either way.

**Superseded by H15 below**: a second, deeper audit pass found that "moves no real notional" wasn't quite true for the wider set of degenerate inputs it opened the door to (an absurdly large `amountIn`, `quotedOut` or `minOut`, not just a zero one), so H12's original "let it through" fix was replaced with a real `InvalidAmount` denial covering the whole family. `test/Covenant.unit.ts`'s regression test for H12's exact panicking input now asserts `InvalidAmount`, not `None`.

### H13: `verify.ts` trusted `amountIn` as a spending cap without ever checking real transfers against it

`Decision.amountIn` is the ceiling Covenant's mandate evaluated a trade against - the whole reason a swap is provably in-bounds. `verify.ts`'s `reconcile()` joined commits to settles and to real transfers, but never actually compared the wallet's real net spend for a decision against that decision's own `amountIn`. A wallet could settle a decision honestly (real swap, real `DecisionSettled`) while the underlying transfer moved far more value than the approved amount - say a $1-approved buy that actually spent $10,000 - and `reconcile()` would still report it clean, because nothing it checked depended on the transfer amount matching the approval at all.

Caught by a live-style mock RPC test (`test/verify.unit.ts`) built specifically to reproduce this: a decision approved for 1e18 (1 USDT) wei, settled honestly, but with a crafted `Transfer` log moving 10,000e18. The old `reconcile()` returned clean; the new one flags `AMOUNT_IN_EXCEEDED`. Fixed by tracking real per-decision-window `quoteIn`/`quoteOut` movements and comparing net spend against `amountIn` (with a small tolerance for legitimate price improvement on a buy's receive side, so a wallet isn't flagged for being handed *more* stock than quoted). The same pass also added `MULTI_TOKEN_TRADE`, for a transaction that moves a second configured token `verify.ts` wasn't even looking at.

### H14: `verify.ts` had no concept of the agent changing mid-flight

Covenant supports `setAgent` - rotating which address can commit/settle/cancel. `verify.ts` had no notion of agent tenure at all: every transfer from the wallet was checked against every decision, regardless of which agent was live when either happened. After a rotation, a stale approval from the old agent could be matched against a transfer made under the new one (or vice versa), and neither the contract nor `verify.ts` would catch a wallet acting under someone else's approval.

Fixed on both sides. `Covenant.sol` now records `agent` on the `Decision` struct at commit time and rejects `settle`/`cancel` from anyone else with `NotDecisionAgent` (`test/Covenant.unit.ts`'s H14 test asserts the new agent can't touch the old agent's still-open decision). `verify.ts` now derives agent tenures from `AgentChanged` events and only considers a decision "in scope" for the agent who committed it, plus one decision-TTL grace window after a handover (a swap can legitimately settle just after a rotation lands) - anything outside that scope is `AGENT_MISMATCH`, covered by three new `test/verify.unit.ts` cases (rotation keeps the old wallet's unmatched trade, the TTL boundary, and a trade by a genuinely different wallet).

**Two follow-up bugs found in this fix itself, on a second red-team pass, both with a live repro before being fixed:**

1. `settle`/`cancel` were still gated by the `onlyAgent` modifier on top of the new `d.agent` check - meaning once an agent rotated away, the decision it committed but hadn't yet settled became permanently un-settleable and un-cancelable by *anyone*: the old agent fails `onlyAgent` (no longer current), the new agent fails `d.agent != msg.sender`. If the old wallet then genuinely completed that pre-approved trade on-chain, `verify.ts` would misreport it as `UNMATCHED_TRADE` - "a trade made without an approved decision" - when one demonstrably existed. Fixed by dropping the now-redundant `onlyAgent` modifier from both functions; `d.agent == msg.sender` is already the strictly correct check on its own. New test: "H14 follow-up: the agent who actually committed a decision can still settle or cancel it after being rotated out."
2. `verify.ts`'s `inScope()` used `Array.find()` to locate the handover where a wallet lost the agent role, which returns the *first* matching handover for that wallet, not the most recent one. A wallet that held the agent role across two separate, non-contiguous tenures (rotated away, later rotated back in, then rotated away again) got scoped against its old, irrelevant first handover instead of its real, recent one - a trade made well inside TTL of the real handover could still be wrongly flagged (proven live: it surfaced as a false `FALSE_SETTLE`, since the movement was dropped from `trades` before ever reaching the `AGENT_MISMATCH` comparison) once enough time had passed since that first, unrelated handover. Fixed by scanning all matching handovers and keeping the last one. New test: "H14 follow-up: a wallet that held the agent role twice is scoped against its most recent handover, not its first."

### H15: absurd amounts (zero, or near `uint256` overflow) were a live path to a panic or silent wraparound, not just H12's one case

H12 fixed one panicking input (a zero-size sell during closed-market hours) by letting zero-size trades through. The wider audit that found H13/H14 asked the obvious next question: what about an `amountIn`, `quotedOut` or `minOut` near `type(uint256).max`? A buy denied by `NotionalExceeded` still has to compute `amountIn * 10_000` or similar upstream of that denial in a couple of code paths - large enough inputs there risk silent wraparound in unchecked contexts, and Solidity 0.8's checked arithmetic turns the rest into unexplained reverts (crashing `commit()`'s no-revert guarantee exactly like H12) rather than a clean, recorded denial.

Fixed with `MAX_AMOUNT = type(uint128).max` (real money doesn't need more than 128 bits of wei, and it leaves headroom under every multiplication in `_evaluate` before a `uint256` could actually wrap) and a single guard at the top of `_evaluate`: any of `amountIn == 0`, or `amountIn`/`quotedOut`/`minOut` over `MAX_AMOUNT`, now returns `InvalidAmount` immediately, before any of the other checks run. `updateOracle` got the same bound on `priceUsd`/`lastCloseUsd`, reverting `InvalidBound` - the oracle updater is a separate trusted role from the agent, so a bad update there is a genuine operator error worth reverting on, not a policy denial to record. `test/Covenant.unit.ts`'s new "H15: absurd amounts are denied, never a panic" block checks a `2^250` sell, `2^255` `quotedOut`/`minOut` on both a buy and a sell, a zero buy, and confirms a buy at exactly `MAX_AMOUNT` still previews as a normal `NotionalExceeded` denial rather than anything degenerate.

### H16: the closed-market drift guard measured drift at the quote, letting a loose `minOut` smuggle a bad worst-case price past it

Feature 1's drift check (H16, found in the same pass as H13-H15) compared the *quoted* price against the last close, not the worst price the trade could actually fill at. A trade with an honest quote right at the drift bound, paired with a deliberately loose `minOut`/`maxIn`, could pass the drift check on the quote while still being able to fill at a real worst-case price well outside the bound - the same "checked the wrong number" shape as red-team H5's original slippage bug, just recurring in the newer Feature 1 code instead of the original slippage check.

Fixed by measuring drift at `minOut` (buy) / `minOut`-implied worst price (sell) instead of `quotedOut`, the same worst-case value the slippage check itself already uses - the two checks now agree on what "the trade's worst case" means instead of the drift guard trusting a rosier number. `test/Covenant.unit.ts` rewrote the buy-drift test around the worst-price boundary (denied at 203, allowed at 200.8 and 200.98, denied at 201.1) and added a dedicated H16 case: an oracle price of 202 with a quote and `minOut` chosen so the *quote* sits inside the old bound but the worst-case `minOut` price sits outside it - the old check would have allowed this, the new one denies it as `ClosedMarketDrift`.

### Two more follow-ups from the same red-team pass, both cosmetic-but-real

The CLI's `hex32()` (H13-H16's own input-validation round) still let `BigInt(n)` throw its own raw, unformatted `SyntaxError` straight through on non-numeric garbage ("Cannot convert not-a-number to a BigInt", no `exitCode`) - confirmed live - instead of the clean, consistent refusal every other bad-input case there gets. Wrapped in a `try`/`catch` that gives the same clean `Error` shape. Only reachable through the raw skill CLI; `mcp-server`'s zod schema already rejects non-digit strings before this is ever called.

`resolveFromBlock` validated with `Number.isInteger`, not `Number.isSafeInteger` - the same precision-loss class of bug `hex32`/`addr32` were hardened against, just left unfixed here: `Number.isInteger(Number("9007199254740993"))` is `true` even though that string's value already lost precision converting to a `Number`. Purely theoretical at real BSC block heights (~40M, nowhere near 2^53), but fixed for consistency with the standard set elsewhere.
