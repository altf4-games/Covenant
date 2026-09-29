# survey

Reports BSC status for a ticker under all three providers (Ondo, xStock, bStock) at once, each explicitly labeled - not just which ones exist, but which ones are actually tradeable right now.

## Why this exists, and why it doesn't just trust Binance's own numbers

`resolve` deliberately refuses to guess when a ticker is ambiguous across providers. `survey` is the other half of that: instead of picking one, show every candidate so a human (or an agent) can make an informed choice - including a provider that's real, deployed, and essentially dead.

Building this found a real, reproducible data-quality problem in Binance's own RWA Dynamic V2 endpoint: its `tokenInfo.volume24h` field does not reliably reflect real on-chain activity. For real `TSLAx` (xStock), the endpoint reported a large `volume24h` figure while an independent `eth_getLogs` check against real BSC state found **zero** real `Transfer` events over the window it checked at the time (a short one, about 3,000 blocks). Re-checked on 2026-09-29 over a wider window (10,000 blocks, about 75 minutes) it finds 4, against 185 for the same stock's bStock: nearly idle, not literally dead. The exact same reported figure also showed up, unchanged, on a completely unrelated token (`TSLAon`) - see `docs/partner-feedback/friction-log.md` B17 for the full write-up.

Because of that, `survey` does not classify a listing as tradeable based on Binance's reported figure. It independently counts real `Transfer` events for the token over a recent block window (tried across several public RPCs, since free-tier `eth_getLogs` is itself flaky - see friction-log.md B10) and classifies off that count instead. The window is as far back as the RPC will serve, up to 15,000 blocks in 5,000-block ranges, newest first; free endpoints refuse older ranges, so in practice it is about 10,000 blocks. `onChainVerified.blocksScanned` says how many were really covered. BSC produces a block about every 0.45 seconds, so that is roughly 75 minutes: a quiet but live token can show few transfers, so read the count and the window together. Binance's reported number is still included in the output, labeled `binanceReported`, for reference - just not trusted for the `status` field.

## Syntax

```bash
node scripts/cli.mjs survey '{"ticker":"<TICKER>"}'
```

## Example

```bash
$ node scripts/cli.mjs survey '{"ticker":"TSLA"}'
{
  "ticker": "TSLA",
  "providers": [
    { "provider": "ondo", "status": "live", "onChainVerified": { "transferCount": 31, ... }, ... },
    { "provider": "xstock", "status": "dead", "onChainVerified": { "transferCount": 0, ... }, "binanceReported": { "volume24h": "13756649423.58..." }, ... },
    { "provider": "bstock", "status": "live", "onChainVerified": { "transferCount": 72, ... }, ... }
  ]
}
```

Note `xstock` above: `binanceReported.volume24h` looks like real activity, but `onChainVerified.transferCount` - the number actually trusted for `status` - is 0. That contradiction is the point of this command. (This example is from the original short window; today the same call reports a handful of transfers for it, still a sliver of the bStock's. Each `onChainVerified` also carries `blocksScanned`.)

## `status` values

- `live` - listed on BSC, and real Transfer activity was found in the checked window.
- `dead` - listed on BSC, but the independent on-chain check found zero real Transfer events. Don't route a trade here regardless of what `binanceReported` says.
- `not-listed-on-bsc` - no BSC contract exists for this ticker under this provider at all.
- `unknown - on-chain check failed` - every liquidity-check RPC failed or was rate-limited before a real answer came back. Treat this the same as "don't know it's safe" - not the same as `dead`, and not the same as `live` either.
