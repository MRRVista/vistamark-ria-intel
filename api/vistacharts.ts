/**
 * GET /api/vistacharts — rebased total-return series for a ticker against a
 * benchmark, plus the multi-period dashboard tables: trailing returns and
 * calendar-year returns over full common history, and window risk stats.
 *
 * Query: ?ticker=AAPL&benchmark=SPY&period=1Y&riskFree=4.2
 *   period   ∈ 3M | YTD | 1Y | 3Y | 5Y | 10Y | MAX   (default 1Y)
 *   benchmark may be empty for a single-line chart.
 *   riskFree  optional annual percent for Sharpe / Sortino / alpha; default 0.
 *
 * Auth rides requireAccessOrSession — the same posture as /api/catalog: an
 * Entra session cookie from the console, or an ACCESS_TOKEN header. NOT
 * left open like /api/selftest: this one burns metered EODHD calls, so an
 * unauthenticated endpoint is a billing surface, not just a data surface.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../lib/auth";
import { buildChart, PERIODS, PERIOD_LABEL, type PeriodKey } from "../lib/charts/chart";

const SYMBOL_OK = /^[A-Za-z0-9.\-^]{1,20}$/;

function one(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const auth = await requireAccessOrSession(req);
  if (!auth.ok) {
    res.status(401).json({ error: auth.reason });
    return;
  }

  const ticker = one(req.query.ticker).trim();
  const benchmark = one(req.query.benchmark).trim();
  const periodRaw = (one(req.query.period).trim() || "1Y").toUpperCase();
  const riskFreeRaw = one(req.query.riskFree).trim();

  if (!ticker) {
    res.status(400).json({ error: "ticker is required", periods: PERIODS });
    return;
  }
  if (!SYMBOL_OK.test(ticker)) {
    res.status(400).json({ error: `"${ticker}" is not a valid symbol.` });
    return;
  }
  if (benchmark && !SYMBOL_OK.test(benchmark)) {
    res.status(400).json({ error: `"${benchmark}" is not a valid benchmark symbol.` });
    return;
  }
  if (!PERIODS.includes(periodRaw as PeriodKey)) {
    res.status(400).json({ error: `Unknown period "${periodRaw}".`, periods: PERIODS });
    return;
  }
  let riskFree = 0;
  if (riskFreeRaw) {
    const rf = Number(riskFreeRaw);
    if (!Number.isFinite(rf) || rf < -5 || rf > 25) {
      res.status(400).json({ error: `riskFree must be an annual percent, e.g. riskFree=4.2` });
      return;
    }
    riskFree = rf / 100;
  }

  try {
    const payload = await buildChart({
      ticker,
      benchmark: benchmark || null,
      period: periodRaw as PeriodKey,
      riskFree,
    });
    // Closes only move once a day; a short edge cache keeps repeated period
    // toggling off the metered EODHD quota without going stale intraday.
    res.setHeader("Cache-Control", "private, max-age=900");
    res.status(200).json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({
      error: message,
      ticker,
      benchmark: benchmark || null,
      period: periodRaw,
      periodLabel: PERIOD_LABEL[periodRaw as PeriodKey],
    });
  }
}
