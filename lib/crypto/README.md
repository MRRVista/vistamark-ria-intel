# crypto — Digital Assets (CoinGecko)

Catalog id `crypto`. Exports `CRYPTO_TOOLS`, `CRYPTO_DOMAIN`, `CRYPTO_CHECKS` from `index.ts`.

## Source: CoinGecko public API v3 — `https://api.coingecko.com/api/v3`
- Auth: keyless "demo" tier. Optional `COINGECKO_API_KEY` sent as header `x-cg-demo-api-key` (demo keys only; a Pro key would require `pro-api.coingecko.com` + `x-cg-pro-api-key`, not supported).
- Limits: ~30 requests/min per IP keyless (the sandbox hit 429 after ~5 calls in 5 s; a 2-attempt backoff at 3 s / 6 s is applied and the error message names the fix). Demo key: 30/min, 10k/month.
- All endpoints verified live 2026-10-22 from the sandbox:

| Tool | Endpoint(s) | Cache |
|---|---|---|
| `coingecko_prices` | `/coins/markets?vs_currency=usd&ids=…&price_change_percentage=24h,7d,30d,1y` (one call for up to 25 coins; tickers outside a 60-symbol built-in map resolve via `/search?query=`) | 60 s (24 h for symbol→id) |
| `coingecko_markets` | `/coins/markets?order=market_cap_desc&per_page=N[&category=slug]` | 60 s |
| `coingecko_history` | `/coins/{id}/market_chart?vs_currency=usd&days=1..365` (5-min granularity ≤ 1 d, hourly ≤ 90 d, daily above; collapsed to daily UTC closes before stats) | 15 min |
| `coingecko_global` | `/global` + `/global/decentralized_finance_defi` | 60 s |

- Units: prices/caps/volumes in `vsCurrency` (default USD); percent changes are simple returns in percent; `annualizedVolPct` = stdev of daily log-free simple returns × √365 × 100; `maxDrawdownPct` from daily closes within the window.
- Quirks: `/coins/markets` returns `market_cap_rank: null` for some category constituents (e.g. staked-ether); `ath_change_percentage` is the ATH drawdown; `/search` ranks by relevance, the tool prefers an exact symbol match, then lowest market-cap rank. `/simple/price` was verified too but `/coins/markets` is used instead because it carries 7d/30d/1y changes and ATH in one call.
- `market_chart` with `days > 90` is daily; the "1 year change" in `coingecko_markets` comes from CoinGecko's own `price_change_percentage_1y_in_currency`.

## Env vars introduced
- `COINGECKO_API_KEY` (optional).

## Selftest checks (`CRYPTO_CHECKS`)
`coingecko_prices` (bitcoin, ETH; ~0.3 s) and `coingecko_global` (~0.2 s). Two checks = 3 upstream calls, well inside the per-minute budget.
