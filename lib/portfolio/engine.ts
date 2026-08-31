/**
 * Portfolio simulation with rebalancing.
 *
 * The whole point of this file is that "what did a 60/40 return" has no
 * single answer — it depends entirely on the rebalancing assumption. A
 * never-rebalanced 60/40 started in 2015 is a ~75/25 by 2025 and reports a
 * materially different return and drawdown than a quarterly-rebalanced one.
 * So the rebalance policy is a required, explicit input, never a default
 * buried in the maths, and it is echoed back in the payload.
 *
 * Mechanics: shares are held constant BETWEEN rebalances and recomputed
 * from target weights ON them. Prices are adjusted closes, so dividends are
 * already reinvested in the paying security; a cash drag or external
 * contribution model is deliberately out of scope for this draft.
 */

import {
  alignOnCommonDates, baselineIndex, calendarYearReturns, downsample, iso,
  loadBars, periodStart, relativeStats, riskStats, trailingReturns,
  type PeriodKey, type RelativeStats, type RiskStats,
} from "../market/history";

export type RebalancePolicy =
  | "none" | "monthly" | "quarterly" | "semiannual" | "annual" | "threshold";

export const REBALANCE_POLICIES: RebalancePolicy[] = [
  "none", "monthly", "quarterly", "semiannual", "annual", "threshold",
];

export const REBALANCE_LABEL: Record<RebalancePolicy, string> = {
  none: "Buy and hold (never rebalance)",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Semi-annual",
  annual: "Annual",
  threshold: "Threshold band",
};

export interface Holding { symbol: string; weight: number }

export interface PortfolioRequest {
  holdings: Holding[];
  benchmark?: string | null;
  period: PeriodKey;
  rebalance: RebalancePolicy;
  /** Absolute drift in percentage points that triggers a threshold rebalance. */
  thresholdPct?: number;
  initial?: number;
  riskFree?: number;
  today?: Date;
  maxPoints?: number;
}

/** True when index i opens a new period under the given policy. */
function isRebalanceDate(
  policy: RebalancePolicy, dates: string[], i: number
): boolean {
  if (i === 0 || policy === "none" || policy === "threshold") return false;
  const prev = dates[i - 1], cur = dates[i];
  const pm = Number(prev.slice(5, 7)), cm = Number(cur.slice(5, 7));
  const py = prev.slice(0, 4), cy = cur.slice(0, 4);
  const newMonth = pm !== cm || py !== cy;
  if (!newMonth) return false;
  switch (policy) {
    case "monthly": return true;
    case "quarterly": return cm === 1 || cm === 4 || cm === 7 || cm === 10;
    case "semiannual": return cm === 1 || cm === 7;
    case "annual": return cy !== py;
  }
  return false;
}

export interface SimResult {
  nav: number[];
  rebalanceDates: string[];
  /** Weight of each holding at every date — this is where drift shows up. */
  endWeights: number[];
  maxDrift: number;
  contribution: number[];
}

export function simulate(
  closes: number[][], dates: string[], weights: number[],
  policy: RebalancePolicy, thresholdPct: number, initial: number
): SimResult {
  const k = weights.length;
  const nav: number[] = [];
  const rebalanceDates: string[] = [];
  let shares = weights.map((w, j) => (initial * w) / closes[j][0]);
  const startValue = weights.map((w) => initial * w);
  let maxDrift = 0;

  for (let i = 0; i < dates.length; i++) {
    let total = 0;
    for (let j = 0; j < k; j++) total += shares[j] * closes[j][i];

    // Drift is measured BEFORE any rebalance on this date, so the reported
    // maximum reflects how far the sleeve actually ran, not the post-trade state.
    for (let j = 0; j < k; j++) {
      const drift = Math.abs((shares[j] * closes[j][i]) / total - weights[j]);
      if (drift > maxDrift) maxDrift = drift;
    }

    const scheduled = isRebalanceDate(policy, dates, i);
    let banded = false;
    if (policy === "threshold" && i > 0) {
      for (let j = 0; j < k; j++) {
        if (Math.abs((shares[j] * closes[j][i]) / total - weights[j]) >= thresholdPct) {
          banded = true; break;
        }
      }
    }
    if (scheduled || banded) {
      shares = weights.map((w, j) => (total * w) / closes[j][i]);
      rebalanceDates.push(dates[i]);
    }
    nav.push(total);
  }

  const last = dates.length - 1;
  const finalTotal = nav[last];
  const endWeights = shares.map((s, j) => (s * closes[j][last]) / finalTotal);
  // Contribution: each sleeve's terminal value less what was put into it,
  // expressed against the starting portfolio value.
  const contribution = shares.map(
    (s, j) => (s * closes[j][last] - startValue[j]) / initial
  );

  return { nav, rebalanceDates, endWeights, maxDrift, contribution };
}

export interface PortfolioPayload {
  period: PeriodKey;
  from: string;
  to: string;
  tradingDays: number;
  initial: number;
  rebalance: RebalancePolicy;
  rebalanceLabel: string;
  thresholdPct: number | null;
  rebalanceCount: number;
  maxDrift: number;
  holdings: Array<Holding & {
    endWeight: number; contribution: number;
    totalReturn: number | null; volatility: number | null;
  }>;
  dates: string[];
  growth: number[];
  benchmarkGrowth: number[] | null;
  benchmark: string | null;
  stats: RiskStats;
  benchmarkStats: RiskStats | null;
  relative: RelativeStats | null;
  calendarYears: Array<{ year: string; return: number; partial: boolean; benchmark: number | null }>;
  trailing: Array<{ window: string; return: number | null; annualized: boolean; benchmark: number | null }>;
  notes: string[];
}

export async function buildPortfolio(req: PortfolioRequest): Promise<PortfolioPayload> {
  const today = req.today ?? new Date();
  const initial = req.initial ?? 10000;
  const maxPoints = req.maxPoints ?? 500;
  const thresholdPct = req.thresholdPct ?? 0.05;
  const notes: string[] = [];

  const total = req.holdings.reduce((a, h) => a + h.weight, 0);
  if (!(total > 0)) throw new Error("Portfolio weights must sum to more than zero.");
  if (Math.abs(total - 1) > 0.005) {
    notes.push(
      `Weights summed to ${(total * 100).toFixed(1)}% and were normalised to 100%.`
    );
  }
  const weights = req.holdings.map((h) => h.weight / total);

  const start = periodStart(req.period, today);
  const buffered = new Date(start.getTime());
  buffered.setUTCDate(buffered.getUTCDate() - 14);

  const symbols = req.holdings.map((h) => h.symbol);
  const bench = (req.benchmark ?? "").trim();
  const benchIdx = bench ? symbols.length : -1;
  const all = bench ? [...symbols, bench] : symbols;

  const bars = await loadBars(all, iso(buffered), iso(today));
  const { dates, closes } = alignOnCommonDates(bars);
  if (dates.length < 2) {
    throw new Error(
      "No overlapping trading history across these holdings in this window. " +
      "A holding that launched recently will truncate the whole portfolio."
    );
  }

  const startIso = iso(start);
  const bi = req.period === "MAX" ? 0 : baselineIndex(dates, startIso);
  const winDates = dates.slice(bi);
  const winCloses = closes.map((c) => c.slice(bi));

  const holdingCloses = winCloses.slice(0, symbols.length);
  const sim = simulate(holdingCloses, winDates, weights, req.rebalance, thresholdPct, initial);

  const benchNav = benchIdx >= 0
    ? winCloses[benchIdx].map((p) => (initial * p) / winCloses[benchIdx][0])
    : null;

  const stats = riskStats(sim.nav, winDates, req.riskFree ?? 0);
  const benchmarkStats = benchNav ? riskStats(benchNav, winDates, req.riskFree ?? 0) : null;
  const relative = benchNav
    ? relativeStats(sim.nav, benchNav, winDates, req.riskFree ?? 0)
    : null;

  const cy = calendarYearReturns(sim.nav, winDates);
  const cyBench = benchNav ? calendarYearReturns(benchNav, winDates) : null;
  const calendarYears = cy.map((r) => ({
    ...r,
    benchmark: cyBench?.find((b) => b.year === r.year)?.return ?? null,
  }));

  const tr = trailingReturns(sim.nav, winDates);
  const trBench = benchNav ? trailingReturns(benchNav, winDates) : null;
  const trailing = tr.map((r) => ({
    ...r,
    benchmark: trBench?.find((b) => b.window === r.window)?.return ?? null,
  }));

  if (req.rebalance === "none" && sim.maxDrift > 0.1) {
    notes.push(
      `Buy-and-hold let one sleeve drift ${(sim.maxDrift * 100).toFixed(1)} points from ` +
      `its target. The reported risk figures describe that drifted portfolio, not the stated weights.`
    );
  }

  const holdings = req.holdings.map((h, j) => {
    const hs = riskStats(holdingCloses[j], winDates, req.riskFree ?? 0);
    return {
      symbol: h.symbol.toUpperCase(),
      weight: weights[j],
      endWeight: sim.endWeights[j],
      contribution: sim.contribution[j],
      totalReturn: hs.totalReturn,
      volatility: hs.volatility,
    };
  });

  return {
    period: req.period,
    from: winDates[0],
    to: winDates[winDates.length - 1],
    tradingDays: winDates.length,
    initial,
    rebalance: req.rebalance,
    rebalanceLabel: REBALANCE_LABEL[req.rebalance],
    thresholdPct: req.rebalance === "threshold" ? thresholdPct : null,
    rebalanceCount: sim.rebalanceDates.length,
    maxDrift: sim.maxDrift,
    holdings,
    dates: downsample(winDates, maxPoints),
    growth: downsample(sim.nav, maxPoints),
    benchmarkGrowth: benchNav ? downsample(benchNav, maxPoints) : null,
    benchmark: bench ? bench.toUpperCase() : null,
    stats,
    benchmarkStats,
    relative,
    calendarYears,
    trailing,
    notes,
  };
}
