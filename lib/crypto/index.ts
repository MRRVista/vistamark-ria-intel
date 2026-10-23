/**
 * Digital Assets family — CoinGecko public API v3 (keyless demo tier, optional
 * COINGECKO_API_KEY demo header). See coingecko.ts for endpoints and README.md.
 *
 *   coingecko_prices   — spot price + 24h/7d/30d/1y change, mkt cap, volume, ATH drawdown for named coins
 *   coingecko_markets  — top-N by market cap (optionally by category) with the same fields
 *   coingecko_history  — one coin's price history (≤ 365 d): sampled series + return/vol/drawdown stats
 *   coingecko_global   — total market cap, BTC/ETH dominance, stablecoin share, DeFi share
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { coingeckoGlobal, coingeckoHistory, coingeckoMarkets, coingeckoPrices } from "./coingecko";

export const CRYPTO_TOOLS: ToolDef[] = [
  {
    name: "coingecko_prices",
    description:
      "Live quotes for specific digital assets from CoinGecko (keyless public API, ~1-minute freshness; optional COINGECKO_API_KEY raises limits). `ids` takes CoinGecko ids ('bitcoin','ethereum','solana') or tickers ('BTC','ETH','SOL' — 60 common tickers map directly, others resolve via CoinGecko search). Returns per coin: price (USD by default, `vsCurrency` for eur/gbp/btc…), market-cap rank, 24h/7d/30d/1y percent change, market cap, 24h volume, all-time high with drawdown % and date, and last-updated time. Use for 'where is bitcoin / ether trading?' and client digital-asset position marks; use coingecko_markets for a ranked universe, coingecko_history for return/vol statistics, and eodhd tools for spot-bitcoin ETFs (IBIT, FBTC) and crypto equities.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "up to 25 ids or tickers" },
        vsCurrency: { type: "string", default: "usd" },
      },
      required: ["ids"],
    },
    handler: coingeckoPrices,
  },
  {
    name: "coingecko_markets",
    description:
      "Top digital assets ranked by market capitalization from CoinGecko (keyless, live, ~1-minute freshness). Returns the top `limit` (default 15, max 25) coins with price, market cap, share of the listed total, 24h volume, 24h/7d/30d/1y percent change, drawdown from all-time high (and ATH date), fully diluted valuation and % of max supply in circulation. `category` narrows to a CoinGecko category slug such as 'stablecoins', 'decentralized-finance-defi', 'layer-1', 'meme-token', 'real-world-assets-rwa'. Use for a market-overview table, breadth ('how many top-10 coins are up on the week?') or to answer 'what is the largest DeFi token?'; use coingecko_global for aggregate cap and dominance.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 15, maximum: 25 },
        category: { type: "string", description: "CoinGecko category slug (optional)" },
        vsCurrency: { type: "string", default: "usd" },
      },
    },
    handler: coingeckoMarkets,
  },
  {
    name: "coingecko_history",
    description:
      "Price history and risk statistics for ONE digital asset from CoinGecko market_chart (keyless; `days` 1–365, default 90; hourly data under 90 days and daily above, both collapsed to daily UTC closes). Returns start/end price, total return %, high/low, maximum drawdown %, annualized volatility % (daily returns × √365), best/worst day, average daily volume and latest market cap, plus a sampled date/price/volume series (`points`, default 30, max 60) suitable for a sparkline or table. `id` accepts a CoinGecko id or ticker. Use for 'how volatile has bitcoin been this year?', drawdown context in a client conversation, or to compare an asset's realized vol with equities (cboe_vol_history) — for multi-year history beyond 365 days, run the tool with days=365 and note the window.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "CoinGecko id or ticker, e.g. bitcoin / BTC" },
        days: { type: "number", default: 90, maximum: 365 },
        points: { type: "number", default: 30, maximum: 60, description: "number of sampled series rows" },
        vsCurrency: { type: "string", default: "usd" },
      },
      required: ["id"],
    },
    handler: coingeckoHistory,
  },
  {
    name: "coingecko_global",
    description:
      "Aggregate digital-asset market snapshot from CoinGecko /global (keyless, live, updated every few minutes). Returns total crypto market cap (USD) and 24h change, total 24h volume, Bitcoin and Ether dominance %, combined USDT+USDC stablecoin share, the top-8 dominance table, counts of active coins and exchanges, and a DeFi block (DeFi market cap, DeFi share of total, DeFi/ETH ratio, 24h DeFi volume, top DeFi coin). Takes no arguments. Use to size the asset class in a portfolio-construction or client-education discussion, or as the headline line in a market brief; pair with coingecko_markets for the constituents.",
    inputSchema: { type: "object", properties: {} },
    handler: coingeckoGlobal,
  },
];

export const CRYPTO_DOMAIN: CatalogDomain = {
  id: "crypto",
  label: "Digital Assets (CoinGecko)",
  source: "CoinGecko public API v3 (api.coingecko.com) — keyless demo tier ~30 req/min; optional COINGECKO_API_KEY (x-cg-demo-api-key); live, cached in-memory 60 s (quotes/global) and 15 min (history)",
  tools: [
    { name: "coingecko_prices", backing: "live-api", probe: "unprobed", note: "/coins/markets by ids; tickers resolved via /search (cached 24h)" },
    { name: "coingecko_markets", backing: "live-api", probe: "unprobed", note: "/coins/markets top-N, optional category" },
    { name: "coingecko_history", backing: "live-api", probe: "unprobed", note: "/coins/{id}/market_chart ≤365d, collapsed to daily closes" },
    { name: "coingecko_global", backing: "live-api", probe: "unprobed", note: "/global + /global/decentralized_finance_defi" },
  ],
};

export const CRYPTO_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "crypto: BTC/ETH quotes", tool: "coingecko_prices", args: { ids: ["bitcoin", "ETH"] }, note: "one /coins/markets call; expect price, change24hPct, marketCap for both" },
  { name: "crypto: global snapshot", tool: "coingecko_global", args: {}, note: "two calls (/global, DeFi); expect totalMarketCapUSD and btcDominancePct" },
];
