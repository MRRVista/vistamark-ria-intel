/**
 * CoinGecko public API v3 — https://api.coingecko.com/api/v3
 *   /simple/price, /coins/markets, /coins/{id}/market_chart, /global,
 *   /global/decentralized_finance_defi, /search, /ping
 * Keyless "demo" tier (~30 req/min per IP, 10k/month with a demo key). Optional
 * COINGECKO_API_KEY sent as `x-cg-demo-api-key` (demo keys stay on api.coingecko.com;
 * a Pro key would need pro-api.coingecko.com, not supported here). Verified live
 * 2026-10-22 from the sandbox: /ping, /simple/price, /coins/markets (with
 * price_change_percentage=24h,7d,30d,1y), /coins/bitcoin/market_chart?days=30,
 * /global, /global/decentralized_finance_defi and /search all returned 200.
 * Prices are USD (vs_currency), market caps/volumes in USD. Cached 60 s (prices,
 * markets, global) / 15 min (history) / 24 h (symbol resolution).
 */
import { jsonFetch, politeFetch, redactUrl } from "../data/http";
import { cached, clampInt, HOUR, round } from "../research/common";

const BASE = "https://api.coingecko.com/api/v3";
const MIN = 60 * 1000;

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const key = process.env.COINGECKO_API_KEY?.trim();
  if (key) h["x-cg-demo-api-key"] = key;
  return h;
}

async function cg<T = any>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const res = await politeFetch(url, { headers: headers(), retries: 2, retryDelayMs: 3000, timeoutMs: 20000 });
  if (res.status === 429) throw new Error("CoinGecko rate limit (HTTP 429) — keyless tier allows ~30 calls/min per IP; wait a minute or set COINGECKO_API_KEY (free demo key at coingecko.com/en/api)");
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 160);
    throw new Error(`CoinGecko HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body)}`);
  }
  return (await res.json()) as T;
}

/** Well-known symbols -> CoinGecko ids (avoids a /search call and symbol collisions). */
const SYMBOLS: Record<string, string> = {
  btc: "bitcoin", eth: "ethereum", usdt: "tether", bnb: "binancecoin", sol: "solana", xrp: "ripple",
  usdc: "usd-coin", ada: "cardano", doge: "dogecoin", trx: "tron", ton: "the-open-network", avax: "avalanche-2",
  link: "chainlink", dot: "polkadot", matic: "matic-network", pol: "polygon-ecosystem-token", ltc: "litecoin",
  bch: "bitcoin-cash", shib: "shiba-inu", uni: "uniswap", xlm: "stellar", near: "near", atom: "cosmos",
  xmr: "monero", etc: "ethereum-classic", apt: "aptos", sui: "sui", arb: "arbitrum", op: "optimism",
  fil: "filecoin", hbar: "hedera-hashgraph", icp: "internet-computer", aave: "aave", mkr: "maker",
  ldo: "lido-dao", steth: "staked-ether", wbtc: "wrapped-bitcoin", dai: "dai", pepe: "pepe", wif: "dogwifcoin",
  tao: "bittensor", render: "render-token", inj: "injective-protocol", sei: "sei-network", ondo: "ondo-finance",
  hype: "hyperliquid", algo: "algorand", vet: "vechain", xtz: "tezos", eos: "eos", crv: "curve-dao-token",
};

async function resolveId(input: string): Promise<string> {
  const s = input.trim().toLowerCase();
  if (SYMBOLS[s]) return SYMBOLS[s]!;
  if (/^[a-z0-9-]+$/.test(s) && s.length > 5) return s; // looks like an id already
  return cached(`cg:resolve:${s}`, 24 * HOUR, async () => {
    const data = await cg<any>("/search", { query: s });
    const coins: any[] = data?.coins ?? [];
    const exact = coins.find((c) => String(c.symbol).toLowerCase() === s) ?? coins.find((c) => String(c.id).toLowerCase() === s) ?? coins.find((c) => String(c.name).toLowerCase() === s);
    const pick = exact ?? coins.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
    if (!pick) throw new Error(`CoinGecko: no coin matches '${input}' — pass a CoinGecko id (e.g. bitcoin) or ticker (BTC)`);
    return String(pick.id);
  });
}

function pct(v: unknown): number | null { return round(Number(v), 2); }
function usd(v: unknown): number | null { return v == null ? null : round(Number(v), Number(v) >= 100 ? 0 : Number(v) >= 1 ? 2 : 6); }

export async function coingeckoPrices(args: any) {
  const raw: string[] = Array.isArray(args?.ids) ? args.ids : typeof args?.ids === "string" ? args.ids.split(",") : [];
  const list = raw.map((s) => String(s).trim()).filter(Boolean).slice(0, 25);
  if (!list.length) throw new Error("coingecko_prices: `ids` is required — list of CoinGecko ids or tickers, e.g. ['bitcoin','ETH','SOL']");
  const ids = await Promise.all(list.map(resolveId));
  const vs = String(args?.vsCurrency ?? "usd").toLowerCase();
  const key = ids.slice().sort().join(",");
  const rows = await cached(`cg:markets:${vs}:${key}`, MIN, () =>
    cg<any[]>("/coins/markets", { vs_currency: vs, ids: key, order: "market_cap_desc", per_page: "50", page: "1", sparkline: "false", price_change_percentage: "24h,7d,30d,1y" })
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const coins = ids.map((id, i) => {
    const r = byId.get(id);
    if (!r) return { input: list[i], id, error: "not returned by CoinGecko (check id)" };
    return {
      id: r.id,
      symbol: String(r.symbol).toUpperCase(),
      name: r.name,
      rank: r.market_cap_rank,
      price: usd(r.current_price),
      change24hPct: pct(r.price_change_percentage_24h_in_currency),
      change7dPct: pct(r.price_change_percentage_7d_in_currency),
      change30dPct: pct(r.price_change_percentage_30d_in_currency),
      change1yPct: pct(r.price_change_percentage_1y_in_currency),
      marketCap: round(r.market_cap, 0),
      volume24h: round(r.total_volume, 0),
      ath: usd(r.ath),
      athDrawdownPct: pct(r.ath_change_percentage),
      athDate: r.ath_date?.slice(0, 10) ?? null,
      lastUpdated: r.last_updated ?? null,
    };
  });
  return { source: "CoinGecko /coins/markets", fetchedAt: new Date().toISOString(), vsCurrency: vs, units: `${vs.toUpperCase()}; percentages are simple returns`, coins };
}

export async function coingeckoMarkets(args: any) {
  const limit = clampInt(args?.limit, 15, 1, 25);
  const vs = String(args?.vsCurrency ?? "usd").toLowerCase();
  const category = args?.category ? String(args.category) : undefined;
  const params: Record<string, string> = { vs_currency: vs, order: "market_cap_desc", per_page: String(limit), page: "1", sparkline: "false", price_change_percentage: "24h,7d,30d,1y" };
  if (category) params.category = category;
  const rows = await cached(`cg:top:${vs}:${limit}:${category ?? ""}`, MIN, () => cg<any[]>("/coins/markets", params));
  const totalCap = rows.reduce((a, r) => a + (r.market_cap ?? 0), 0);
  const coins = rows.map((r) => ({
    rank: r.market_cap_rank,
    id: r.id,
    symbol: String(r.symbol).toUpperCase(),
    name: r.name,
    price: usd(r.current_price),
    marketCap: round(r.market_cap, 0),
    shareOfListPct: totalCap ? round((100 * (r.market_cap ?? 0)) / totalCap, 1) : null,
    volume24h: round(r.total_volume, 0),
    change24hPct: pct(r.price_change_percentage_24h_in_currency),
    change7dPct: pct(r.price_change_percentage_7d_in_currency),
    change30dPct: pct(r.price_change_percentage_30d_in_currency),
    change1yPct: pct(r.price_change_percentage_1y_in_currency),
    athDrawdownPct: pct(r.ath_change_percentage),
    athDate: r.ath_date?.slice(0, 10) ?? null,
    fdv: round(r.fully_diluted_valuation, 0),
    circulatingPctOfMax: r.max_supply ? round((100 * r.circulating_supply) / r.max_supply, 1) : null,
  }));
  return {
    source: "CoinGecko /coins/markets",
    fetchedAt: new Date().toISOString(),
    vsCurrency: vs,
    category: category ?? "all",
    listedMarketCap: round(totalCap, 0),
    coins,
  };
}

export async function coingeckoHistory(args: any) {
  const input = String(args?.id ?? args?.coin ?? "").trim();
  if (!input) throw new Error("coingecko_history: `id` is required (CoinGecko id or ticker, e.g. bitcoin / BTC)");
  const id = await resolveId(input);
  const days = clampInt(args?.days, 90, 1, 365);
  const vs = String(args?.vsCurrency ?? "usd").toLowerCase();
  const points = clampInt(args?.points, 30, 5, 60);
  const data = await cached(`cg:chart:${id}:${vs}:${days}`, 15 * MIN, () =>
    cg<any>(`/coins/${encodeURIComponent(id)}/market_chart`, { vs_currency: vs, days: String(days) })
  );
  const prices: Array<[number, number]> = data?.prices ?? [];
  if (!prices.length) throw new Error(`CoinGecko: no price history for '${id}'`);
  // Collapse to one close per day (last observation of each UTC day), then stats on daily returns.
  const daily = new Map<string, { price: number; cap: number | null; vol: number | null }>();
  const caps: Array<[number, number]> = data?.market_caps ?? [];
  const vols: Array<[number, number]> = data?.total_volumes ?? [];
  prices.forEach(([t, p], i) => {
    const d = new Date(t).toISOString().slice(0, 10);
    daily.set(d, { price: p, cap: caps[i]?.[1] ?? null, vol: vols[i]?.[1] ?? null });
  });
  const series = [...daily.entries()].map(([date, v]) => ({ date, ...v }));
  const closes = series.map((s) => s.price);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i]! / closes[i - 1]! - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1)) : null;
  let peak = -Infinity, maxDd = 0;
  for (const c of closes) { if (c > peak) peak = c; const dd = c / peak - 1; if (dd < maxDd) maxDd = dd; }
  const first = closes[0]!, last = closes[closes.length - 1]!;
  const hi = Math.max(...closes), lo = Math.min(...closes);
  const step = Math.max(1, Math.ceil(series.length / points));
  const sampled = series.filter((_, i) => i % step === 0 || i === series.length - 1).map((s) => ({ date: s.date, price: usd(s.price), volume: round(s.vol, 0) }));
  const avgVol = vols.length ? vols.reduce((a, v) => a + (v[1] ?? 0), 0) / vols.length : null;
  return {
    source: "CoinGecko /coins/{id}/market_chart",
    fetchedAt: new Date().toISOString(),
    id,
    vsCurrency: vs,
    days,
    granularity: days <= 1 ? "5-min (collapsed to daily)" : days <= 90 ? "hourly (collapsed to daily closes)" : "daily",
    stats: {
      startDate: series[0]!.date,
      endDate: series[series.length - 1]!.date,
      startPrice: usd(first),
      endPrice: usd(last),
      totalReturnPct: pct((last / first - 1) * 100),
      high: usd(hi),
      low: usd(lo),
      maxDrawdownPct: pct(maxDd * 100),
      annualizedVolPct: sd != null ? pct(sd * Math.sqrt(365) * 100) : null,
      bestDayPct: rets.length ? pct(Math.max(...rets) * 100) : null,
      worstDayPct: rets.length ? pct(Math.min(...rets) * 100) : null,
      avgDailyVolume: round(avgVol, 0),
      latestMarketCap: round(series[series.length - 1]!.cap, 0),
    },
    series: sampled,
  };
}

export async function coingeckoGlobal(_args: any) {
  const [g, d] = await Promise.all([
    cached("cg:global", MIN, () => cg<any>("/global", {})),
    cached("cg:defi", MIN, () => cg<any>("/global/decentralized_finance_defi", {}).catch(() => null)),
  ]);
  const data = g?.data ?? {};
  const dom = data.market_cap_percentage ?? {};
  const defi = d?.data ?? null;
  const total = data.total_market_cap?.usd ?? null;
  return {
    source: "CoinGecko /global + /global/decentralized_finance_defi",
    fetchedAt: new Date().toISOString(),
    asOf: data.updated_at ? new Date(data.updated_at * 1000).toISOString() : null,
    totalMarketCapUSD: round(total, 0),
    totalVolume24hUSD: round(data.total_volume?.usd, 0),
    marketCapChange24hPct: pct(data.market_cap_change_percentage_24h_usd),
    btcDominancePct: pct(dom.btc),
    ethDominancePct: pct(dom.eth),
    stablecoinSharePct: pct((dom.usdt ?? 0) + (dom.usdc ?? 0)),
    topDominance: Object.fromEntries(Object.entries(dom).slice(0, 8).map(([k, v]) => [k.toUpperCase(), pct(v)])),
    activeCryptocurrencies: data.active_cryptocurrencies ?? null,
    markets: data.markets ?? null,
    defi: defi
      ? {
          defiMarketCapUSD: round(Number(defi.defi_market_cap), 0),
          defiSharePct: pct(defi.defi_dominance),
          defiToEthPct: pct(defi.defi_to_eth_ratio),
          defiVolume24hUSD: round(Number(defi.trading_volume_24h), 0),
          topCoin: defi.top_coin_name ?? null,
          topCoinSharePct: pct(defi.top_coin_defi_dominance),
        }
      : null,
  };
}

export async function coingeckoPing(): Promise<boolean> {
  try {
    const r = await jsonFetch<any>(`${BASE}/ping`, { headers: headers(), retries: 0, timeoutMs: 8000 });
    return Boolean(r?.gecko_says);
  } catch {
    return false;
  }
}
