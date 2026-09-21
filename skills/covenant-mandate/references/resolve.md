# resolve

Resolve a bare stock ticker to the exact provider-pinned contract address a Covenant mandate can actually be set up to allow. Refuses to guess whenever more than one candidate matches - **never treat a refusal as an error to retry differently; it means the caller (you) needs to ask the user which one they meant.**

## Why this needs its own command

Testing this live against Binance's real token list turned up two independent, real ambiguities, not one:

1. **Across providers.** The same ticker exists under multiple providers with different addresses - e.g. real `DRAM` resolves to both `DRAMon` (Ondo) and `DRAMB` (bStock) on BSC. `binance-agentic-wallet`'s own docs warn about exactly this class of bug.
2. **Across chains, even within one provider.** Less obvious, and not documented anywhere: a single provider can list the same ticker on multiple chains simultaneously. Real `NVDAon` (Ondo) exists on Ethereum, BSC, and Solana at once. An earlier version of this command only guarded ambiguity #1 - given `provider=ondo` alone, it silently returned the Ethereum-mainnet address instead of BSC's, the exact class of bug this command exists to prevent, just one axis deeper. Caught live, fixed, and now covered by a regression test (`test/skill-cli.live.ts`).

Both axes must collapse to exactly one match before this command returns anything. The one implicit default it applies: if `chainId` is omitted and filtering to BSC (`56`) alone already yields exactly one match, it uses that - this project only ever targets BSC, so that default is safe. Provider is never defaulted.

## Syntax

```bash
node scripts/cli.mjs resolve '{"ticker":"<TICKER>","provider":"<ondo|xstock|bstock>","chainId":"<chainId>"}'
```

`ticker` is required. `provider` and `chainId` are optional - omit them and the command will either resolve unambiguously or refuse with the full list of what it found.

## Example

```bash
$ node scripts/cli.mjs resolve '{"ticker":"NVDA","provider":"bstock"}'
{
  "resolved": {
    "chainId": "56",
    "contractAddress": "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
    "symbol": "NVDAB",
    "ticker": "NVDA",
    "type": 3,
    ...
  }
}
```

## Refusal example

```bash
$ node scripts/cli.mjs resolve '{"ticker":"NVDA"}'
resolve: "NVDA" is ambiguous across providers - specify one explicitly: NVDAon (provider=ondo, chainId=1, 0x2d1f...); NVDAon (provider=ondo, chainId=56, 0xa9ee...); NVDAx (provider=xstock, chainId=CT_501, ...); ...
(exit code 2)
```

On a refusal, show the user the full candidate list (also available as structured JSON on stderr's accompanying data) and ask them to specify a provider and/or chain, rather than picking one yourself.
