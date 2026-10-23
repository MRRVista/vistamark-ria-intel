/**
 * Cboe volatility index daily history, keyless.
 *
 * Endpoint (verified live 2026-10-21):
 *   https://cdn.cboe.com/api/global/us_indices/daily_prices/<SYMBOL>_History.csv
 *   VIX, VIX9D, VIX3M, VIX6M: "DATE,OPEN,HIGH,LOW,CLOSE" (MM/DD/YYYY)
 *   VVIX, SKEW:              "DATE,<SYMBOL>" (close only)
 *   VIX1D / VIX1Y / OVX / GVZ / VXN redirect (307) and are NOT served here.
 * Files update after each US session; VIX itself sometimes lags the term-
 * structure siblings by a day, so term-structure uses each series' latest
 * close plus a same-date comparison when one exists.
 */
import { cached, fetchText, HOUR, clampInt, normDate, percentileRank, round } from "./common";

const BASE = "https://cdn.cboe.com/api/global/us_indices/daily_prices";
export const CBOE_SYMBOLS = ["VIX", "VIX9D", "VIX3M", "VIX6M", "VVIX", "SKEW"] as const;
type Sym = (typeof CBOE_SYMBOLS)[number];

interface Bar {
  date: string;
  close: number;
}

function loadSeries(sym: Sym): Promise<Bar[]> {
  return cached(`cboe:${sym}`, 6 * HOUR, async () => {
    const text = await fetchText(`${BASE}/${sym}_History.csv`);
    const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
    const header = (lines[0] ?? "").split(",").map((h) => h.trim().toUpperCase());
    let ci = header.indexOf("CLOSE");
    if (ci < 0) ci = header.indexOf(sym);
    if (ci < 0) ci = header.length - 1;
    const out: Bar[] = [];
    for (const line of lines.slice(1)) {
      const parts = line.split(",");
      const d = normDate(parts[0]?.trim());
      const c = Number(parts[ci]);
      if (d && Number.isFinite(c) && c > 0) out.push({ date: d, close: c });
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!out.length) {
      const err = new Error(`Cboe ${sym}: no rows parsed`) as Error & { sampleRaw?: string };
      err.sampleRaw = text.slice(0, 300);
      throw err;
    }
    return out;
  });
}

export interface CboeVolArgs {
  symbols?: string[];
  days?: number;
  lookbackYears?: number;
}

function changeOver(bars: Bar[], n: number): number | null {
  if (bars.length <= n) return null;
  return round(bars[bars.length - 1]!.close - bars[bars.length - 1 - n]!.close, 2);
}

export async function cboeVolHistory(args: CboeVolArgs) {
  const req = (args.symbols?.length ? args.symbols : [...CBOE_SYMBOLS]).map((s) => s.toUpperCase().replace(/^\^/, ""));
  const bad = req.filter((s) => !(CBOE_SYMBOLS as readonly string[]).includes(s));
  if (bad.length) throw new Error(`Unsupported symbol(s) ${bad.join(", ")}. Supported: ${CBOE_SYMBOLS.join(", ")}`);
  const syms = Array.from(new Set<Sym>([...(req as Sym[]), "VIX", "VIX9D", "VIX3M", "VIX6M"]));
  const days = clampInt(args.days, 10, 1, 260);
  const lbYears = args.lookbackYears != null ? clampInt(args.lookbackYears, 0, 1, 40) : null;

  const settled = await Promise.allSettled(syms.map((s) => loadSeries(s)));
  const data = new Map<Sym, Bar[]>();
  const errors: Record<string, string> = {};
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") data.set(syms[i]!, r.value);
    else errors[syms[i]!] = String((r.reason as Error)?.message ?? r.reason);
  });
  if (!data.size) throw new Error(`Cboe history unavailable: ${JSON.stringify(errors)}`);

  const summary: Record<string, unknown> = {};
  for (const s of req as Sym[]) {
    const bars = data.get(s);
    if (!bars) continue;
    const last = bars[bars.length - 1]!;
    const hist = lbYears
      ? bars.filter((b) => b.date >= `${Number(last.date.slice(0, 4)) - lbYears}${last.date.slice(4)}`)
      : bars;
    const closes = hist.map((b) => b.close);
    const yr = bars.filter((b) => b.date >= `${Number(last.date.slice(0, 4)) - 1}${last.date.slice(4)}`).map((b) => b.close);
    summary[s] = {
      date: last.date,
      close: last.close,
      chg1d: changeOver(bars, 1),
      chg5d: changeOver(bars, 5),
      chg21d: changeOver(bars, 21),
      percentile: percentileRank(closes, last.close),
      percentileWindow: `${hist[0]!.date} to ${last.date}`,
      oneYearRange: yr.length ? { min: round(Math.min(...yr), 2), max: round(Math.max(...yr), 2), avg: round(yr.reduce((a, b) => a + b, 0) / yr.length, 2) } : null,
      allTimeHigh: round(Math.max(...bars.map((b) => b.close)), 2),
    };
  }

  // Term structure: latest of each, plus the latest date common to all four.
  const ts = (["VIX9D", "VIX", "VIX3M", "VIX6M"] as Sym[]).filter((s) => data.has(s));
  const latestOf = (s: Sym) => data.get(s)![data.get(s)!.length - 1]!;
  const maps = new Map(ts.map((s) => [s, new Map(data.get(s)!.map((b) => [b.date, b.close]))]));
  let commonDate: string | null = null;
  if (data.has("VIX")) {
    const vix = data.get("VIX")!;
    for (let i = vix.length - 1; i >= Math.max(0, vix.length - 10); i--) {
      const d = vix[i]!.date;
      if (ts.every((s) => maps.get(s)!.has(d))) {
        commonDate = d;
        break;
      }
    }
  }
  const at = (s: Sym) => (commonDate ? maps.get(s)?.get(commonDate) ?? null : null);
  const v9 = at("VIX9D");
  const v = at("VIX");
  const v3 = at("VIX3M");
  const v6 = at("VIX6M");
  const ratio = (a: number | null, b: number | null) => (a != null && b != null && b !== 0 ? round(a / b, 3) : null);
  const r_3m = ratio(v, v3);
  const state =
    r_3m == null ? null : r_3m >= 1.0 ? "backwardation" : r_3m >= 0.95 ? "flat" : "contango";

  // Historical percentile of VIX/VIX3M (stress gauge)
  let ratioPct: number | null = null;
  if (r_3m != null && data.has("VIX") && data.has("VIX3M")) {
    const m3 = maps.get("VIX3M")!;
    const ratios = data.get("VIX")!.filter((b) => m3.has(b.date)).map((b) => b.close / m3.get(b.date)!);
    ratioPct = percentileRank(ratios, r_3m);
  }

  // Recent table on VIX dates
  const base = data.get("VIX") ?? data.get(ts[0] ?? (req[0] as Sym))!;
  const allMaps = new Map([...data.entries()].map(([s, b]) => [s, new Map(b.map((x) => [x.date, x.close]))]));
  const dates = Array.from(new Set([...base.slice(-days).map((b) => b.date), ...(req as Sym[]).flatMap((s) => (data.get(s) ?? []).slice(-days).map((b) => b.date))]))
    .sort()
    .slice(-days);
  const recent = dates.reverse().map((d) => {
    const o: Record<string, string | number | null> = { date: d };
    for (const s of req as Sym[]) o[s] = allMaps.get(s)?.get(d) ?? null;
    const a = allMaps.get("VIX")?.get(d);
    const b = allMaps.get("VIX3M")?.get(d);
    o["VIX/VIX3M"] = a != null && b != null ? round(a / b, 3) : null;
    return o;
  });

  return {
    dataSource: "Cboe Global Indices — daily index history CSVs (cdn.cboe.com)",
    summary,
    termStructure: {
      asOf: commonDate,
      latestCloses: Object.fromEntries(ts.map((s) => [s, { date: latestOf(s).date, close: latestOf(s).close }])),
      sameDate: commonDate ? { VIX9D: v9, VIX: v, VIX3M: v3, VIX6M: v6 } : null,
      ratios: {
        "VIX9D/VIX": ratio(v9, v),
        "VIX/VIX3M": r_3m,
        "VIX3M/VIX6M": ratio(v3, v6),
        "VIX/VIX6M": ratio(v, v6),
      },
      state,
      vixToVix3mPercentile: ratioPct,
      shortEndInverted: v9 != null && v != null ? v9 > v : null,
    },
    recent,
    errors: Object.keys(errors).length ? errors : undefined,
    note:
      "Index levels in vol points (annualized implied vol %, e.g. 17.3). VIX = 30-day S&P 500 implied vol; VIX9D 9-day; VIX3M 3-month; VIX6M 6-month; VVIX = vol of VIX; SKEW = tail-risk index (100 = normal, >140 = elevated crash-hedging demand). Term structure: VIX/VIX3M < 0.95 = contango (normal, calm); 0.95–1.0 flat; ≥ 1.0 backwardation (stress — near-term fear above longer-term). Ratios use the latest date on which all four tenors printed (VIX can post a day behind its siblings). percentile = share of closes ≤ latest over the full history (or lookbackYears). For the FRED VIXCLS series use fred tools; this tool adds the term structure, VVIX and SKEW.",
  };
}
