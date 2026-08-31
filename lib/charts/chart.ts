/**
 * VistaCharts payload builder, on the shared analytics library.
 *
 * Replaces lib/charts/prices.ts. That file predated lib/market/history.ts
 * and kept its own loader and statistics; two implementations of "what did
 * this return" is exactly the drift the shared library exists to prevent,
 * so this module owns none of the math — it only shapes a payload.
 *
 * FULL HISTORY, ALWAYS. The loader pulls each leg from inception regardless
 * of the selected window, for three reasons:
 *   1. Trailing returns (3M…10Y) and calendar-year returns are measured from
 *      the latest close backwards — a dashboard that could only fill the
 *      windows inside the chart's own span would go blank exactly when the
 *      user zooms in.
 *   2. EODHD bills per request, not per row: full history costs the same
 *      call as three months.
 *   3. The window baseline (last close STRICTLY BEFORE the window opens) is
 *      then always available — a YTD chart measures from Dec 31 without a
 *      fetch buffer.
 *
 * Window stats (riskStats / relativeStats) describe the SELECTED window —
 * the thing on screen. Trailing and calendar tables describe full common
 * history to the same as-of date. The payload labels both so the console
 * does not have to guess.
 */

import {
  PERIODS, PERIOD_LABEL, type PeriodKey,
  iso, periodStart, loadBars, alignOnCommonDates, baselineIndex, downsample,
  riskStats, relativeStats, calendarYearReturns, trailingReturns,
  type Bar, type RiskStats, type RelativeStats,
} from "../market/history";

export { PERIODS, PERIOD_LABEL, type PeriodKey };

/** Calendar-year rows are capped so a 1962 listing does not ship 60 rows. */
export const MAX_CALENDAR_YEARS = 12;
const MAX_POINTS = 420;

export interface ChartSeries extends RiskStats {
  symbol: string;
  role: "ticker" | "benchmark";
  startPrice: number;
  endPrice: number;
  /** Cumulative return from the window baseline, as a decimal. Downsampled. */
  points: number[];
}

export interface ChartPayload {
  period: PeriodKey;
  periodLabel: string;
  from: string;
  to: string;
  asOf: string;
  provider: "eodhd";
  returnBasis: "total";
  tradingDays: number;
  /** First common trading date across the legs — full-history inception. */
  historyFrom: string;
  dates: string[];
  series: ChartSeries[];
  /** Over the selected window, ticker vs benchmark. */
  relative: RelativeStats | null;
  /** Full common history, measured back from asOf. */
  trailing: Array<{
    window: string; return: number | null; annualized: boolean; benchmark: number | null;
  }>;
  /** Full common history, newest last; capped at MAX_CALENDAR_YEARS. */
  calendarYears: Array<{
    year: string; return: number; partial: boolean; benchmark: number | null;
  }>;
  notes: string[];
}

export interface ChartRequest {
  ticker: string;
  benchmark?: string | null;
  period: PeriodKey;
  /** Annual risk-free rate as a decimal, for Sharpe / Sortino / alpha. */
  riskFree?: number;
  today?: Date;
}

/**
 * Pure payload assembly from already-loaded bars, so the math is testable
 * with synthetic series — the same split the portfolio engine makes between
 * simulate() and buildPortfolio().
 */
export function buildChartFromBars(
  symbols: string[], bars: Bar[][], req: ChartRequest
): ChartPayload {
  const today = req.today ?? new Date();
  const riskFree = req.riskFree ?? 0;
  const notes: string[] = [];

  const { dates, closes } = alignOnCommonDates(bars);
  if (dates.length < 2) {
    throw new Error(
      symbols.length > 1
        ? `No overlapping trading history for ${symbols.join(" and ")}.`
        : `No price history for ${symbols[0]}.`
    );
  }

  /* ------------------------------------------------ full-history tables */
  const trailA = trailingReturns(closes[0], dates);
  const trailB = closes.length > 1 ? trailingReturns(closes[1], dates) : null;
  const trailing = trailA.map((t, i) => ({
    ...t, benchmark: trailB ? trailB[i].return : null,
  }));

  const yearsA = calendarYearReturns(closes[0], dates);
  const yearsB = closes.length > 1 ? calendarYearReturns(closes[1], dates) : null;
  const byYearB = new Map((yearsB ?? []).map((y) => [y.year, y.return]));
  let calendarYears = yearsA.map((y) => ({
    ...y, benchmark: byYearB.has(y.year) ? (byYearB.get(y.year) as number) : null,
  }));
  if (calendarYears.length > MAX_CALENDAR_YEARS) {
    notes.push(
      `Calendar years shown from ${calendarYears[calendarYears.length - MAX_CALENDAR_YEARS].year}; ` +
      `common history begins ${dates[0]}.`
    );
    calendarYears = calendarYears.slice(-MAX_CALENDAR_YEARS);
  }

  /* --------------------------------------------------------- the window */
  const startIso = iso(periodStart(req.period, today));
  const baseIdx = req.period === "MAX" ? 0 : baselineIndex(dates, startIso);
  if (req.period !== "MAX" && dates[0] >= startIso) {
    notes.push(
      `Common history begins ${dates[0]}, inside the requested ${PERIOD_LABEL[req.period]} ` +
      `window — the chart shows what exists.`
    );
  }

  const winDates = dates.slice(baseIdx);
  const winCloses = closes.map((c) => c.slice(baseIdx));

  const series: ChartSeries[] = winCloses.map((c, i) => ({
    symbol: symbols[i].trim().toUpperCase(),
    role: i === 0 ? "ticker" : "benchmark",
    startPrice: c[0],
    endPrice: c[c.length - 1],
    points: downsample(c.map((v) => v / c[0] - 1), MAX_POINTS),
    ...riskStats(c, winDates, riskFree),
  }));

  return {
    period: req.period,
    periodLabel: PERIOD_LABEL[req.period],
    from: winDates[0],
    to: winDates[winDates.length - 1],
    asOf: dates[dates.length - 1],
    provider: "eodhd",
    returnBasis: "total",
    tradingDays: winDates.length,
    historyFrom: dates[0],
    dates: downsample(winDates, MAX_POINTS),
    series,
    relative: winCloses.length > 1
      ? relativeStats(winCloses[0], winCloses[1], winDates, riskFree)
      : null,
    trailing,
    calendarYears,
    notes,
  };
}

export async function buildChart(req: ChartRequest): Promise<ChartPayload> {
  const today = req.today ?? new Date();
  const symbols = [req.ticker];
  const bench = (req.benchmark ?? "").trim();
  if (bench && bench.toUpperCase() !== req.ticker.trim().toUpperCase()) symbols.push(bench);

  const bars = await loadBars(symbols, iso(periodStart("MAX", today)), iso(today));
  return buildChartFromBars(symbols, bars, req);
}
