/**
 * VistaCharts — price history + return analytics for the console chart panel.
 *
 * Source is EODHD, and only EODHD. The obvious keyless fallback (Stooq CSV)
 * was probed on 2026-08-30 and is now gated behind a JavaScript
 * proof-of-work browser challenge — it answers a server-side GET with an
 * HTML interstitial, not CSV, so it cannot back a serverless function. Do
 * not re-add it without re-probing.
 *
 * Returns are computed off `adjusted_close`, which is split AND dividend
 * adjusted, so every number here is a TOTAL return. That matters for the
 * comparison this panel exists to make: charting price return against a
 * dividend-paying benchmark understates the benchmark by its entire yield,
 * which over a 10Y window on something like SPY is not a rounding error.
 *
 * CREDENTIAL SAFETY: EODHD auth rides as a query param, so all fetching
 * goes through lib/eodhd/client -> lib/data/http, whose redactUrl() scrubs
 * token values from every error path. Never fetch() EODHD directly.
 */

import { eodhdFetch, normalizeSymbol, type EodhdBar } from "../eodhd/client";

export type PeriodKey = "3M" | "YTD" | "1Y" | "3Y" | "5Y" | "10Y";

export const PERIODS: PeriodKey[] = ["3M", "YTD", "1Y", "3Y", "5Y", "10Y"];

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  "3M": "3 Months",
  YTD: "Year to Date",
  "1Y": "1 Year",
  "3Y": "3 Years",
  "5Y": "5 Years",
  "10Y": "10 Years",
};

export interface Bar {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface SeriesMetrics {
  totalReturn: number | null;
  annualized: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
  best: { date: string; value: number } | null;
  worst: { date: string; value: number } | null;
}

export interface Series extends SeriesMetrics {
  symbol: string;
  role: "ticker" | "benchmark";
  startPrice: number;
  endPrice: number;
  /** Cumulative return from the baseline, as a decimal (0.1234 = +12.34%). */
  points: number[];
}

export interface ChartPayload {
  period: PeriodKey;
  periodLabel: string;
  from: string;
  to: string;
  provider: "eodhd";
  returnBasis: "total";
  tradingDays: number;
  dates: string[];
  series: Series[];
  relative: {
    excessReturn: number | null;
    beta: number | null;
    correlation: number | null;
    trackingError: number | null;
  } | null;
  notes: string[];
}

/* ------------------------------------------------------------------ dates */

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Window start for a period key, relative to `today`. */
export function periodStart(period: PeriodKey, today: Date): Date {
  const d = new Date(today.getTime());
  switch (period) {
    case "3M":
      d.setUTCMonth(d.getUTCMonth() - 3);
      return d;
    case "YTD":
      return new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    case "1Y":
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      return d;
    case "3Y":
      d.setUTCFullYear(d.getUTCFullYear() - 3);
      return d;
    case "5Y":
      d.setUTCFullYear(d.getUTCFullYear() - 5);
      return d;
    case "10Y":
      d.setUTCFullYear(d.getUTCFullYear() - 10);
      return d;
  }
}

/* -------------------------------------------------------------- providers */

async function fetchEodhd(symbol: string, from: string, to: string): Promise<Bar[]> {
  const bars = await eodhdFetch<EodhdBar[]>(`eod/${encodeURIComponent(normalizeSymbol(symbol))}`, {
    from,
    to,
    period: "d",
    order: "a",
  });
  if (!Array.isArray(bars)) throw new Error(`EODHD returned no series for ${symbol}`);
  const out: Bar[] = [];
  for (const b of bars) {
    // adjusted_close carries dividends AND splits; close carries splits only.
    const px = typeof b.adjusted_close === "number" ? b.adjusted_close : b.close;
    if (b.date && typeof px === "number" && Number.isFinite(px) && px > 0) {
      out.push({ date: b.date.slice(0, 10), close: px });
    }
  }
  return out;
}

/**
 * Fetch every leg from EODHD. A single failed leg fails the whole request:
 * a chart that silently drops the benchmark is worse than an error, because
 * the remaining line still looks like a complete answer.
 */
async function fetchAll(symbols: string[], from: string, to: string): Promise<Bar[][]> {
  if (!process.env.EODHD_API_TOKEN) {
    throw new Error(
      "EODHD_API_TOKEN is not configured in this deployment, so price history is unavailable. " +
        "Set it in the Vercel project environment and redeploy."
    );
  }
  return Promise.all(symbols.map((s) => fetchEodhd(s, from, to)));
}

/* ---------------------------------------------------------------- analytics */

function alignOnCommonDates(seriesBars: Bar[][]): { dates: string[]; closes: number[][] } {
  const maps = seriesBars.map((bars) => {
    const m = new Map<string, number>();
    for (const b of bars) m.set(b.date, b.close);
    return m;
  });
  const dates = [...maps[0].keys()]
    .filter((d) => maps.every((m) => m.has(d)))
    .sort();
  return { dates, closes: maps.map((m) => dates.map((d) => m.get(d) as number)) };
}

function metricsFor(closes: number[], dates: string[]): SeriesMetrics {
  if (closes.length < 2) {
    return {
      totalReturn: null,
      annualized: null,
      volatility: null,
      maxDrawdown: null,
      best: null,
      worst: null,
    };
  }
  const base = closes[0];
  const last = closes[closes.length - 1];
  const totalReturn = last / base - 1;

  const spanDays =
    (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86_400_000;
  // A CAGR over a sub-annual window annualises noise into a headline number.
  const annualized =
    spanDays > 400 ? Math.pow(last / base, 365.25 / spanDays) - 1 : null;

  const rets: number[] = [];
  let peak = closes[0];
  let maxDrawdown = 0;
  let best: { date: string; value: number } | null = null;
  let worst: { date: string; value: number } | null = null;

  for (let i = 1; i < closes.length; i++) {
    const r = closes[i] / closes[i - 1] - 1;
    rets.push(r);
    if (!best || r > best.value) best = { date: dates[i], value: r };
    if (!worst || r < worst.value) worst = { date: dates[i], value: r };
    if (closes[i] > peak) peak = closes[i];
    const dd = closes[i] / peak - 1;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const volatility = Math.sqrt(variance) * Math.sqrt(252);

  return { totalReturn, annualized, volatility, maxDrawdown, best, worst };
}

function relativeStats(a: number[], b: number[]) {
  if (a.length < 3 || a.length !== b.length) return null;
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < a.length; i++) {
    ra.push(a[i] / a[i - 1] - 1);
    rb.push(b[i] / b[i - 1] - 1);
  }
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let cov = 0;
  let va = 0;
  let vb = 0;
  let te = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  const n = ra.length - 1 || 1;
  cov /= n;
  va /= n;
  vb /= n;
  const mdiff = ma - mb;
  for (let i = 0; i < ra.length; i++) te += (ra[i] - rb[i] - mdiff) ** 2;
  te = Math.sqrt(te / n) * Math.sqrt(252);

  return {
    excessReturn: a[a.length - 1] / a[0] - b[b.length - 1] / b[0],
    beta: vb > 0 ? cov / vb : null,
    correlation: va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null,
    trackingError: Number.isFinite(te) ? te : null,
  };
}

/** Stride a series down to at most `max` points, always keeping first + last. */
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(arr[Math.round(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

/* ------------------------------------------------------------------- entry */

export async function buildChart(opts: {
  ticker: string;
  benchmark?: string | null;
  period: PeriodKey;
  today?: Date;
  maxPoints?: number;
}): Promise<ChartPayload> {
  const today = opts.today ?? new Date();
  const maxPoints = opts.maxPoints ?? 420;
  const start = periodStart(opts.period, today);

  // Pull a buffer before the window so the baseline is the last close BEFORE
  // the period opens (a YTD chart should measure from 31 Dec, not 2 Jan).
  const buffered = new Date(start.getTime());
  buffered.setUTCDate(buffered.getUTCDate() - 14);

  const symbols = [opts.ticker];
  const bench = (opts.benchmark ?? "").trim();
  if (bench && bench.toUpperCase() !== opts.ticker.trim().toUpperCase()) symbols.push(bench);

  const bars = await fetchAll(symbols, iso(buffered), iso(today));
  const { dates, closes } = alignOnCommonDates(bars);
  if (dates.length < 2) {
    throw new Error(
      symbols.length > 1
        ? `No overlapping trading history for ${symbols.join(" and ")} in this window.`
        : `No price history for ${symbols[0]} in this window.`
    );
  }

  // Baseline: last observation strictly before the window opens, else the first in it.
  const startIso = iso(start);
  let baseIdx = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < startIso) baseIdx = i;
    else break;
  }
  if (dates[baseIdx] >= startIso && baseIdx > 0) baseIdx -= 1;

  const winDates = dates.slice(baseIdx);
  const winCloses = closes.map((c) => c.slice(baseIdx));

  const built: Series[] = winCloses.map((c, i) => ({
    symbol: symbols[i].trim().toUpperCase(),
    role: i === 0 ? "ticker" : "benchmark",
    startPrice: c[0],
    endPrice: c[c.length - 1],
    points: downsample(
      c.map((v) => v / c[0] - 1),
      maxPoints
    ),
    ...metricsFor(c, winDates),
  }));

  return {
    period: opts.period,
    periodLabel: PERIOD_LABEL[opts.period],
    from: winDates[0],
    to: winDates[winDates.length - 1],
    provider: "eodhd",
    returnBasis: "total",
    tradingDays: winDates.length,
    dates: downsample(winDates, maxPoints),
    series: built,
    relative: winCloses.length > 1 ? relativeStats(winCloses[0], winCloses[1]) : null,
    notes: [],
  };
}
