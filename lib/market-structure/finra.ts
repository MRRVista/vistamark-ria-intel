/**
 * FINRA market-structure data — Reg SHO daily short-sale volume, consolidated
 * short interest, and TRACE fixed-income market aggregates.
 *
 * Upstreams (verified live 2026-10-21):
 *   - Reg SHO daily files: https://cdn.finra.org/equity/regsho/daily/<MKT>shvol<YYYYMMDD>.txt
 *     Pipe-delimited: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
 *     (volumes may be fractional). Markets: CNMS (consolidated across all FINRA
 *     facilities), FNSQ (Nasdaq TRF Carteret), FNQC (Nasdaq TRF Chicago), FNYX
 *     (NYSE TRF), FORF (ORF / OTC). Non-trading days and not-yet-published days
 *     return HTTP 403 from the CDN. Published each trading day ~6pm ET.
 *   - Consolidated short interest: POST https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest
 *     PUBLIC — no credentials needed. Partition key is settlementDate: sorting
 *     is only allowed when settlementDate is EQUAL-filtered, otherwise use
 *     dateRangeFilters and sort client-side.
 *   - TRACE aggregates (fixedIncomeMarket group: corporateMarketBreadth,
 *     corporateMarketSentiment, agencyMarketBreadth, agencyMarketSentiment,
 *     corporate144AMarketBreadth, corporate144AMarketSentiment,
 *     treasuryDailyAggregates, treasuryMonthlyAggregates). Metadata endpoints
 *     are public; DATA endpoints return 401 without an OAuth bearer token.
 *     Token: POST https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials
 *     with HTTP Basic (FINRA_API_CLIENT_ID:FINRA_API_CLIENT_SECRET). Free
 *     "public" API credentials are available from the FINRA API Console.
 */
import { politeFetch, redactUrl } from "../data/http";

// ─────────────────────────── helpers ───────────────────────────

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (v: number | null, d = 4): number | null =>
  v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
const clampInt = (v: any, def: number, lo: number, hi: number): number => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
};

export function normSymbols(input: any, max: number): string[] {
  const arr: string[] = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[,\s]+/)
      : [];
  const out = Array.from(
    new Set(arr.map((s) => String(s).trim().toUpperCase()).filter(Boolean))
  );
  return out.slice(0, max);
}

/** Today's date in America/New_York as YYYY-MM-DD. */
function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(iso: string, delta: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
const isWeekend = (iso: string) => {
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
};
const compact = (iso: string) => iso.replace(/-/g, "");
function parseDateArg(v: any): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`Bad date '${s}' — use YYYY-MM-DD`);
}

// ─────────────────────── Reg SHO daily short volume ───────────────────────

const REGSHO_BASE = "https://cdn.finra.org/equity/regsho/daily";
const REGSHO_MARKETS: Record<string, string> = {
  CNMS: "Consolidated NMS — all FINRA off-exchange facilities combined (default)",
  FNSQ: "FINRA/Nasdaq TRF Carteret",
  FNQC: "FINRA/Nasdaq TRF Chicago",
  FNYX: "FINRA/NYSE TRF",
  FORF: "FINRA ORF (OTC equities)",
};

interface ShoRow {
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  markets: string;
}
type ShoDay = { date: string; rows: Map<string, ShoRow> } | null; // null = no file

const SHO_TTL_MS = 6 * 3600_000;
const shoCache = new Map<string, { at: number; day: ShoDay }>();

async function fetchShoDay(market: string, iso: string): Promise<ShoDay> {
  const key = `${market}:${iso}`;
  const hit = shoCache.get(key);
  // A missing file for "today/yesterday" may appear later — cache misses only 30 min.
  if (hit && Date.now() - hit.at < (hit.day ? SHO_TTL_MS : 30 * 60_000)) return hit.day;

  const url = `${REGSHO_BASE}/${market}shvol${compact(iso)}.txt`;
  const res = await politeFetch(url, { retries: 1, timeoutMs: 12000, headers: { Accept: "text/plain, */*" } });
  let day: ShoDay = null;
  if (res.ok) {
    const text = await res.text();
    const rows = new Map<string, ShoRow>();
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split("|");
      if (p.length < 5 || !/^\d{8}$/.test(p[0])) continue;
      rows.set(p[1].toUpperCase(), {
        shortVolume: Number(p[2]) || 0,
        shortExemptVolume: Number(p[3]) || 0,
        totalVolume: Number(p[4]) || 0,
        markets: p[5] ?? "",
      });
    }
    day = rows.size ? { date: iso, rows } : null;
  } else if (res.status !== 403 && res.status !== 404) {
    throw new Error(`FINRA Reg SHO HTTP ${res.status} for ${redactUrl(url)}`);
  } else {
    await res.body?.cancel().catch(() => {});
  }
  shoCache.set(key, { at: Date.now(), day });
  if (shoCache.size > 120) shoCache.delete(shoCache.keys().next().value as string);
  return day;
}

/** Walk back from `end` over weekdays, fetching files in small parallel batches, until `n` days found. */
async function recentShoDays(market: string, end: string, n: number): Promise<{ days: NonNullable<ShoDay>[]; probed: number }> {
  const maxProbe = n + 6 + Math.ceil(n / 5); // weekdays only; allows for holidays + unpublished today
  const candidates: string[] = [];
  for (let d = end; candidates.length < maxProbe; d = addDays(d, -1)) {
    if (!isWeekend(d)) candidates.push(d);
  }
  const days: NonNullable<ShoDay>[] = [];
  let probed = 0;
  for (let i = 0; i < candidates.length && days.length < n; i += 5) {
    const batch = candidates.slice(i, i + 5);
    const got = await Promise.all(batch.map((d) => fetchShoDay(market, d)));
    probed += batch.length;
    for (const g of got) if (g && days.length < n) days.push(g);
  }
  return { days, probed };
}

async function finraShortVolume(args: any) {
  const market = String(args?.market ?? "CNMS").toUpperCase();
  if (!REGSHO_MARKETS[market]) throw new Error(`market must be one of ${Object.keys(REGSHO_MARKETS).join(", ")}`);
  const end = parseDateArg(args?.date) ?? todayET();
  const symbols = normSymbols(args?.symbols ?? args?.symbol, 10);
  const dataSource = `FINRA Reg SHO daily short-sale volume files (${REGSHO_BASE}/${market}shvol<YYYYMMDD>.txt)`;
  const caveat =
    "Covers ONLY trades reported to FINRA facilities (off-exchange/TRF + ORF), not exchange-executed volume — " +
    "so totalVolume is typically ~35-50% of consolidated-tape volume and shortRatio here is NOT the share of all trading that was short. " +
    "Market-maker hedging inflates short volume; ~45-55% ratios are normal for liquid names. Short VOLUME is a flow measure, not short INTEREST (see finra_short_interest).";

  if (!symbols.length) {
    // Ranking mode.
    const top = clampInt(args?.top, 20, 1, 50);
    const minVolume = Number(args?.minVolume ?? 1_000_000);
    const { days } = await recentShoDays(market, end, 1);
    if (!days.length) throw new Error(`No FINRA Reg SHO file found on or before ${end}`);
    const day = days[0];
    const ranked = [...day.rows.entries()]
      .filter(([, r]) => r.totalVolume >= minVolume)
      .map(([sym, r]) => ({
        symbol: sym,
        shortVolume: Math.round(r.shortVolume),
        totalVolume: Math.round(r.totalVolume),
        shortRatio: round(r.shortVolume / r.totalVolume, 4),
      }))
      .sort((a, b) => (b.shortRatio ?? 0) - (a.shortRatio ?? 0));
    return {
      dataSource,
      mode: "rank",
      market,
      date: day.date,
      minVolume,
      universe: ranked.length,
      top: ranked.slice(0, top),
      note: `Top ${top} symbols by FINRA-reported short ratio on ${day.date} among ${ranked.length} names with ≥${minVolume.toLocaleString()} FINRA-reported shares. ${caveat}`,
    };
  }

  const days = clampInt(args?.days, 10, 1, 30);
  const { days: found, probed } = await recentShoDays(market, end, days);
  if (!found.length) throw new Error(`No FINRA Reg SHO files found on or before ${end}`);
  const results = symbols.map((sym) => {
    const series = found
      .map((d) => {
        const r = d.rows.get(sym);
        return r
          ? {
              date: d.date,
              shortVolume: Math.round(r.shortVolume),
              shortExemptVolume: Math.round(r.shortExemptVolume),
              totalVolume: Math.round(r.totalVolume),
              shortRatio: r.totalVolume ? round(r.shortVolume / r.totalVolume, 4) : null,
            }
          : null;
      })
      .filter(Boolean) as Array<{ date: string; shortVolume: number; shortExemptVolume: number; totalVolume: number; shortRatio: number | null }>;
    const sv = series.reduce((a, s) => a + s.shortVolume, 0);
    const tv = series.reduce((a, s) => a + s.totalVolume, 0);
    return {
      symbol: sym,
      daysWithData: series.length,
      aggregate: { shortVolume: sv, totalVolume: tv, shortRatio: tv ? round(sv / tv, 4) : null },
      latest: series[0] ?? null,
      series,
    };
  });
  return {
    dataSource,
    mode: "symbols",
    market,
    tradingDays: found.map((d) => d.date),
    filesProbed: probed,
    results,
    note: `${found.length} most recent FINRA trading-day files on/before ${end} (newest first; weekends/holidays/unpublished days skipped). ${caveat}`,
  };
}

// ─────────────────────── FINRA Query API (shared) ───────────────────────

const FINRA_API = "https://api.finra.org/data/group";
const FINRA_TOKEN_URL = "https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token?grant_type=client_credentials";
let tokenCache: { token: string; exp: number } | null = null;

async function finraToken(): Promise<string> {
  const id = process.env.FINRA_API_CLIENT_ID;
  const secret = process.env.FINRA_API_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "FINRA_API_CLIENT_ID / FINRA_API_CLIENT_SECRET not set — create free FINRA API credentials (FINRA API Console, 'public' datasets) and add them in Vercel to enable finra_trace_aggregates"
    );
  }
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  const res = await politeFetch(FINRA_TOKEN_URL, {
    method: "POST",
    retries: 1,
    timeoutMs: 10000,
    headers: { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body?.access_token) {
    throw new Error(`FINRA OAuth token request failed (HTTP ${res.status}${body?.error ? `, ${body.error}` : ""}) — check FINRA_API_CLIENT_ID/SECRET`);
  }
  const ttlSec = Number(body.expires_in) || 1800;
  tokenCache = { token: body.access_token, exp: Date.now() + Math.max(60, ttlSec - 60) * 1000 };
  return tokenCache.token;
}

async function finraQuery(group: string, dataset: string, body: any, auth: boolean): Promise<any[]> {
  const url = `${FINRA_API}/${group}/name/${dataset}`;
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (auth) headers.Authorization = `Bearer ${await finraToken()}`;
  const res = await politeFetch(url, { method: "POST", headers, body: JSON.stringify(body), retries: 2, timeoutMs: 15000 });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text)?.message ?? msg; } catch { /* keep raw */ }
    throw new Error(`FINRA API HTTP ${res.status} for ${group}/${dataset}: ${redactUrl(String(msg))}`);
  }
  if (!text.trim()) return []; // FINRA returns 204/empty when no rows match
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

// ─────────────────────── Consolidated short interest ───────────────────────

const SI_FIELDS = [
  "settlementDate", "symbolCode", "issueName", "marketClassCode",
  "currentShortPositionQuantity", "previousShortPositionQuantity",
  "changePreviousNumber", "changePercent", "averageDailyVolumeQuantity",
  "daysToCoverQuantity", "stockSplitFlag", "revisionFlag",
];
const siCache = new Map<string, { at: number; rows: any[] }>();

function shapeSI(r: any) {
  return {
    settlementDate: r.settlementDate ?? null,
    symbol: r.symbolCode ?? null,
    issueName: r.issueName ?? null,
    market: r.marketClassCode ?? null,
    shortInterest: num(r.currentShortPositionQuantity),
    previousShortInterest: num(r.previousShortPositionQuantity),
    change: num(r.changePreviousNumber),
    changePct: num(r.changePercent),
    avgDailyVolume: num(r.averageDailyVolumeQuantity),
    daysToCover: num(r.daysToCoverQuantity),
    ...(r.stockSplitFlag ? { splitFlag: r.stockSplitFlag } : {}),
    ...(r.revisionFlag ? { revisionFlag: r.revisionFlag } : {}),
  };
}

async function siForSymbol(sym: string, start: string, end: string): Promise<any[]> {
  const key = `${sym}:${start}:${end}`;
  const hit = siCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.rows;
  const rows = await finraQuery("otcMarket", "consolidatedShortInterest", {
    limit: 200,
    fields: SI_FIELDS,
    compareFilters: [{ compareType: "equal", fieldName: "symbolCode", fieldValue: sym }],
    dateRangeFilters: [{ fieldName: "settlementDate", startDate: start, endDate: end }],
  }, false);
  siCache.set(key, { at: Date.now(), rows });
  if (siCache.size > 200) siCache.delete(siCache.keys().next().value as string);
  return rows;
}

async function latestSettlementDate(): Promise<string> {
  // Sentinel lookup: AAPL is reported every cycle.
  const end = todayET();
  const rows = await siForSymbol("AAPL", addDays(end, -60), end);
  const dates = rows.map((r) => r.settlementDate).filter(Boolean).sort();
  if (!dates.length) throw new Error("Could not determine latest FINRA short-interest settlement date");
  return dates[dates.length - 1];
}

const SI_SORTS: Record<string, string> = {
  daysToCover: "daysToCoverQuantity",
  shortInterest: "currentShortPositionQuantity",
  changePct: "changePercent",
  change: "changePreviousNumber",
};

async function finraShortInterest(args: any) {
  const dataSource = "FINRA Query API — otcMarket/consolidatedShortInterest (public, no key; api.finra.org)";
  const caveat =
    "Short interest = open short positions reported by broker-dealers as of the settlement date (twice monthly: mid-month and month-end; " +
    "published ~7 business days later). Covers exchange-listed AND OTC securities. daysToCover = shortInterest / avgDailyVolume (FINRA-computed). " +
    "Use finra_short_volume for daily short-sale FLOW and sec_fails_to_deliver for settlement fails.";
  const symbols = normSymbols(args?.symbols ?? args?.symbol, 10);

  if (!symbols.length) {
    const sortBy = String(args?.sortBy ?? "daysToCover");
    const sortField = SI_SORTS[sortBy];
    if (!sortField) throw new Error(`sortBy must be one of ${Object.keys(SI_SORTS).join(", ")}`);
    const settle = parseDateArg(args?.settlementDate) ?? (await latestSettlementDate());
    const minAvgVolume = Number(args?.minAvgVolume ?? 500_000);
    const top = clampInt(args?.top, 20, 1, 50);
    const minPrevious = Number(args?.minPreviousShortInterest ?? 1_000_000);
    const rows = await finraQuery("otcMarket", "consolidatedShortInterest", {
      limit: top,
      fields: SI_FIELDS,
      sortFields: [`-${sortField}`],
      compareFilters: [
        { compareType: "equal", fieldName: "settlementDate", fieldValue: settle },
        { compareType: "greater", fieldName: "averageDailyVolumeQuantity", fieldValue: minAvgVolume },
        // %-change rankings are otherwise dominated by names going from ~0 to small positions.
        ...(sortBy.startsWith("change")
          ? [{ compareType: "greater", fieldName: "previousShortPositionQuantity", fieldValue: minPrevious }]
          : []),
      ],
    }, false);
    return {
      dataSource,
      mode: "rank",
      settlementDate: settle,
      sortBy,
      minAvgVolume,
      top: rows.map(shapeSI),
      note: `Top ${top} by ${sortBy} on settlement date ${settle} among issues with avg daily volume > ${minAvgVolume.toLocaleString()}. ` +
        (rows.length ? "" : "No rows — that date may not be a FINRA settlement date (use mid-month/month-end dates). ") + caveat,
    };
  }

  const months = clampInt(args?.months, 3, 1, 24);
  const end = todayET();
  const start = addDays(end, -Math.round(months * 30.5));
  const results = await Promise.all(
    symbols.map(async (sym) => {
      const rows = (await siForSymbol(sym, start, end)).map(shapeSI)
        .sort((a, b) => String(b.settlementDate).localeCompare(String(a.settlementDate)));
      return { symbol: sym, issueName: rows[0]?.issueName ?? null, latest: rows[0] ?? null, history: rows };
    })
  );
  return {
    dataSource,
    mode: "symbols",
    window: { start, end },
    results,
    note: `Settlement-date history (newest first) for the last ~${months} month(s). Empty history = symbol not found (check ticker) or no reports in window. ${caveat}`,
  };
}

// ─────────────────────── TRACE market aggregates ───────────────────────

const TRACE_DATASETS: Record<string, { partition: string; desc: string }> = {
  corporateMarketBreadth: { partition: "tradeReportDate", desc: "Corporate bonds: daily advances/declines/unchanged, 52-wk highs/lows, total trades & volume by product category (IG, HY, convertibles)" },
  corporateMarketSentiment: { partition: "tradeReportDate", desc: "Corporate bonds: daily transactions/trades/volume by trade type (customer buy/sell, interdealer) and product category" },
  agencyMarketBreadth: { partition: "tradeReportDate", desc: "Agency debt: daily breadth (advances/declines, volume)" },
  agencyMarketSentiment: { partition: "tradeReportDate", desc: "Agency debt: daily volume by trade type" },
  corporate144AMarketBreadth: { partition: "tradeReportDate", desc: "Rule 144A corporate bonds: daily breadth" },
  corporate144AMarketSentiment: { partition: "tradeReportDate", desc: "Rule 144A corporate bonds: daily volume by trade type" },
  treasuryDailyAggregates: { partition: "tradeDate", desc: "Treasuries: daily ATS-interdealer and dealer-customer counts/$ volume by product & maturity bucket, VWAP" },
  treasuryMonthlyAggregates: { partition: "beginningOfTheMonthDate", desc: "Treasuries: monthly ATS-interdealer and dealer-customer counts/$ volume by product & maturity bucket" },
};

async function finraTraceAggregates(args: any) {
  const dataset = String(args?.dataset ?? "corporateMarketBreadth");
  const meta = TRACE_DATASETS[dataset];
  if (!meta) throw new Error(`dataset must be one of ${Object.keys(TRACE_DATASETS).join(", ")}`);
  const end = parseDateArg(args?.endDate) ?? todayET();
  const monthly = dataset === "treasuryMonthlyAggregates";
  const lookback = clampInt(args?.days, monthly ? 180 : 10, 1, monthly ? 1100 : 120);
  const start = parseDateArg(args?.startDate) ?? addDays(end, -lookback);
  const limit = clampInt(args?.limit, 60, 1, 500);
  const filters: any[] = [];
  if (args?.productCategory) filters.push({ compareType: "equal", fieldName: "productCategory", fieldValue: String(args.productCategory) });
  const rows = await finraQuery("fixedIncomeMarket", dataset, {
    limit: 5000,
    ...(filters.length ? { compareFilters: filters } : {}),
    dateRangeFilters: [{ fieldName: meta.partition, startDate: start, endDate: end }],
  }, true);
  rows.sort((a, b) => String(b[meta.partition]).localeCompare(String(a[meta.partition])));
  const dates = Array.from(new Set(rows.map((r) => r[meta.partition]))).slice(0, 3);
  return {
    dataSource: `FINRA Query API — fixedIncomeMarket/${dataset} (TRACE; OAuth client credentials)`,
    dataset,
    description: meta.desc,
    window: { start, end },
    totalRows: rows.length,
    latestDates: dates,
    rows: rows.slice(0, limit),
    ...(rows.length === 0 ? { sampleRaw: null } : {}),
    note: `Newest first, capped at ${limit} rows (widen with limit or narrow with productCategory). Volumes: corporate/agency in par value $; Treasury volumes in $ (FINRA publishes Treasury aggregates with a lag and with some cells suppressed).`,
  };
}

// ─────────────────────────── tool defs ───────────────────────────

export const FINRA_TOOL_DEFS = [
  {
    name: "finra_short_volume",
    description:
      "FINRA Reg SHO DAILY short-sale volume (no key). Two modes. (1) symbols mode — pass `symbols` (1-10 tickers): returns, per symbol, " +
      "daily shortVolume / shortExemptVolume / totalVolume / shortRatio for the last `days` trading days (default 10, max 30; newest first) plus a window aggregate. " +
      "(2) rank mode — omit `symbols`: ranks the `top` (default 20) highest short-ratio names on the latest (or given) trading day among names with ≥ `minVolume` FINRA-reported shares (default 1,000,000). " +
      "IMPORTANT caveats: covers only off-exchange volume reported to FINRA facilities (TRFs + ORF), not exchange prints, so totalVolume ≈ 35-50% of tape volume; " +
      "market-maker hedging makes ~45-55% short ratios normal — look for CHANGES vs a name's own history rather than the absolute level. " +
      "This is short-sale FLOW; for outstanding short positions use finra_short_interest; for settlement fails use sec_fails_to_deliver. " +
      "Files publish ~6pm ET each trading day; weekends/holidays are skipped automatically.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Tickers, e.g. ['AAPL','GME']. Omit for rank mode." },
        days: { type: "integer", minimum: 1, maximum: 30, description: "Trading days of history in symbols mode (default 10)." },
        date: { type: "string", description: "Anchor date YYYY-MM-DD (walks back from here). Default today ET." },
        market: { type: "string", enum: Object.keys(REGSHO_MARKETS), description: "FINRA facility file. CNMS = consolidated (default)." },
        top: { type: "integer", minimum: 1, maximum: 50, description: "Rank mode: number of names (default 20)." },
        minVolume: { type: "number", description: "Rank mode: minimum FINRA-reported total volume (default 1,000,000)." },
      },
    },
    handler: finraShortVolume,
  },
  {
    name: "finra_short_interest",
    description:
      "FINRA consolidated SHORT INTEREST (no key; public FINRA Query API): outstanding short positions as of each twice-monthly settlement date (mid-month and month-end), for exchange-listed and OTC securities. " +
      "symbols mode — pass `symbols` (1-10): per symbol, history over the last `months` (default 3, max 24) with shortInterest (shares), previousShortInterest, change, changePct, avgDailyVolume and daysToCover, newest first. " +
      "rank mode — omit `symbols`: top `top` (default 20, max 50) issues on the latest (or given `settlementDate`) settlement date sorted by `sortBy` (daysToCover | shortInterest | changePct | change), filtered to avgDailyVolume > `minAvgVolume` (default 500,000; change/changePct sorts also require prior short interest > `minPreviousShortInterest`, default 1M shares). " +
      "Data is published ~7 business days after each settlement date, so the latest point is 1-3 weeks old. Short interest is NOT expressed as % of float here (FINRA does not publish float) — combine with shares outstanding from another tool if needed. " +
      "Pair with finra_short_volume (daily flow) and sec_fails_to_deliver (settlement fails) for a squeeze / crowding read.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Tickers. Omit for rank mode." },
        months: { type: "integer", minimum: 1, maximum: 24, description: "Symbols mode lookback in months (default 3 ≈ 6 settlement dates)." },
        settlementDate: { type: "string", description: "Rank mode: settlement date YYYY-MM-DD (default latest available)." },
        sortBy: { type: "string", enum: Object.keys(SI_SORTS), description: "Rank mode sort (default daysToCover)." },
        minAvgVolume: { type: "number", description: "Rank mode: minimum average daily volume (default 500,000)." },
        minPreviousShortInterest: { type: "number", description: "Rank mode with sortBy change/changePct: minimum prior short interest in shares (default 1,000,000) to suppress tiny-base noise." },
        top: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    handler: finraShortInterest,
  },
  {
    name: "finra_trace_aggregates",
    description:
      "FINRA TRACE fixed-income MARKET AGGREGATES (requires FINRA_API_CLIENT_ID/FINRA_API_CLIENT_SECRET — free FINRA API credentials). " +
      "Datasets: corporateMarketBreadth (default; daily IG/HY/convertible advances, declines, unchanged, 52-wk highs/lows, trades, par volume), corporateMarketSentiment (volume by customer-buy/customer-sell/interdealer), " +
      "agencyMarketBreadth / agencyMarketSentiment, corporate144AMarketBreadth / corporate144AMarketSentiment, treasuryDailyAggregates (ATS-interdealer vs dealer-customer $ volume by maturity bucket, VWAP), treasuryMonthlyAggregates. " +
      "Use for bond-market breadth, liquidity and risk-appetite context (e.g. HY advances vs declines, customer selling pressure). Not security-level trade data. " +
      "Args: dataset, days lookback (default 10 calendar days; monthly 180) or startDate/endDate, optional productCategory filter, limit rows (default 60).",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", enum: Object.keys(TRACE_DATASETS) },
        days: { type: "integer", minimum: 1, maximum: 1100, description: "Calendar-day lookback from endDate." },
        startDate: { type: "string" },
        endDate: { type: "string" },
        productCategory: { type: "string", description: "Exact productCategory value to filter on (e.g. as returned in a prior call)." },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    handler: finraTraceAggregates,
  },
];
