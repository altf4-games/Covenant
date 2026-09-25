# Developer friction log

Running log for the **Developer Experience Report (25% of judging score)**.
Submitted via the report template form: https://forms.gle/EUQ39xf54GHjC2ys5

**Rules for this file (from CLAUDE.md):**
- Log friction *as it happens*, with the exact URL, the exact error text, and what the actual fix was. Never reconstruct from memory later.
- The report explicitly cannot be AI-generated. **This file is raw evidence, not prose.** Write the report yourself from these notes, then run `/humanizer` on your own draft only to strip AI-sounding patterns — never to generate content.
- Keep two categories separate: bugs in *our* code (→ Technical Implementation evidence) vs gaps in *their* stack (→ this file).

**Status: 44 items logged during pre-build research on 2026-09-20, before writing a line of code.**
(9 Binance Web3 API · 11 tokenized stocks · 13 Agentic Wallet/Skills · 11 Agent Studio)
All URLs checked on that date. Everything below is reproducible.

The report form asks for six specific areas — items are tagged accordingly:
`[ONBOARD]` `[DOCS]` `[PITFALL]` `[AI-STACK]` `[STOCK]` `[REDESIGN]`

---

## A. Binance Web3 API / docs surface

### A1. `[DOCS][ONBOARD]` Machine-readable docs are blocked to machines
`curl -sSL https://web3.binance.com/en/dev-docs/llms-full.txt` and `.../llms.txt` both return **HTTP 202 with a 0-byte body** (bot protection / JS challenge).

```
$ curl -sSL -o llms-full.txt -w "HTTP:%{http_code} SIZE:%{size_download}\n" \
    "https://web3.binance.com/en/dev-docs/llms-full.txt"
HTTP:202 SIZE:0
```

Binance ships a documented "Agent Native → LLMs.txt" feature whose *entire purpose* is machine consumption, and a plain HTTP client cannot read it. Only a browser-like fetch path worked.
**This is the single most ironic finding of the research.** Same failure on `developers.binance.com` doc pages.

### A2. `[DOCS]` Two disjoint documentation universes, no cross-link
- Agentic Wallet / Wallet Skills → `developers.binance.com/en/docs/products/...`
- Web3 REST API reference → `web3.binance.com/en/dev-docs/...`
- Agent Studio / ERC-8004 / ERC-8183 → `docs.bnbchain.org` (a third site)
- A fourth surface, `developers.binance.info`, also serves a "Binance Skills Hub" page — unclear if mirror or stale.

One hackathon, three-to-four doc sites, and the developer has to already know all of them exist.

### A3. `[DOCS]` The doc index emits unresolvable paths
`web3.binance.com/en/dev-docs/llms.txt` *does* index both Agentic Wallet and Wallet Skills alongside the REST APIs — so they aren't fully siloed — **but it emits bare `/en/dev-docs/...` paths with no base domain.** A machine reader cannot resolve them without guessing the host.

### A4. `[DOCS]` Web3 dev-docs contain zero Agent Studio / ERC-8004 / ERC-8183 / x402 entries
The full index covers Authentication, SDKs, Agent Native, Wallet Skills, WebSocket/Wallet/Transaction/Trading/Market/DeFi APIs, B402 (6 pages), and Agentic Wallet. It has **no pages at all** for Agent Studio, ERC-8004, ERC-8183, or x402-by-name.

### A5. `[DOCS]` Broken per-endpoint page
`https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data/get-rwa-token-price` returns empty content while the parent catalog page renders fine. Per-endpoint detail pages appear unreliable.

### A6. `[PITFALL]` The Web3 MCP server is "Coming soon", not shipped
`https://web3.binance.com/en/dev-docs/agent-native/mcp-server.md` tells you to "drop the server URL into Claude Code, Cursor, or Windsurf" — and **gives no server URL.** Still in development.
Easy to conflate with Agent Studio's 15-tool MCP server, which *does* exist and does auto-install.

### A7. `[ONBOARD]` API key requires a full Binance account, not flagged as a prerequisite
Obtaining a Web3 API key requires a Binance account — a jurisdiction-gated step entirely separate from the permissionless on-chain layer. The RWA quick-start does not flag this as a prerequisite.

### A8. `[ONBOARD][PITFALL]` b402 permission requires a separate approval form — confirmed hands-on, 2026-09-20
At API key creation in the Developer Portal, B402 Payments is **not** a checkbox alongside the other modules (RWA Data, Market, Trading, Transaction, Wallet, DeFi) — enabling it routes to a **separate registration form**, gated apart from the rest of the key-creation flow.
Given the unknown turnaround on that form and no product need for it in the primary build, **we did not enable b402** and proceeded with the other permissions only.
This confirms the schedule-risk concern raised pre-build: GitHub issue `bnb-chain/mpp-sdk#28` already showed developers queuing for sandbox access, with **no published SLA**. A team that discovers this friction only when they actually need b402 (e.g. for the Agent Studio "self-funding" criterion) could lose real build days to a form with no visible turnaround estimate.
**Redesign suggestion:** surface the separate-approval requirement on the b402 docs page itself, not just as a silent extra step inside the portal UI.

*(Prior pre-build note, superseded by the above hands-on confirmation:)* Requires Developer Portal registration with B402 permissions explicitly enabled. GitHub issue `bnb-chain/mpp-sdk#28` shows developers queuing for sandbox access. **No published SLA.** Schedule risk.

### A9. `[DOCS]` b402 fee schedule undisclosed
Gas is sponsored by Binance, but whether Binance takes a cut of settlement is stated nowhere in the b402 docs.

### A10. `[DOCS][PITFALL]` The Tracks tab's advertised RWA sector filters do not exist — confirmed with real signed calls, 2026-09-25
The BNB Chain hackathon Tracks tab lists the RWA Data API as having "sector filters (Magnificent 7, AI Chips, ETF, Buffett Portfolio)". The official dev-docs describe `GET /api/v1/dex/market/rwa/tokens` (Market API, not a separate "RWA Data API" — see A2) as: "Supports filtering by platform and sector tab", with no parameter names or enum values given anywhere in the rendered docs, the OpenAPI-derived `llms.txt`/`llms-full.txt` dumps, or the per-endpoint reference page.

Called the real, HMAC-signed endpoint directly (488 live tokens returned) to find the actual contract:
- **Platform filtering is real, but the doc's own word for it is wrong.** The plain-English param the doc implies (`platform`) is silently ignored; the real param is `platformId`. `platformId=bstock` correctly narrows 488 → 46; `platformId=ondo` narrows to 442.
- **Sector-tab filtering does not exist.** Tried `sectorTab` (also `sector`) with 13 plausible values — `magnificent7`, `Magnificent7`, `magnificent-7`, `ai-chips`, `aiChips`, `AI_CHIPS`, `etf`, `ETF`, `buffett`, `buffett-portfolio`, `buffettPortfolio`, `hot`, `alpha`, plus a deliberately bogus value (`bogus-garbage-xyz`) as a control — every one of them returned the identical, unfiltered 488 rows. A bogus value should error if the param were validated server-side; it didn't, so the param is either not read at all or silently swallowed.
- The only classification field that actually exists on a token object is `tags` (a string array). Across all 488 live tokens, exactly one tag value appears anywhere in the dataset: `"alpha"`, on 126 of them. There is no `sector`, `category`, `theme`, or similar field, and no token carries anything resembling "Magnificent 7", "AI Chips", "ETF", or "Buffett Portfolio".

**This kills the literal premise of a sector-filter-driven feature as advertised** — a plain-English mandate compiler that resolves phrases like "AI chips" or "the Magnificent 7" via this endpoint's sector tab has nothing to call. Any such feature has to be built on a different, self-maintained classification instead (e.g. a small static ticker → theme map curated from `underlyingTicker`/`underlyingName`, not a live sector lookup), and that constraint should be stated up front rather than discovered mid-build.
**Redesign suggestion:** document the real parameter names and their valid enum values on the endpoint's own reference page, and either implement the sector-tab filter for real or remove the claim from both the docs' "Supports filtering by platform and sector tab" line and the hackathon Tracks tab's feature list.

### A11. `[DOCS][PITFALL]` `POST /api/v1/dex/pre-transaction/simulate` has no documented request body anywhere, and the live error never reveals the real one — day-of check for Feature 5, 2026-09-25
The Tracks tab explicitly points at the Transaction API as the "dry-run before you commit real funds" mechanism. Confirmed the key has permission for it (no `40104`), `GET gas-price` and `GET block-height` both work cleanly against chain 56. But `POST simulate`'s request schema is undocumented in every surface checked: the Transaction API introduction page (a bare feature table, no examples), the Transaction API error-codes page (generic error catalog only), the Trading API's own `integration-flow.md` (the documented quote → build → sign → broadcast → verify recipe **never calls `/simulate` at all** — zero occurrences of the word "simulate" in that doc), and the JS/Python SDK connector pages (no mention either). The DeFi API's unrelated `simulate=true` flag on `/defi/transaction/deposit` is a different mechanism entirely (inline preview, not this endpoint).

With no documented shape to go on, tried to reverse-engineer it from the live error messages the same way A10 was resolved (real signed calls, not guesses from memory). It didn't work: every one of 16 different request-body shapes — missing `evmParams`, an empty `evmParams`, a fully-populated plausible EVM tx object under half a dozen different field-name conventions (`{to,data,value}`, `{from,to,data,value,gasLimit,gasPrice}`, `{fromAddress,toAddress,inputData}`, `evmTxParams`, an array, a raw-hex string, `binanceChainId` as a number vs. string, `chainType: "EVM"` alongside it) — returned the exact same generic `50000 evmParams is required for EVM chains`, even when `evmParams` held a real-looking transaction object or, as a control, a bare string or number. The one shape that produced a *different* error (removing `binanceChainId` entirely, which flipped it to a generic `40001 Parameter error`) confirms the validator is checking something about the request other than what it claims to be checking — the message names `evmParams` but doesn't actually validate its contents against any of the field names tried.

**Day-of check result: fails clean.** Per this feature's own stated gate ("confirm the Transaction API can actually simulate this route; skip cleanly if it can't"), Feature 5 (simulation hash in `commit`) does not verify and should not be built on this endpoint as currently documented. The finding itself — a advertised "dry-run" endpoint with no discoverable request contract — is stronger Developer Experience Report material than a forced integration would have been.
**Redesign suggestion:** publish at least one working `curl` example for `POST /simulate`, the same way `broadcast-transaction` has one in `integration-flow.md`; right now it's the only pre-transaction endpoint with zero example payloads anywhere in the docs.

---

## B. Tokenized stocks — the asset class itself

### B1. `[STOCK][REDESIGN]` No issuer publishes contract addresses. Anywhere.
`bstocks.finance`, `xstocks.fi`, the Ondo BNB Chain launch post and the BNB Chain bStocks post **all announce the tokens and none lists a single `0x` address.**
Finding real addresses required a third-party source (PancakeSwap's extended token list / GeckoTerminal).

**For an asset class whose entire selling point is on-chain verifiability, this is the worst gap found in the whole research pass.**

### B2. `[STOCK][PITFALL]` That gap actively breeds scams — with a live example
A plain web search for "bStocks contract address BSC" surfaces `0x2F701b108a9aF5558960325A0239D0a13c2C4444`, an **impersonator** reporting `name()="Binance Stocks"`, `symbol()="bStocks"`, 18 decimals, **1,000,000,000e18 supply**. Real bStocks are per-ticker with supplies in the tens of thousands.

A developer trusting search results integrates a scam token. **The absence of official addresses directly creates this attack surface.**

### B3. `[STOCK]` Symbol search on DEX aggregators returns scams, not the real assets
DexScreener `search?q=NVDAX` returned only three vanity-address clones (`0x…777`) with $0.05–$0.09 liquidity and fabricated $17K volumes. The real tokens did not appear. Symbol-based discovery is unusable for this asset class.

### B4. `[DOCS]` `docs.ondo.finance/global-markets/token-addresses` returns HTTP 404
The obvious canonical path for an address list does not exist.

### B5. `[STOCK]` Direct contradiction on redemption hours
Binance Academy: conversion "is generally available 24/7." The Defiant: redemption into direct stock holdings is "limited to traditional market hours."
No authoritative issuer statement resolves it. **This is a material product question left ambiguous** — and it determines whether "weekend arbitrage" is real or fictional.

### B6. `[STOCK][PITFALL]` `referencePrice`: not self-referential for Ondo, but simply missing for bStocks — tested live, 2026-09-21
Pre-build research flagged this as a risk from the docs' own wording ("derived from the on-chain token price, not an official quote"). Testing it live against the public RWA Dynamic V2 endpoint (`GET .../wallet/market/token/rwa/dynamic/ai`, no auth key needed - see B15 for how this endpoint was found) gives a more specific and more useful answer than the original worry:

```
$ curl '.../rwa/dynamic/ai?chainId=56&contractAddress=0xa9ee28c80f960b889dfbd1902055218cba016f75' # NVDAon, Ondo
tokenInfo.price (on-chain):  224.356042488929327987
stockInfo.price (reference): 223.916667

$ curl '.../rwa/dynamic/ai?chainId=56&contractAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436' # NVDAB, bStock
tokenInfo.price (on-chain):  224.1142754272037932881
stockInfo.price (reference): null
```

For Ondo, `stockInfo.price` is real and genuinely independent - it differs from the on-chain price by about 0.2% at the same instant, which is exactly what an actual reference quote should do. The original self-referential worry doesn't hold for Ondo.

For bStocks, the same field comes back `null`. Not a smaller number, not a stale number - absent. The RWA Data API's headline dual-price feature simply doesn't cover bStocks' reference side, even though bStocks is supported everywhere else in the same response (`statusInfo`, `tokenInfo`, `type: 3` all populate normally). **This is a coverage gap specific to bStocks, not a self-referential-price problem, and it's a materially different, more precise finding than the pre-build guess.**

Product consequence: any "on-chain vs reference price gap" feature is simply unbuildable for bStocks via this endpoint, not just untrustworthy. Covenant was already scoped away from that idea (strategy-report.md §2.5), so this doesn't change the build - but it's exactly the kind of tokenized-stock-specifics finding the Dev Experience Report asks for, and it's a stronger, more concrete version of B6 than what pre-build research alone could establish.

### B7. `[STOCK]` xStocks is in the track rules but absent from the RWA API
The hackathon permits bStocks, Ondo **or xStocks**. Binance's RWA Data API `platforms` enum covers only `ondo` and `bstock`.
**The track rules and the required API stack are mutually inconsistent for one of the three permitted platforms.** Worth raising with organisers directly.

### B8. `[STOCK]` xStocks on BSC is commercially dead
TSLAx total reserves across all pools: **$324**. 24h volume: **$0.00**. AAPLx pools hold under $2.
The token is genuinely deployed (`0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0`, 20,000 supply) but is not tradeable. Choosing it per the track rules would produce a submission that cannot demo.

### B9. `[STOCK]` Live typo in a production contract
QQQB `name()` returns **"Invesqo QQQ"** (should be "Invesco"). Verified on-chain at `0x205812CdBed920aFf76C6580abD681a46D11efc7`. A real, citable defect in the issuer's deployment.

### B10. `[PITFALL]` Public BSC RPCs are individually insufficient
- `bsc-rpc.publicnode.com`: `eth_getLogs` works, `eth_getTransactionReceipt` returns `null` for recent txs.
- `bsc-dataseed.binance.org`: receipts work, same `eth_getLogs` query returns 0 results.
- publicnode 403s after ~10 rapid calls and **blocks Python's default User-Agent** (works with `curl/8.4.0`).

**Neither endpoint alone is sufficient. You need per-method failover.**

### B11. `[STOCK]` Undocumented centralisation: one beacon controls every ticker
All bStocks tickers are beacon proxies sharing implementation `0xcfed6c46…` behind beacon `0x156d6dce…`. Documented nowhere. Whether the admin can upgrade it to add transfer restrictions later is unverified.

### B12. `[PITFALL]` Free-tier BSC RPCs barely keep any history, confirmed while setting up the fork
Extends B10. Hit this on 2026-09-21 setting up a Hardhat fork of BSC mainnet.

`bsc-dataseed.binance.org` threw `-32000 missing trie node` on an `eth_getBalance` call at a block roughly 150 behind the current tip. `bsc.publicnode.com` doesn't even try: `"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"`. `bsc-dataseed1.defibit.io` failed the same way as dataseed.

The one endpoint that worked, `bsc-mainnet.public.blastapi.io`, served state at least 50 blocks back with no token. That's what `hardhat.config.ts` now points at. None of this is documented anywhere in Binance's dev docs, and the hackathon's own recommended workflow, fork BSC mainnet locally, runs straight into it on day one.

### B13. `[PITFALL]` Hardhat 3 has no built-in hardfork history for BSC, and the fix has a silent failure mode
Not a Binance-stack bug, but real build friction from following the hackathon's recommended fork-first setup, so logging it here anyway.

Hardhat 3 / EDR ships hardfork-activation history for Ethereum mainnet, Sepolia, Hoodi, and the OP chains. BSC (chain id 56) isn't in that list. Forking it without adding one yourself fails immediately:

```
No known hardfork for execution on historical block ... in chain with id 56.
The node was not configured with a hardfork activation history.
```

The fix is a `chainDescriptors` entry in `hardhat.config.ts` with a `hardforkHistory` map. The part that cost real time: it also needs an explicit `chainType: "l1"` on that same descriptor. Leave it out and Hardhat defaults the descriptor to `"generic"`, which the fork's chain-override filter silently drops, no error, no warning, just the exact same hardfork error as if nothing had been configured at all. Nothing in Hardhat's forking docs mentions `chainType` as a requirement for a custom chain descriptor to actually take effect.

### B14. `[PITFALL]` Forking BSC over a free-tier RPC is slow in a specific, diagnosable way: eth_getProof returns huge proofs
Hit while writing the fork test suite (test/Covenant.fork.ts) on 2026-09-21. A `before` hook doing one impersonated ERC20 transfer plus a couple of contract deploys against the `bscFork` network was taking minutes per run, sometimes long enough to blow past Mocha's default 40s timeout even after raising it to 120s.

Traced it with `DEBUG=hardhat:*` and a manual RPC probe. Two different failure shapes on two different free-tier endpoints:

```
$ curl ... bsc.nodereal.io ... eth_getProof ...
{"error":{"code":-32005,"message":"limit exceeded"}}

$ curl ... bsc-mainnet.public.blastapi.io ... eth_getProof ...
{"result":{"accountProof":[... 9 trie nodes, each ~530 bytes ...], "storageProof":[...]}}
```

`bsc.nodereal.io` just refuses `eth_getProof` outright (rate-limited). `bsc-mainnet.public.blastapi.io` (the endpoint this project's `hardhat.config.ts` uses, per B12) does answer it, but BSC's state trie is deep enough that a single `eth_getProof` response for one account came back as multiple KB of nested trie nodes. Hardhat 3's EDR fork provider uses `eth_getProof` for efficient state fetching, so every new account or storage slot the fork touches for the first time costs one of these calls, and BSC's trie makes each one meaningfully heavier than the equivalent on Ethereum mainnet, which is what EDR's fork mode was clearly designed against first.

None of this is a bug exactly, and it isn't Binance's problem either, but it's a real, reproducible tax on the fork-first workflow this hackathon's own guidance points teams toward for BSC specifically. Nothing in Hardhat's or BSC's docs flags that BSC forking is meaningfully slower than Ethereum forking for this reason.

**Mitigation applied:** restructured the fork test suite to fork and fund once in a single `before` hook instead of once per test via `loadFixture` (which reforks per test), and raised the suite's Mocha timeout to 180s. Cut wall-clock time roughly 4x for the same coverage.

**Follow-up, same day:** even after that fix, two tests still failed with `429 Too Many Requests for host (bsc-mainnet.public.blastapi.io)`, traced to `contract.queryFilter(contract.filters.Attestation())` - ethers' obvious way to read an event back after a transaction. That call issues its own `eth_getLogs` RPC request, a second remote round trip for data the transaction receipt (`tx.wait()`) had already returned. Rewrote the tests to decode the event straight from `receipt.logs` via `contract.interface.parseLog(...)` instead, which removed the redundant call entirely rather than just adding a retry around it. Real lesson for anyone testing against a forked chain on a free-tier RPC: every `queryFilter` after a `tx.wait()` is spending rate-limit budget you don't need to spend.

### B15. `[DOCS][STOCK]` The real oracle-grade endpoints are undocumented on the official dev-docs site entirely, and the shipped skill undersells what they cover
Found while building the Phase 2 oracle updater, 2026-09-21. `web3.binance.com/en/dev-docs` (the site this hackathon's Resources tab points to) never mentions these at all. The only place they're documented is inside `binance-tokenized-securities-info/SKILL.md` in the `binance-skills-hub` GitHub repo - a skill file, not the API reference site:

```
GET https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=<id>&contractAddress=<addr>
GET https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai?chainId=<id>&contractAddress=<addr>
```

Public, no `X-OC-*` HMAC auth needed - just `Accept-Encoding: identity` and a `User-Agent` header. That alone is worth knowing: a team that only reads `web3.binance.com/en/dev-docs` (which does require the signed Web3 API key for its RWA endpoints) would build a signing layer for data that's actually available unauthenticated from a different, undocumented-on-the-main-site path.

The skill's own frontmatter describes itself as covering **"Ondo tokenized US stock data"** only, and its `type` parameter table says `type=1` is "currently the only supported tokenized stock provider." Tested that claim directly against real bStocks data (`chainId=56`, NVDAB's real address) rather than trusting the description:

```
$ curl '.../rwa/asset/market/status/ai?chainId=56&contractAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436'
{"openState": true, "marketStatus": null, "reasonCode": "TRADING", ...}   # works fine for bStocks

$ curl '.../rwa/dynamic/ai?chainId=56&contractAddress=0x02fca66c1d1afb4e2a7884261eb00f63598a7436'
{"symbol": "NVDAB", "ticker": "NVDA", "tokenInfo": {...}, "statusInfo": {...}, "type": 3, ...}  # also fine
```

Both return complete, correctly-typed (`"type": 3` = bStock) data for a real bStocks token. The underlying API is not Ondo-only - it's provider-agnostic by `chainId` + `contractAddress`. It's specifically the skill's own description and its `type` parameter table that undersell it as Ondo-only (matches C8, but this confirms the *API itself* isn't the limitation - the skill's documentation is). The one real gap found (not a description problem, an actual data gap) is B6 above: bStocks' `stockInfo.price` reference field really is missing, while Ondo's is populated.

### B16. `[PITFALL]` Hardhat's forked `eth_getLogs` hangs forever instead of surfacing the upstream's own rate-limit error
Found building the status page (Phase 2), 2026-09-21, trying to read `Attestation` events for a live demo. `covenant.queryFilter(...)` against a `hardhat node --fork` process never returned - not slow, not erroring, genuinely no response, confirmed with a bare `curl` (bypassing the browser and ethers entirely) that timed out after 15s with nothing back, for a range as small as 10 blocks.

Traced it by calling the same kind of `eth_getLogs` query directly against the fork's real upstream RPC (`bsc-mainnet.public.blastapi.io`), no Hardhat in the path at all:

```
$ curl ... blastapi ... eth_getLogs ...
{"error":{"code":-32000,"message":"Your request has been rate-limited due to unusually high
traffic on the Alchemy public API. Consider creating a free Alchemy account..."}}
(0.3s, clean fast response)
```

Two findings here. First, incidentally: `bsc-mainnet.public.blastapi.io` is Alchemy-backed under the hood, and its `eth_getLogs` is rate-limited independently of the account-state issues already logged in B12/B14 - it answers instantly with a clear error, it doesn't hang. Second, and this is the real bug: Hardhat 3's EDR fork provider, when its upstream `eth_getLogs` call gets that same rate-limit response, does not propagate it back to the caller. It just hangs - no error, no timeout, indefinitely (waited over a minute in one case). A developer would have no way to tell "still working" apart from "will never return" without independently bypassing Hardhat to query the upstream directly, which is what it took to actually find this.

**Practical consequence:** this is a forking-and-testing-only problem, not a production one - a status page pointed at a real, non-forked BSC RPC hits the same underlying rate limit but gets the fast, clean error above, which normal error handling (`try`/`catch`) already deals with correctly. It only turns into an indefinite hang when the same rate-limited endpoint is queried *through* a local Hardhat fork. Cost real time here since a hang gives no signal to know it's even the RPC's fault rather than a bug in the calling code.

**Follow-up, same day: found the exact boundary.** Demonstrating the status page live turned up a precise threshold, not just "sometimes hangs." On a fork whose local chain was 8 blocks past the fork point (one deploy + several seed transactions, all mined locally after forking):

```
fromBlock=latest-5  (range entirely local)         -> 13ms,   4 logs
fromBlock=latest-8  (range entirely local)         -> 14ms,   7 logs
fromBlock=latest-9  (range touches 1 pre-fork block) -> hangs, still nothing after 5s
```

Every range that stays entirely within locally-mined, post-fork blocks resolves instantly - EDR clearly does serve those from its own local state without touching the network. The instant a range includes even a single block from *before* the fork point, it hangs indefinitely trying to proxy that portion to the rate-limited upstream. So the earlier characterization ("large ranges are slow") wasn't quite right - range size is irrelevant; what matters is whether the range crosses the fork boundary at all. A one-block range that happens to be the single pre-fork block would hang exactly as badly as a 50,000-block one.

**Practical workaround for anyone hitting this**: query only `fromBlock >= (the block the fork was taken at)`. For this project's own status page and scripts, that means passing the real deployment block as `fromBlock` rather than any "last N blocks" heuristic - the page's own placeholder text already recommends this, and this finding is why.

### B17. `[STOCK][PITFALL]` `tokenInfo.volume24h` from the RWA Dynamic V2 endpoint is not trustworthy - confirmed by independent on-chain verification, not just a hunch
Building the `survey` command (compares all three providers for one ticker), the same "Binance's own reported number doesn't match reality" pattern from B6 showed up again, worse and easier to prove this time.

For real TSLAx (xStock, `0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0`), the live endpoint reported `tokenInfo.volume24h: "13756649423.5843249"`. An independent check - real `eth_getLogs` against real BSC state, counting actual `Transfer` events on that exact contract over the prior ~2500 blocks (~2 hours) - found **zero**. Not low. Zero.

```
$ curl '.../rwa/dynamic/ai?chainId=56&contractAddress=0x8ad3c73f833d3f9a523ab01476625f269aeb7cf0'
tokenInfo.volume24h: "13756649423.5843249"

$ real eth_getLogs, same contract, ~2500 blocks back
Transfer events found: 0
```

One more thing made this more than "one weird number" at the time: in that same session, the exact same `volume24h` value (`13756649423.5843249`) was also returned for **TSLAon**, a completely different contract on a completely different provider - real, live, currently-trading, 31 real transfers found on chain in the same window. Separately, `NVDAB` and `NVDAx` (different tickers, different providers) also briefly shared an identical value (`"20312925390"`) despite `NVDAB` showing 2177 real on-chain transfers against `NVDAx`'s 3. **Re-checked fresh in a later session**, though: `TSLAx` and `TSLAon` no longer match each other at all (`12433648121` vs `13756471512.88...`), so this isn't a permanently frozen or hardcoded shared value - more likely some kind of intermittent caching or batching on Binance's side that occasionally lets two tokens' figures collide for a window, not a constant. Downgrading that part of the claim accordingly; it's suggestive, not proven.

### B18. `[PITFALL]` `wallet send` silently requires the recipient to already be in the App's address book - undocumented in the skill, found on the very first real send
Hit on 2026-09-24, Phase 3 Day 1's gate: funding a freshly-generated deployer address (needed because `baw contract-call` requires an existing `--to`, so it can't deploy a contract - there is no `contract deploy`/`contract create` command anywhere in the CLI's help output).

```
$ baw wallet send --binanceChainId 56 --amount 0.0003 --tokenAddress 0xeeee...eeee --recipient 0x4FF4...0d418 --json
{
  "success": false,
  "error": {
    "code": 351703,
    "name": "SERVICE_ERROR",
    "message": "This transfer was blocked because the recipient address is not in your address book. Add this address in your binance wallet app, then retry the transfer."
  }
}
```

Nothing in `AW/SKILL.md` or `AW/references/wallet-view.md`/`approvals.md` mentions an address-book precondition for `wallet send` - the flag is documented as `--recipient <recipient>`, full stop, no note that it must already be a saved contact. A third-party press mention ("transfers restricted to whitelisted addresses saved in a user's address book") had been flagged in `opus-2026-09-24/d-agentic-wallet-mechanics.md` as unverified, search-snippet-only. **This confirms it's real**, live, on the very first attempt - not a search artifact.

This is a genuine UX/DX gap for exactly the pattern Binance's own docs recommend (a fresh, disposable deployer key per project, funded from the main wallet): the CLI gives no way to add an address to the book programmatically, so a human has to open the App and add the recipient by hand before any agent-driven send to a new address can succeed. An unattended agent following the documented flow verbatim would simply fail here with no recovery path.

The load-bearing claim - real reported volume, zero real on-chain activity - was independently re-verified in a separate session, at a different time, with a different check of the same window size, and held: still 0 real `Transfer` events for `TSLAx`. The check method itself was also verified against a known-liquid control in the same pass (`NVDAB`, same window size, same RPC: 12,893 real transfers found), ruling out "the on-chain check itself is just broken."

**Verdict:** `tokenInfo.volume24h` cannot be used on its own to judge whether a tokenized-stock listing is actually liquid - it doesn't move with real on-chain activity for at least one real, reproducible case (`TSLAx`). `survey` (this project's own multi-provider comparison tool) reports it anyway, labeled `binanceReported`, next to an independently-verified `onChainVerified` transfer count, and makes tradability decisions off the latter only. **Redesign suggestion:** either fix `volume24h` to reflect real per-token activity, or document plainly that it's not a live per-token figure - right now it looks like real-time per-token data and isn't.

---

## C. Agentic Wallet / Wallet Skills

### C1. `[AI-STACK][DOCS]` Three contradictory frontmatter schemas in one repo
- `README.md`: `title:` / `description:` / `metadata.version` / `metadata.author` / `license`
- `CONTRIBUTING.md`: `name` / `description` / `version` / `license` (flat)
- **Actual shipped skills**: `name` + `description` + nested `metadata.version` + `metadata.author`, mostly omitting `license`

Three sources, three answers. The authoritative one is the code.
https://github.com/binance/binance-skills-hub/blob/main/README.md vs `/CONTRIBUTING.md`

### C2. `[AI-STACK][ONBOARD]` Node version contradiction across official sources
Install quickstart says **Node.js 18+**. Repo README says **Node.js 22 or higher**. Shipped `scripts/cli.mjs` files carry "zero-dep, Node >= 22".
A developer following the official quickstart on Node 18 installs fine, then hits runtime failures in script-based skills.

### C3. `[AI-STACK]` `CONTRIBUTING.md` says `skill.md` (lowercase)
Every real skill uses `SKILL.md` (uppercase), and the installer is **case-sensitive on Linux.**

### C4. `[AI-STACK]` `CONTRIBUTING.md` invents the word "frontformatter"
Used twice for "frontmatter". Also references "Clawhub", a name appearing nowhere else in the repo or docs. Minor — but it's the first file a new contributor reads.

### C5. `[DOCS]` The skills reference page is thinner than the skill it documents
`developers.binance.com/en/docs/products/agentic-wallet/reference/skills` summarises capabilities in prose with **no command syntax**. The real reference is 4,087 lines of markdown inside the repo. The docs site points at the repo, but nothing says plainly that the repo *is* the source of truth.

### C6. `[AI-STACK][DOCS]` The tokenized-stock use case has no executable content
`developers.binance.com/en/docs/products/agentic-wallet/use-cases/trading/stock-trading` gives prompts and a three-step narrative but **no CLI commands, no chain/network statement, and no complete provider list** — despite being the page the hackathon's own Resources tab points at for its own subject matter. It's a prompt cookbook, not a tutorial.

### C7. `[AI-STACK][PITFALL]` The official ticker-resolution endpoint is documented only inside a skill file
The `.../buw/wallet/market/token/rwa/stock/detail/list/ai?type=<n>` endpoint and the `type=1/2/3` → Ondo/xStocks/bStock mapping appear in `binance-agentic-wallet/SKILL.md` — **not** on the tokenized-stock use-case page where anyone would look. The path is `bapi/defi/v1/public/...`, an internal-looking route with no stability guarantee.

### C8. `[AI-STACK][STOCK]` The official info skill is Ondo-only but named generically
`binance-tokenized-securities-info` frontmatter says "Query Ondo tokenized US stock data". `binance-agentic-wallet/SKILL.md` explicitly warns that older versions "only know `type=1` (Ondo)".
**For a bStocks-centred hackathon, the official info skill does not cover the flagship provider.**

### C9. `[AI-STACK]` Expired content still shipping inside the live skill
`references/campaign.md` (288 lines) describes a campaign that ended **2026-09-01**. As of 2026-09-20 it is still on `main`, relying on a prose "expiry switch" asking the LLM to check today's date and ignore the file. The file itself says "after the campaign ends this file will be removed in a skill update" — it wasn't.
**Dead instructions inside a live skill are a real prompt-hygiene smell.**

### C10. `[AI-STACK][PITFALL]` Version checking is an LLM instruction, not code
`baw skill-check` / `baw cli-check` exist, but whether they run depends on the model faithfully executing `references/preflight.md` at conversation start. **Non-deterministic version enforcement** is a genuine reliability concern for anything built on top.

### C11. `[AI-STACK]` Version drift risk between repo and npm
Skill declares `metadata.version: '1.12.0'` and `requiredCliVersion: '1.10.0'`; npm `@binance/agentic-wallet` latest is 1.10.0. Consistent today — but preflight instructs a *pinned* install, so a skill update bumping `requiredCliVersion` before npm publishes would wedge the install.

### C12. `[AI-STACK][PITFALL]` Unit inconsistency inside one command
`contract-call --value` is in **wei**, while `--amount` elsewhere is human-readable. A documented footgun, and exactly the decimal-mismatch class that bit us on Hedera in NameGate.

### C13. `[AI-STACK]` The `metadata.openclaw` namespace is unspecified
"OpenClaw" appears in Binance frontmatter and the README's agent list, but no spec could be located. Whether the block is required, advisory, or Binance-internal is undocumented.

### C14. `[AI-STACK][ONBOARD]` Developer mode auto-disables after 7 days of external-transaction inactivity — confirmed hands-on, 2026-09-20
Enabled developer mode on a newly-created Agentic Wallet. **It turns itself back off after 7 days if the wallet has no external transaction activity.** Not mentioned anywhere in the docs read during pre-build research (Agentic Wallet welcome/quickstart/skills reference).

**Why it matters:** the recommended workflow (per this project's own process) is to develop against a Hardhat fork of BSC mainnet for days at a time, and only touch the real Agentic Wallet for periodic real transactions. A team following that exact best practice — fork-first, minimize real spend — could unknowingly let developer mode lapse mid-build, then discover `contract-call` silently stops working right before a demo, with no warning in-app tying the failure back to the 7-day rule.

**Mitigation applied:** schedule at least one trivial real transaction (e.g. a $0.01 self-transfer) at least every 5–6 days during the build window to keep developer mode alive, rather than relying on it staying on for the full ~3 weeks untouched.

**Redesign suggestion:** surface a countdown or expiry warning in the Agentic Wallet UI before developer mode silently disables, and mention the timeout explicitly on the developer-mode-enable screen and in the docs.

### C15. `[AI-STACK][PITFALL]` `wallet send` to a new address is blocked with no way to fix it from the CLI - confirmed live, 2026-09-24
Phase 3 Day 1's gate needed a fresh, disposable deployer key funded with a small amount of real BNB from the Agentic Wallet (necessary because `contract-call` requires an existing `--to`, so it can't deploy a contract at all - see C16). The very first `wallet send` to that brand-new address failed:

```
$ baw wallet send --binanceChainId 56 --amount 0.0003 --tokenAddress 0xeeee...eeee --recipient 0x4FF4...0d418 --json
{
  "success": false,
  "error": {
    "code": 351703,
    "name": "SERVICE_ERROR",
    "message": "This transfer was blocked because the recipient address is not in your address book. Add this address in your binance wallet app, then retry the transfer."
  }
}
```

Nothing in `AW/SKILL.md` or the `wallet send` reference docs mentions an address-book precondition - the flag is documented as `--recipient <recipient>`, full stop. A third-party press mention of address-book-restricted transfers had been flagged as unverified, search-snippet-only, in pre-build research; this confirms it's real, on the very first live attempt, not a search artifact.

**No CLI escape hatch.** There is no `baw` command to add an address to the book. The fix required a human opening the Binance App and manually saving the address - and even that took several attempts: toggling the unrelated `abnormalTxnHandling` setting from `AutoReject` did nothing (different guardrail, same error), and the first attempt at adding the address inside the app also didn't immediately clear the block, for reasons still unclear (possibly network-selection or propagation delay - the second attempt, minutes later, worked).

**Why it matters for the special:** this is exactly the pattern Binance's own docs recommend (a fresh, disposable per-project deployer key, funded from the main wallet) and it has no unattended path. An autonomous agent following the documented flow verbatim would simply fail here with no recovery - a real gap for the "automated strategies" story Binance's own workshop pitched.

### C16. `[AI-STACK][PITFALL]` A contract-creation receipt with `to: ""` instead of `to: null` crashes hardhat-ethers's signer wrapper mid-deploy
Confirmed live, 2026-09-24, deploying `contracts/Gate.sol` (Phase 3 Day 1's throwaway gate-test contract) to real BSC mainnet via `bsc-mainnet.public.blastapi.io`.

`ContractFactory.deploy()` broadcast the transaction successfully - it really did land on chain, in a real block, with real bytecode at the resulting address, independently confirmed via a raw `eth_getTransactionReceipt` call afterward. But the promise from `.deploy()` still rejected:

```
Error: invalid value for value.to (invalid address (argument="address", value="", code=INVALID_ARGUMENT, ...))
  at HardhatEthersProvider.getTransaction (.../hardhat-ethers-provider.ts:411:7)
  at async checkTx (.../signers.ts:193:28)
```

The root cause: `hardhat-ethers`'s `HardhatEthersSigner.sendTransaction()` wrapper does an extra post-broadcast re-fetch of the transaction (`checkTx`) to hand back a fully-typed ethers `TransactionResponse`. For a contract-creation transaction, the raw JSON-RPC response from this endpoint sets `"to": ""` (empty string) rather than `"to": null`. Ethers v6's own transaction formatter treats an empty string as an invalid address and throws, rather than treating it as "no recipient" the way it does for `null`/`undefined`. This isn't a Covenant bug and isn't Binance's stack either - it's an RPC-formatting quirk this specific free-tier endpoint has, colliding with a stricter-than-necessary parser in `hardhat-ethers`.

**Practically:** the deploy transaction itself always succeeds or fails independently of this crash - the crash happens strictly in the reporting/confirmation layer, after broadcast. But naive script logic that assumes `.deploy()` resolving is the only success signal will incorrectly treat every mainnet-via-`bsc`-network deploy as failed, even when it worked. **Fixed by bypassing `hardhat-ethers`'s wrapped signer for real mainnet deploys**: use a raw `ethers.Wallet` connected directly to a plain `ethers.JsonRpcProvider`, the same pattern `scripts/chaos-fork.ts` and `scripts/seed-status-page-demo.ts` already use against the fork, and independently confirm success via a direct `eth_getTransactionReceipt` call rather than trusting the ethers promise chain alone - the same "verify on-chain state, don't trust the return value" discipline this project already holds to everywhere else.

### C17. `[AI-STACK][STOCK][PITFALL]` `market-order list` reports a bStock fill in *share* units; the chain moves *token* units, and nothing says which
Found 2026-09-25, reconciling the Day-1 gate's real NVDAB buy (`docs/evidence/day1-gate-swap.json`, tx `0xaf1be071...eae37`) against the wallet's real balance on a mainnet fork.

```
baw market-order list --orderId 26092400001913061390
  "toTokenActualQty": "0.001578888415748593"

ERC-20 Transfer(to = the Agentic Wallet) in the same tx's receipt
  data: 0x...059adfbe301f1e  = 0.001577660642762526

NVDAB's own non-standard event 0x0226a2f5..., same tx, two values:
  0x...059adfbe301f1e = 0.001577660642762526   (tokens)
  0x...059bfd9b2921f1 = 0.001578888415748593   (shares - matches Binance's number)

ratio: 1.000778224  = NVDAB's sharesMultiplier from the RWA dynamic endpoint
```

So the quantity Binance's order API calls the "actual" fill is the share amount. What the wallet actually received, and what `balanceOf` returns, is 0.078% less. The response has no unit field, no `sharesMultiplier`, and the skill docs describe `toTokenActualQty` as the token quantity.

**Why it matters:** anything that reconciles Binance's own reported fills against chain state (an accountant, a PnL tracker, Covenant's `verify.ts`) sees a mismatch on every single honest bStock trade. It's the same class as the NameGate 8-vs-18-decimal bug, one layer up: not decimals, but share vs token units. An agent that settles with Binance's number would get every trade flagged. Covenant settles with the on-chain `Transfer` amount instead, and `verify.ts` compares against that.

**Redesign suggestion:** return both `toTokenActualQty` (token units, what `balanceOf` moves) and `toShareActualQty`, or at minimum document which one the field is and include the `sharesMultiplier` used.

### C18. `[STOCK][DOCS]` While the NYSE is closed, the market-status endpoint says bStocks are "TRADING" and gives no session information at all
Checked live on Friday 2026-09-25 at 07:21 UTC, with the NYSE closed (it opens at 13:30 UTC), for Covenant's closed-market drift guard, which needs to know when the underlying exchange is shut.

```
GET .../rwa/asset/market/status/ai?chainId=56&contractAddress=0x02fca6...7436    (NVDAB, bStock)
{"openState":true,"marketStatus":null,"reasonCode":"TRADING","reasonMsg":null,"nextOpenTime":null,"nextCloseTime":null}

GET .../rwa/asset/market/status/ai?chainId=56&contractAddress=0xa9ee28...6f75    (NVDAon, Ondo)
{"openState":true,"marketStatus":"overnight","reasonCode":"TRADING","reasonMsg":null,"nextOpenTime":1790323260000,"nextCloseTime":1790322900000}
```

The bStock trades around the clock, so `TRADING` is true of the token, but every field that could say the *underlying* market is closed is null. Ondo does report a session, `overnight`, but its `nextCloseTime` (07:55 UTC) and `nextOpenTime` (08:01 UTC) are Ondo's own session boundaries, not NYSE's, and they're in milliseconds while the rest of the API's timestamps in this project have been seconds.

**Why it matters:** this is the gap the hackathon's own opening pitch describes ("the tokenized stock trades straight through the weekend, priced off a reference that has not updated in two days"). An agent that asks Binance's status endpoint whether NVDA's market is open, for the token this track most wants built on, gets "TRADING" at 3 a.m. New York time with nothing to indicate otherwise. Covenant works around it with a deterministic NYSE calendar in the oracle updater.

**Redesign suggestion:** add an underlying-market field (`underlyingSession: "regular" | "pre" | "post" | "closed"`, plus the next regular open and close) that's populated for bStocks too, and document the units of the time fields.

---

## D. BNB Agent Studio

### D1. `[ONBOARD][DOCS]` Contradictory install commands across official BNB sources
- Official blog (`bnbchain.org/en/blog/bnb-agent-studio-is-live-...`): **`pip install bnbagent-studio`**
- Landing page + developer docs: **`npm install --global @bnbagent/studio-cli`**

Different package managers, different ecosystems. The npm package is the real one (verified on the registry); no `bnbagent-studio` CLI could be found on PyPI.
**A developer following the blog first installs the wrong thing.**

### D2. `[DOCS][PITFALL]` Malformed command in the docs
`docs.bnbchain.org/developer-kit/bnbchain-studio/` renders the install as a single line:
```
npm install --global @bnbagent/studio-cli bag skills install
```
That is two commands concatenated — run as written, npm tries to install packages named `bag`, `skills`, and `install`. The quickstart page has it correctly on two lines. **Same docs site, same command, two renderings.**

### D3. `[PITFALL]` `docs.b402.ai` is NOT BNB Chain's b402 — namespace collision
`https://docs.b402.ai/` is the **top search result** for "b402 docs" and is an entirely unrelated project (confidential DeFi, Solana shielded pools, Jupiter swaps, Kamino lending, SDKs `@b402ai/solana`).
Binance's actual b402 docs are at `https://web3.binance.com/en/dev-docs/products/b402-api/`.
**Real time was lost here, and writing against the wrong SDK was narrowly avoided by cross-checking. A genuine trap for any entrant.**

### D4. `[PITFALL][DOCS]` The SDK contradicts itself on mainnet readiness
In `bnb-chain/bnbagent-sdk`:
- `.env.example:20` → `# Network preset. Currently ships: bsc-testnet (default), bsc-mainnet (TBD).`
- `ARCHITECTURE.md:251` → `└── bsc-mainnet (chain_id=56) - active, ERC-8183 + ERC-8004 deployed`
- `python/bnbagent/config.py:65-75` ships fully populated mainnet addresses.

On-chain verification confirms **mainnet is live**. The `.env.example` "(TBD)" is stale — and it would deter someone from trying mainnet, **which is the exact decision this hackathon hinges on.**

### D5. `[PITFALL]` Studio CLI is pre-alpha and churning daily
`@bnbagent/studio-cli` latest is **v0.0.14**, with **50 versions published in ~7 weeks** (since 2026-07-30), and a release published the same day as this research.
Docs warn: "Studio is under active development and may introduce breaking changes."
**Pinning an exact version is mandatory. A mid-hackathon breaking change is a live risk.**

### D6. `[PITFALL]` Azure deployment silently drops a supported feature
Azure Foundry supports "A2A scaffolds only; MCP entrypoint rejected." If you architect around the MCP face and then pick Azure, **deployment fails late.** AWS AgentCore is the safer target.

### D7. `[DOCS]` ERC-8183 has no auto-settlement, and the narrative implies otherwise
Quickstart states plainly: "No auto-settlement — operator must manually approve/reject/dispute buyer jobs."
A demo claiming a *fully* autonomous earn-and-settle loop would be overclaiming unless you build that automation on top of `bag erc8183 settle`.

### D8. `[PITFALL]` ERC-8004 Identity Registry is ERC-721 but not Enumerable
Mainnet registry has `balanceOf` / `ownerOf` / `tokenURI` but **no `totalSupply`** — confirmed live, it reverts with `execution reverted: 0x`.
No cheap on-chain way to count or enumerate agents. Any "browse all agents" feature needs an indexer.

### D9. `[PITFALL]` Malformed registration data already live on mainnet
`tokenURI(1)` returns a well-formed base64 data URI. **`tokenURI(2)` returns a bare address-like value** (`0x6446ad9821021eeb9f85b8a18b0153d58166d161`) instead of a URI.
Real agents on mainnet already carry non-conforming metadata — **any consumer must parse defensively.** Good edge-case test material.

### D10. `[DOCS]` `bag budget` auto-topup semantics are undocumented
The CLI reference lists the command, but no page documents the policy format or thresholds.
**This is the literal "self-funding via b402" prize criterion** and it has no reference page.

### D11. `[DOCS]` Hosting trial duration is inconsistently stated
The hackathon page says credits last "between 72 and 24h depending on the hosting you choose." The docs describe **one 48h trial**. The 24/72 split across hosting options is unreconciled anywhere.

---

## Open items to verify during the build

These are unknowns, not yet friction — resolve them and log the outcome.

| # | Question | Why it matters |
|---|---|---|
| 1 | Is `referencePrice` genuinely independent of on-chain price? | Can invalidate an entire product direction. **Test first.** |
| 2 | Does `contract-call preview/execute` work against a self-deployed BSC contract? | Documented but untested. The deep-build strategy rests on it. |
| 3 | Can you create an Agentic Wallet + enable developer mode in your jurisdiction? | Hard go/no-go for the primary plan. |
| 4 | Web3 API key issuance — instant or manually reviewed? | Schedule risk. Apply day 1. |
| 5 | Is mainnet ERC-8004 registration actually paymaster-sponsored? | Config says `use_paymaster=True`; sponsorship only *stated* for testnet. |
| 6 | AWS Bedrock AgentCore $/day for a persistent agent | The single unquantified cost. Not documented by BNB. |
| 7 | Authoritative bStocks redemption-hours policy | Resolves B5. Check the prospectus/FAQ. |
| 8 | Can the bStocks beacon admin add transfer restrictions later? | Centralisation risk (B11). |
