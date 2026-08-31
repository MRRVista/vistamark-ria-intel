/**
 * Shared price-history loader and return analytics.
 *
 * SINGLE SOURCE OF TRUTH, DELIBERATELY. Both the chart panel and the
 * portfolio engine compute returns, and if each kept its own loader they
 * would drift — a tool that answers "what did this return" two different
 * ways depending on which screen you asked from is worse than one that
 * cannot answer at all. Every caller aligns on common trading dates here.
 *
 * All prices are `adjusted_close`: split AND dividend adjusted, so every
 * figure downstream is a TOTAL return with dividends reinvested in the
 * security that paid them.
 *
 * CREDENTIAL SAFETY: EODHD auth rides as a query param, so fetching goes
 * through lib/eodhd/client -> lib/data/http, whose redactUrl() scrubs token
 * values from error paths. Never fetch() EODHD directly.
 */

import { eodhdFetch, normalizeSymbol, type EodhdBar } from "../eodhd/client";

export type PeriodKey = "3M" | "YTD" | "1Y" | "3Y" | "5Y" | "10Y" | "MAX";
export const PERIODS: PeriodKey[] = ["3M", "YTD", "1Y", "3Y", "5Y", "10Y", "MAX"];
export const PERIOD_LABEL: Record<PeriodKey, string> = {
  "3M": "3 Months", YTD: "Year to Date", "1Y": "1 Year", "3Y": "3 Years",
  "5Y": "5 Years", "10Y": "10 Years", MAX: "Max Available",
};

export interface Bar { date: string; close: number }

export function iso(d: Date): string { return d.toISOString().slice(0, 10); }

export function periodStart(period: PeriodKey, today: Date): Date {
  const d = new Date(today.getTime());
  switch (period) {
    case "3M": d.setUTCMonth(d.getUTCMonth() - 3); return d;
    case "YTD": return new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    case "1Y": d.setUTCFullYear(d.getUTCFullYear() - 1); return d;
    case "3Y": d.setUTCFullYear(d.getUTCFullYear() - 3); return d;
    case "5Y": d.setUTCFullYear(d.getUTCFullYear() - 5); return d;
    case "10Y": d.setUTCFullYear(d.getUTCFullYear() - 10); return d;
    case "MAX": return new Date(Date.UTC(1970, 0, 1));
  }
}

async function fetchOne(symbol: string, from: string, to: string): Promise<Bar[]> {
  const bars = await eodhdFetch<EodhdBar[]>(
    `eod/${encodeURIComponent(normalizeSymbol(symbol))}`,
    { from, to, period: "d", order: "a" }
  );
  if (!Array.isArray(bars)) throw new Error(`No price series returned for ${symbol}`);
  const out: Bar[] = [];
  for (const b of bars) {
    const px = typeof b.adjusted_close === "number" ? b.adjusted_close : b.close;
    if (b.date && typeof px === "number" && Number.isFinite(px) && px > 0) {
      out.push({ date: b.date.slice(0, 10), close: px });
    }
  }
  return out;
}

/**
 * Load every symbol. One failed leg fails the request: a portfolio that
 * silently drops a holding still returns a plausible-looking number, which
 * is the most dangerous kind of wrong.
 */
export async function loadBars(symbols: string[], from: string, to: string): Promise<Bar[][]> {
  if (!process.env.EODHD_API_TOKEN) {
    throw new Error(
      "EODHD_API_TOKEN is not configured in this deployment, so price history is unavailable."
    );
  }
  const seen = new Set<string>();
  for (const s of symbols) {
    const k = s.trim().toUpperCase();
    if (seen.has(k)) throw new Error(`Duplicate symbol in request: ${k}`);
    seen.add(k);
  }
  return Promise.all(symbols.map((s) => fetchOne(s, from, to)));
}

/** Intersect on dates every series shares, so comparisons span equal sessions. */
export function alignOnCommonDates(seriesBars: Bar[][]): { dates: string[]; closes: number[][] } {
  const maps = seriesBars.map((bars) => {
    const m = new Map<string, number>();
    for (const b of bars) m.set(b.date, b.close);
    return m;
  });
  const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  return { dates, closes: maps.map((m) => dates.map((d) => m.get(d) as number)) };
}

/** Index of the baseline: last close STRICTLY BEFORE the window opens. */
export function baselineIndex(dates: string[], startIso: string): number {
  let idx = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] < startIso) idx = i;
    else break;
  }
  if (dates[idx] >= startIso && idx > 0) idx -= 1;
  return idx;
}

export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = (arr.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(arr[Math.round(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

/* ------------------------------------------------------------- statistics */

export interface RiskStats {
  totalReturn: number | null;
  annualized: number | null;
  volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  drawdownPeak: string | null;
  drawdownTrough: string | null;
  drawdownRecovered: string | null;
  best: { date: string; value: number } | null;
  worst: { date: string; value: number } | null;
  positiveDays: number | null;
}

const DAY = 86_400_000;

export function riskStats(nav: number[], dates: string[], riskFree = 0): RiskStats {
  const empty: RiskStats = {
    totalReturn: null, annualized: null, volatility: null, sharpe: null, sortino: null,
    maxDrawdown: null, drawdownPeak: null, drawdownTrough: null, drawdownRecovered: null,
    best: null, worst: null, positiveDays: null,
  };
  if (nav.length < 2) return empty;

  const totalReturn = nav[nav.length - 1] / nav[0] - 1;
  const spanDays = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / DAY;
  // Annualising a sub-annual window turns noise into a headline number.
  const annualized = spanDays > 400
    ? Math.pow(nav[nav.length - 1] / nav[0], 365.25 / spanDays) - 1
    : null;

  const rets: number[] = [];
  let peak = nav[0], peakDate = dates[0];
  let maxDrawdown = 0, ddPeak: string | null = null, ddTrough: string | null = null;
  let best: RiskStats["best"] = null, worst: RiskStats["worst"] = null, positive = 0;

  for (let i = 1; i < nav.length; i++) {
    const r = nav[i] / nav[i - 1] - 1;
    rets.push(r);
    if (r > 0) positive++;
    if (!best || r > best.value) best = { date: dates[i], value: r };
    if (!worst || r < worst.value) worst = { date: dates[i], value: r };
    if (nav[i] > peak) { peak = nav[i]; peakDate = dates[i]; }
    const dd = nav[i] / peak - 1;
    if (dd < maxDrawdown) { maxDrawdown = dd; ddPeak = peakDate; ddTrough = dates[i]; }
  }

  // Recovery: first close back at the pre-drawdown peak after the trough.
  let recovered: string | null = null;
  if (ddTrough) {
    const ti = dates.indexOf(ddTrough);
    const pi = ddPeak ? dates.indexOf(ddPeak) : 0;
    const peakVal = nav[pi];
    for (let i = ti + 1; i < nav.length; i++) {
      if (nav[i] >= peakVal) { recovered = dates[i]; break; }
    }
  }

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const volatility = Math.sqrt(variance) * Math.sqrt(252);

  const downside = rets.filter((r) => r < 0);
  const downDev = downside.length
    ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) * Math.sqrt(252)
    : null;

  const annForRatio = annualized ?? totalReturn;
  const sharpe = volatility > 0 ? (annForRatio - riskFree) / volatility : null;
  const sortino = downDev && downDev > 0 ? (annForRatio - riskFree) / downDev : null;

  return {
    totalReturn, annualized, volatility, sharpe, sortino,
    maxDrawdown, drawdownPeak: ddPeak, drawdownTrough: ddTrough, drawdownRecovered: recovered,
    best, worst, positiveDays: rets.length ? positive / rets.length : null,
  };
}

export interface RelativeStats {
  excessReturn: number | null;
  beta: number | null;
  alpha: number | null;
  correlation: number | null;
  rSquared: number | null;
  trackingError: number | null;
  informationRatio: number | null;
  upCapture: number | null;
  downCapture: number | null;
}

/** Month-end index positions, used for capture ratios. */
function monthEnds(dates: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < dates.length; i++) {
    if (i === dates.length - 1 || dates[i].slice(0, 7) !== dates[i + 1].slice(0, 7)) out.push(i);
  }
  return out;
}

export function relativeStats(
  port: number[], bench: number[], dates: string[], riskFree = 0
): RelativeStats | null {
  const none: RelativeStats = {
    excessReturn: null, beta: null, alpha: null, correlation: null, rSquared: null,
    trackingError: null, informationRatio: null, upCapture: null, downCapture: null,
  };
  if (port.length < 3 || port.length !== bench.length) return none;

  const rp: number[] = [], rb: number[] = [];
  for (let i = 1; i < port.length; i++) {
    rp.push(port[i] / port[i - 1] - 1);
    rb.push(bench[i] / bench[i - 1] - 1);
  }
  const mp = rp.reduce((a, b) => a + b, 0) / rp.length;
  const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
  let cov = 0, vp = 0, vb = 0;
  for (let i = 0; i < rp.length; i++) {
    cov += (rp[i] - mp) * (rb[i] - mb);
    vp += (rp[i] - mp) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  const n = rp.length - 1 || 1;
  cov /= n; vp /= n; vb /= n;

  const beta = vb > 0 ? cov / vb : null;
  const correlation = vp > 0 && vb > 0 ? cov / Math.sqrt(vp * vb) : null;

  const mdiff = mp - mb;
  let teSum = 0;
  for (let i = 0; i < rp.length; i++) teSum += (rp[i] - rb[i] - mdiff) ** 2;
  const trackingError = Math.sqrt(teSum / n) * Math.sqrt(252);

  const spanDays = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / DAY;
  const ann = (s: number[]) => spanDays > 400
    ? Math.pow(s[s.length - 1] / s[0], 365.25 / spanDays) - 1
    : s[s.length - 1] / s[0] - 1;
  const ap = ann(port), ab = ann(bench);

  // Jensen's alpha, on the same annualised basis as the returns above.
  const alpha = beta !== null ? ap - (riskFree + beta * (ab - riskFree)) : null;
  const excessReturn = ap - ab;
  const informationRatio = trackingError > 0 ? excessReturn / trackingError : null;

  // Capture ratios on MONTHLY returns — the convention for these, and daily
  // data makes them noise-dominated.
  const me = monthEnds(dates);
  let upP = 1, upB = 1, downP = 1, downB = 1, upN = 0, downN = 0;
  for (let k = 1; k < me.length; k++) {
    const p = port[me[k]] / port[me[k - 1]] - 1;
    const b = bench[me[k]] / bench[me[k - 1]] - 1;
    if (b > 0) { upP *= 1 + p; upB *= 1 + b; upN++; }
    else if (b < 0) { downP *= 1 + p; downB *= 1 + b; downN++; }
  }
  const geo = (x: number, k: number) => (k > 0 ? Math.pow(x, 1 / k) - 1 : null);
  const upPg = geo(upP, upN), upBg = geo(upB, upN);
  const dnPg = geo(downP, downN), dnBg = geo(downB, downN);

  return {
    excessReturn, beta, alpha, correlation,
    rSquared: correlation !== null ? correlation ** 2 : null,
    trackingError, informationRatio,
    upCapture: upPg !== null && upBg && upBg !== 0 ? upPg / upBg : null,
    downCapture: dnPg !== null && dnBg && dnBg !== 0 ? dnPg / dnBg : null,
  };
}

/** Calendar-year total returns, with partial first/last years flagged. */
export function calendarYearReturns(nav: number[], dates: string[]) {
  const byYear = new Map<string, { first: number; last: number; firstDate: string; lastDate: string }>();
  for (let i = 0; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    const e = byYear.get(y);
    if (!e) byYear.set(y, { first: nav[i], last: nav[i], firstDate: dates[i], lastDate: dates[i] });
    else { e.last = nav[i]; e.lastDate = dates[i]; }
  }
  const years = [...byYear.keys()].sort();
  const out: Array<{ year: string; return: number; partial: boolean }> = [];
  for (let k = 0; k < years.length; k++) {
    const cur = byYear.get(years[k])!;
    // Chain off the prior year's close so a full year is Dec-31 to Dec-31,
    // not first-session-of-January to Dec-31 (which drops the January gap).
    const base = k > 0 ? byYear.get(years[k - 1])!.last : cur.first;
    const partial =
      (k === 0 && cur.firstDate.slice(5) > "01-10") ||
      (k === years.length - 1 && cur.lastDate.slice(5) < "12-20");
    out.push({ year: years[k], return: cur.last / base - 1, partial });
  }
  return out;
}

/** Trailing windows measured back from the end of the series. */
export function trailingReturns(nav: number[], dates: string[]) {
  const end = dates[dates.length - 1];
  const endVal = nav[nav.length - 1];
  const windows: Array<[string, PeriodKey]> = [
    ["3M", "3M"], ["YTD", "YTD"], ["1Y", "1Y"], ["3Y", "3Y"], ["5Y", "5Y"], ["10Y", "10Y"],
  ];
  const out: Array<{ window: string; return: number | null; annualized: boolean }> = [];
  for (const [label, key] of windows) {
    const startIso = iso(periodStart(key, new Date(Date.parse(end))));
    if (startIso < dates[0]) { out.push({ window: label, return: null, annualized: false }); continue; }
    const bi = baselineIndex(dates, startIso);
    const span = (Date.parse(end) - Date.parse(dates[bi])) / DAY;
    const total = endVal / nav[bi] - 1;
    const annualize = span > 400;
    out.push({
      window: label,
      return: annualize ? Math.pow(endVal / nav[bi], 365.25 / span) - 1 : total,
      annualized: annualize,
    });
  }
  return out;
}
