/**
 * CFTC Commitments of Traders via the CFTC Public Reporting Socrata portal.
 * KEYLESS (SOCRATA_APP_TOKEN optional; raises throttling ceiling).
 *
 * Datasets (all verified live 2026-10-22; latest report_date 2026-10-13,
 * i.e. the report released Friday 10/17 for positions as of Tuesday 10/13):
 *   Legacy        futures-only 6dca-aqww   combined (fut+opt) jun7-fc8e
 *   Disaggregated futures-only 72hh-3qpy   combined            kh3c-gbw2
 *   TFF           futures-only gpe5-46if   combined            yw9f-hn96
 *
 *   GET https://publicreporting.cftc.gov/resource/<id>.json?$select=...&$where=...&$order=...&$limit=...
 *
 * Field names (live): all numbers arrive as strings; dates as
 * "2026-10-13T00:00:00.000". Note CFTC's own typos — legacy spread column is
 * `noncomm_postions_spread_all`, disaggregated swap columns are
 * `swap__positions_short_all` / `swap__positions_spread_all` (double underscore).
 * Legacy ("_old"/"_other" = old-crop/other-crop splits) — we only use the
 * `_all` columns. Market identity: `cftc_contract_market_code` (e.g. GOLD
 * COMEX 088691, E-MINI S&P 500 13874A, UST 10Y NOTE 043602, WTI-PHYSICAL
 * 067651, NAT GAS NYME 023651). Contract names are terse and sometimes
 * surprising ("UST 10Y NOTE", not "10-YEAR"; "NAT GAS NYME"; "WTI-PHYSICAL"),
 * so cftc_cot resolves a keyword to the highest-open-interest matching
 * contract and reports the candidates it did not pick.
 */
import { jsonFetch } from "../data/http";
import { cached, clampInt, percentileRank, round } from "../research/common";

const HOST = "https://publicreporting.cftc.gov";
const HOUR = 60 * 60 * 1000;

export type CotReport = "legacy" | "disaggregated" | "tff";

export const COT_DATASETS: Record<CotReport, { futures: string; combined: string; label: string }> = {
  legacy: { futures: "6dca-aqww", combined: "jun7-fc8e", label: "Legacy (Commercial / Non-Commercial / Non-Reportable)" },
  disaggregated: { futures: "72hh-3qpy", combined: "kh3c-gbw2", label: "Disaggregated (Producer/Merchant, Swap Dealer, Managed Money, Other Reportable)" },
  tff: { futures: "gpe5-46if", combined: "yw9f-hn96", label: "Traders in Financial Futures (Dealer, Asset Manager, Leveraged Funds, Other Reportable)" },
};

/** Trader classes per report: label -> [longField, shortField, spreadField?]. */
const CLASSES: Record<CotReport, Array<{ key: string; label: string; long: string; short: string; spread?: string }>> = {
  legacy: [
    { key: "nonCommercial", label: "Non-Commercial (large speculators)", long: "noncomm_positions_long_all", short: "noncomm_positions_short_all", spread: "noncomm_postions_spread_all" },
    { key: "commercial", label: "Commercial (hedgers)", long: "comm_positions_long_all", short: "comm_positions_short_all" },
    { key: "nonReportable", label: "Non-Reportable (small traders)", long: "nonrept_positions_long_all", short: "nonrept_positions_short_all" },
  ],
  disaggregated: [
    { key: "producerMerchant", label: "Producer/Merchant/Processor/User", long: "prod_merc_positions_long", short: "prod_merc_positions_short" },
    { key: "swapDealer", label: "Swap Dealers", long: "swap_positions_long_all", short: "swap__positions_short_all", spread: "swap__positions_spread_all" },
    { key: "managedMoney", label: "Managed Money (hedge funds/CTAs)", long: "m_money_positions_long_all", short: "m_money_positions_short_all", spread: "m_money_positions_spread" },
    { key: "otherReportable", label: "Other Reportables", long: "other_rept_positions_long", short: "other_rept_positions_short", spread: "other_rept_positions_spread" },
    { key: "nonReportable", label: "Non-Reportable (small traders)", long: "nonrept_positions_long_all", short: "nonrept_positions_short_all" },
  ],
  tff: [
    { key: "dealer", label: "Dealer/Intermediary", long: "dealer_positions_long_all", short: "dealer_positions_short_all", spread: "dealer_positions_spread_all" },
    { key: "assetManager", label: "Asset Manager/Institutional", long: "asset_mgr_positions_long", short: "asset_mgr_positions_short", spread: "asset_mgr_positions_spread" },
    { key: "leveragedFunds", label: "Leveraged Funds (hedge funds/CTAs)", long: "lev_money_positions_long", short: "lev_money_positions_short", spread: "lev_money_positions_spread" },
    { key: "otherReportable", label: "Other Reportables", long: "other_rept_positions_long", short: "other_rept_positions_short", spread: "other_rept_positions_spread" },
    { key: "nonReportable", label: "Non-Reportable (small traders)", long: "nonrept_positions_long_all", short: "nonrept_positions_short_all" },
  ],
};

/** The class whose net position is the conventional "speculative positioning" gauge for each report. */
const SPEC_CLASS: Record<CotReport, string> = { legacy: "nonCommercial", disaggregated: "managedMoney", tff: "leveragedFunds" };

function soqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function soda<T = Record<string, unknown>>(datasetId: string, params: Record<string, string | number>): Promise<T[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
  const url = `${HOST}/resource/${datasetId}.json?${qs.toString()}`;
  // 2 attempts total on 429 is handled by politeFetch's retry (retries:1 → 2 attempts).
  const rows = await jsonFetch<T[]>(url, { headers, timeoutMs: 20000, retries: 1, retryDelayMs: 1500 });
  if (!Array.isArray(rows)) throw new Error(`CFTC Socrata ${datasetId}: unexpected response shape`);
  return rows;
}

function parseReport(v: unknown): CotReport {
  const s = String(v ?? "legacy").toLowerCase().trim();
  if (s.startsWith("dis")) return "disaggregated";
  if (s === "tff" || s.includes("financial")) return "tff";
  if (s === "legacy" || s === "" || s === "leg") return "legacy";
  throw new Error(`report must be legacy | disaggregated | tff (got '${v}')`);
}

function isoDay(v: unknown): string | null {
  const s = String(v ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

const KEYWORD_ALIASES: Array<[RegExp, string]> = [
  [/^(wti|crude|crude oil|oil)$/i, "WTI-PHYSICAL"],
  [/^(brent)$/i, "BRENT"],
  [/^(nat ?gas|natural gas|henry hub|ng)$/i, "NAT GAS NYME"],
  [/^(s&p|spx|s&p ?500|es|e-?mini s&p|e-?mini s&p ?500)$/i, "E-MINI S&P 500"],
  [/^(nasdaq|ndx|nq|nasdaq ?100)$/i, "NASDAQ MINI"],
  [/^(russell|rty|russell ?2000)$/i, "RUSSELL E-MINI"],
  [/^(dow|ym|djia)$/i, "DJIA"],
  [/^(10-?y(ear)?|10y|10 ?yr|tn|ty|10 year note|10-year note|10-year)$/i, "UST 10Y NOTE"],
  [/^(2-?y(ear)?|2y|2 year note|2-year)$/i, "UST 2Y NOTE"],
  [/^(5-?y(ear)?|5y|5 year note|5-year)$/i, "UST 5Y NOTE"],
  [/^(30-?y(ear)?|30y|t-?bond|bond|long bond|treasury bond)$/i, "UST BOND"],
  [/^(ultra bond|ultra t-?bond)$/i, "ULTRA UST BOND"],
  [/^(ultra 10|ultra 10y|ultra 10-year)$/i, "ULTRA UST 10Y"],
  [/^(sofr|3m sofr|three month sofr)$/i, "SOFR-3M"],
  [/^(dxy|dollar index|us dollar index|usd index)$/i, "USD INDEX"],
  [/^(eur|euro|eurusd|euro fx)$/i, "EURO FX"],
  [/^(jpy|yen|japanese yen)$/i, "JAPANESE YEN"],
  [/^(gbp|pound|sterling|british pound)$/i, "BRITISH POUND"],
  [/^(cad|canadian dollar|loonie)$/i, "CANADIAN DOLLAR"],
  [/^(aud|aussie|australian dollar)$/i, "AUSTRALIAN DOLLAR"],
  [/^(chf|swiss franc)$/i, "SWISS FRANC"],
  [/^(mxn|peso|mexican peso)$/i, "MEXICAN PESO"],
  [/^(btc|bitcoin)$/i, "BITCOIN"],
  [/^(eth|ether|ethereum)$/i, "ETHER"],
  [/^(vix|vix futures)$/i, "VIX FUTURES"],
  [/^(gc|gold)$/i, "GOLD"],
  [/^(si|silver)$/i, "SILVER"],
  [/^(hg|copper)$/i, "COPPER- #1"],
  [/^(pl|platinum)$/i, "PLATINUM"],
  [/^(pa|palladium)$/i, "PALLADIUM"],
  [/^(zc|corn)$/i, "CORN"],
  [/^(zw|wheat|chicago wheat|srw)$/i, "WHEAT-SRW"],
  [/^(zs|soybeans|beans)$/i, "SOYBEANS"],
  [/^(ho|heating oil|ulsd)$/i, "NY HARBOR ULSD"],
  [/^(rb|rbob|gasoline)$/i, "GASOLINE RBOB"],
  [/^(le|live cattle|cattle)$/i, "LIVE CATTLE"],
  [/^(he|lean hogs|hogs)$/i, "LEAN HOGS"],
  [/^(kc|coffee)$/i, "COFFEE C"],
  [/^(sb|sugar|sugar 11)$/i, "SUGAR NO. 11"],
  [/^(ct|cotton)$/i, "COTTON NO. 2"],
  [/^(cc|cocoa)$/i, "COCOA"],
];

function expandKeyword(kw: string): string[] {
  const t = kw.trim();
  const out = [t];
  for (const [re, canonical] of KEYWORD_ALIASES) {
    if (re.test(t)) {
      out.unshift(canonical);
      break;
    }
  }
  return Array.from(new Set(out));
}

interface MarketRow {
  contract_market_name: string;
  market_and_exchange_names: string;
  cftc_contract_market_code: string;
  commodity_name?: string;
  commodity_subgroup_name?: string;
  commodity_group_name?: string;
  latest: string;
  oi: string;
}

/** List contract markets whose name matches `keyword` (all words) with activity since `sinceIso`. */
async function searchMarkets(datasetId: string, keyword: string, sinceIso: string, limit: number): Promise<MarketRow[]> {
  const words = keyword.toUpperCase().replace(/[%_]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error("market keyword is required (e.g. 'GOLD', 'E-MINI S&P 500', 'UST 10Y NOTE', 'WTI')");
  const where = [
    ...words.map((w) => `upper(market_and_exchange_names) like ${soqlStr(`%${w}%`)}`),
    `report_date_as_yyyy_mm_dd > ${soqlStr(sinceIso)}`,
  ].join(" AND ");
  return cached(`cot:search:${datasetId}:${words.join(" ")}:${sinceIso}:${limit}`, 6 * HOUR, () =>
    soda<MarketRow>(datasetId, {
      $select:
        "contract_market_name,market_and_exchange_names,cftc_contract_market_code,commodity_name,commodity_subgroup_name,commodity_group_name,max(report_date_as_yyyy_mm_dd) as latest,max(open_interest_all) as oi",
      $where: where,
      $group: "contract_market_name,market_and_exchange_names,cftc_contract_market_code,commodity_name,commodity_subgroup_name,commodity_group_name",
      $order: "oi DESC",
      $limit: limit,
    })
  );
}

// ---------------------------------------------------------------------------
// cftc_cot_markets
// ---------------------------------------------------------------------------

export interface CotMarketsArgs {
  search: string;
  report?: string;
  combined?: boolean;
  limit?: number;
}

export async function cftcCotMarkets(args: CotMarketsArgs) {
  const report = parseReport(args.report);
  const ds = args.combined ? COT_DATASETS[report].combined : COT_DATASETS[report].futures;
  const limit = clampInt(args.limit, 25, 1, 60);
  const kw = String(args.search ?? "").trim();
  if (!kw) throw new Error("search keyword is required, e.g. 'GOLD', 'S&P', 'UST', 'NAT GAS', 'CRUDE'");
  const since = daysAgoIso(120);
  const rows = await searchMarkets(ds, kw, since, limit);
  return {
    source: `CFTC Commitments of Traders — ${COT_DATASETS[report].label}, ${args.combined ? "futures+options combined" : "futures only"} (publicreporting.cftc.gov dataset ${ds})`,
    fetchedAt: new Date().toISOString(),
    report,
    search: kw,
    activeSince: since,
    count: rows.length,
    markets: rows.map((r) => ({
      code: r.cftc_contract_market_code,
      contract: r.contract_market_name,
      marketAndExchange: r.market_and_exchange_names,
      commodity: r.commodity_name ?? null,
      subgroup: r.commodity_subgroup_name ?? null,
      latestReport: isoDay(r.latest),
      maxOpenInterest: num(r.oi),
    })),
    note:
      "Pass `code` (cftc_contract_market_code) or the exact `contract` name to cftc_cot. Names are CFTC's terse forms: 'UST 10Y NOTE' (not '10-YEAR'), 'NAT GAS NYME', 'WTI-PHYSICAL' (NYMEX CL), 'E-MINI S&P 500', 'COPPER- #1'. Only markets reported in the last 120 days are listed; sorted by peak open interest.",
  };
}

// ---------------------------------------------------------------------------
// cftc_cot
// ---------------------------------------------------------------------------

export interface CotArgs {
  market?: string;
  code?: string;
  report?: string;
  combined?: boolean;
  weeks?: number;
  lookbackWeeks?: number;
}

export async function cftcCot(args: CotArgs) {
  const report = parseReport(args.report);
  const ds = args.combined ? COT_DATASETS[report].combined : COT_DATASETS[report].futures;
  const weeks = clampInt(args.weeks, 12, 1, 104);
  const lookback = clampInt(args.lookbackWeeks, 52, 8, 260);
  const classes = CLASSES[report];

  // 1. Resolve market → contract code
  let code = String(args.code ?? "").trim();
  let chosen: MarketRow | null = null;
  let alternatives: MarketRow[] = [];
  if (!code) {
    const kw = String(args.market ?? "").trim();
    if (!kw) throw new Error("Provide `market` (keyword, e.g. 'GOLD', 'E-MINI S&P 500', 'UST 10Y NOTE', 'WTI') or `code` (cftc_contract_market_code).");
    const since = daysAgoIso(120);
    let found: MarketRow[] = [];
    for (const candidate of expandKeyword(kw)) {
      found = await searchMarkets(ds, candidate, since, 15);
      if (found.length) {
        // prefer exact contract-name match, else highest OI
        const exact = found.find((r) => r.contract_market_name.toUpperCase().trim() === candidate.toUpperCase().trim());
        chosen = exact ?? found[0]!;
        break;
      }
    }
    if (!chosen) {
      throw new Error(
        `No ${report} COT market active in the last 120 days matches '${kw}'. Try cftc_cot_markets with a shorter keyword (e.g. 'GOLD', 'S&P', 'UST', 'NAT GAS', 'CRUDE', 'EURO') — CFTC names are terse.`
      );
    }
    code = chosen.cftc_contract_market_code;
    alternatives = found.filter((r) => r.cftc_contract_market_code !== code).slice(0, 6);
  }

  // 2. Pull weekly history for the code (newest first)
  const fetchN = Math.max(weeks, lookback + 1);
  const fields = Array.from(
    new Set([
      "report_date_as_yyyy_mm_dd",
      "market_and_exchange_names",
      "contract_market_name",
      "commodity_name",
      "contract_units",
      "open_interest_all",
      "change_in_open_interest_all",
      "traders_tot_all",
      ...classes.flatMap((c) => [c.long, c.short, ...(c.spread ? [c.spread] : [])]),
    ])
  );
  const rows = await cached(`cot:hist:${ds}:${code}:${fetchN}`, 6 * HOUR, () =>
    soda<Record<string, string>>(ds, {
      $select: fields.join(","),
      $where: `cftc_contract_market_code=${soqlStr(code)}`,
      $order: "report_date_as_yyyy_mm_dd DESC",
      $limit: fetchN,
    })
  );
  if (!rows.length) throw new Error(`No ${report} COT rows for contract code '${code}' in dataset ${ds}. Verify the code with cftc_cot_markets.`);

  // 3. Compute per-week net positions by class (ascending for diffs)
  const asc = rows.slice().reverse();
  type WeekRow = { date: string; openInterest: number | null; oiChange: number | null; traders: number | null; net: Record<string, number | null>; long: Record<string, number | null>; short: Record<string, number | null>; spread: Record<string, number | null> };
  const weekly: WeekRow[] = asc.map((r) => {
    const net: Record<string, number | null> = {};
    const long: Record<string, number | null> = {};
    const short: Record<string, number | null> = {};
    const spread: Record<string, number | null> = {};
    for (const c of classes) {
      const l = num(r[c.long]);
      const s = num(r[c.short]);
      long[c.key] = l;
      short[c.key] = s;
      net[c.key] = l != null && s != null ? l - s : null;
      if (c.spread) spread[c.key] = num(r[c.spread]);
    }
    return { date: isoDay(r.report_date_as_yyyy_mm_dd) ?? "", openInterest: num(r.open_interest_all), oiChange: num(r.change_in_open_interest_all), traders: num(r.traders_tot_all), net, long, short, spread };
  });

  const latest = weekly[weekly.length - 1]!;
  const prev = weekly.length > 1 ? weekly[weekly.length - 2]! : null;
  const lbRows = weekly.slice(-(lookback + 1));
  const oi = latest.openInterest;

  const byClass = classes.map((c) => {
    const n = latest.net[c.key];
    const p = prev?.net[c.key] ?? null;
    const hist = lbRows.map((w) => w.net[c.key]).filter((v): v is number => v != null);
    const sorted = hist.slice().sort((a, b) => a - b);
    return {
      class: c.key,
      label: c.label,
      long: latest.long[c.key],
      short: latest.short[c.key],
      spread: c.spread ? latest.spread[c.key] : undefined,
      net: n,
      netPctOfOI: n != null && oi ? round((n / oi) * 100, 1) : null,
      wowChange: n != null && p != null ? n - p : null,
      wowChangeLong: latest.long[c.key] != null && prev?.long[c.key] != null ? latest.long[c.key]! - prev.long[c.key]! : null,
      wowChangeShort: latest.short[c.key] != null && prev?.short[c.key] != null ? latest.short[c.key]! - prev.short[c.key]! : null,
      [`percentile${lookback}w`]: n != null ? percentileRank(hist, n) : null,
      [`range${lookback}w`]: sorted.length ? { min: sorted[0], max: sorted[sorted.length - 1], mean: Math.round(hist.reduce((a, b) => a + b, 0) / hist.length) } : null,
    };
  });

  const specKey = SPEC_CLASS[report];
  const spec = byClass.find((b) => b.class === specKey)!;
  const specHist = lbRows.map((w) => w.net[specKey]).filter((v): v is number => v != null);
  const specPct = spec.net != null ? percentileRank(specHist, spec.net) : null;
  const sortedSpec = specHist.slice().sort((a, b) => a - b);
  const extreme =
    specPct == null ? null : specPct >= 90 ? "crowded long (≥90th pct)" : specPct <= 10 ? "crowded short (≤10th pct)" : specPct >= 75 ? "long-leaning" : specPct <= 25 ? "short-leaning" : "neutral";

  const history = weekly
    .slice(-weeks)
    .reverse()
    .map((w) => ({
      date: w.date,
      openInterest: w.openInterest,
      ...Object.fromEntries(classes.map((c) => [`${c.key}Net`, w.net[c.key]])),
    }));

  const name = rows[0]!.market_and_exchange_names;
  return {
    source: `CFTC Commitments of Traders — ${COT_DATASETS[report].label}, ${args.combined ? "futures+options combined" : "futures only"} (publicreporting.cftc.gov dataset ${ds})`,
    fetchedAt: new Date().toISOString(),
    report,
    market: { code, contract: rows[0]!.contract_market_name, marketAndExchange: name, commodity: rows[0]!.commodity_name ?? null, contractUnits: rows[0]!.contract_units ?? null },
    asOf: latest.date,
    previousWeek: prev?.date ?? null,
    openInterest: { latest: oi, wowChange: latest.oiChange, pctChange: oi != null && latest.oiChange != null && oi - latest.oiChange !== 0 ? round((latest.oiChange / (oi - latest.oiChange)) * 100, 2) : null, traders: latest.traders },
    speculativeGauge: {
      class: specKey,
      label: spec.label,
      net: spec.net,
      netPctOfOI: spec.netPctOfOI,
      wowChange: spec.wowChange,
      [`percentile${lookback}w`]: specPct,
      [`zscore${lookback}w`]:
        spec.net != null && specHist.length > 2
          ? (() => {
              const m = specHist.reduce((a, b) => a + b, 0) / specHist.length;
              const sd = Math.sqrt(specHist.reduce((a, b) => a + (b - m) * (b - m), 0) / (specHist.length - 1));
              return sd ? round((spec.net! - m) / sd, 2) : null;
            })()
          : null,
      [`min${lookback}w`]: sortedSpec[0] ?? null,
      [`max${lookback}w`]: sortedSpec[sortedSpec.length - 1] ?? null,
      reading: extreme,
    },
    positionsByClass: byClass,
    weeksReturned: history.length,
    history,
    alternatives: alternatives.length
      ? alternatives.map((a) => ({ code: a.cftc_contract_market_code, contract: a.contract_market_name, exchange: a.market_and_exchange_names.split(" - ").slice(1).join(" - "), maxOpenInterest: num(a.oi) }))
      : undefined,
    note:
      `Positions are CONTRACTS as of Tuesday's close (asOf), released the following Friday ~3:30pm ET. net = long − short (spread positions excluded). percentile${lookback}w = share of the last ${lookback} weekly nets ≤ latest (100 = most net-long in the window). ` +
      (report === "legacy"
        ? "Legacy: Non-Commercial = large speculators (funds), Commercial = hedgers; their nets roughly mirror each other."
        : report === "disaggregated"
          ? "Disaggregated (physical commodities): Managed Money = hedge funds/CTAs (the speculative gauge); Producer/Merchant = physical hedgers; Swap Dealers often carry index-fund length."
          : "TFF (financial futures): Leveraged Funds = hedge funds/CTAs; Asset Managers = institutional/real money (often structurally long equities); Dealers = sell-side intermediaries.") +
      " Use `combined: true` for futures+options; `lookbackWeeks` (default 52, ≤260) sets the percentile window. Keyword resolution picks the exact name or the highest-open-interest match — check `alternatives`/cftc_cot_markets if a different contract was intended.",
  };
}
