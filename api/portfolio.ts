/**
 * GET /api/portfolio — simulate a weighted portfolio with an explicit
 * rebalancing policy, against an optional benchmark.
 *
 * Query:
 *   holdings=VTI:60,BND:40        symbol:weightPercent, 1-25 legs
 *   benchmark=SPY                 optional
 *   period=3M|YTD|1Y|3Y|5Y|10Y|MAX
 *   rebalance=none|monthly|quarterly|semiannual|annual|threshold
 *   threshold=5                   percentage points, threshold policy only
 *   initial=10000
 *   riskFree=4.2                  annual percent, for Sharpe/Sortino/alpha
 *
 * Auth rides requireAccessOrSession — this fans out to one metered EODHD
 * call per leg, so an open endpoint would be a billing surface.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../lib/auth";
import { PERIODS, type PeriodKey } from "../lib/market/history";
import {
  buildPortfolio, REBALANCE_POLICIES, type Holding, type RebalancePolicy,
} from "../lib/portfolio/engine";

const SYMBOL_OK = /^[A-Za-z0-9.\-^]{1,20}$/;
const MAX_LEGS = 25;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** "VTI:60,BND:40" -> holdings. Bare symbols split the remainder equally. */
export function parseHoldings(raw: string): Holding[] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("holdings is required, e.g. holdings=VTI:60,BND:40");
  if (parts.length > MAX_LEGS) throw new Error(`Too many holdings (${parts.length}); max ${MAX_LEGS}.`);

  const out: Holding[] = [];
  const unweighted: number[] = [];
  let assigned = 0;

  for (const p of parts) {
    const [symRaw, wRaw] = p.split(":");
    const symbol = (symRaw ?? "").trim();
    if (!SYMBOL_OK.test(symbol)) throw new Error(`"${symbol}" is not a valid symbol.`);
    if (wRaw === undefined || wRaw.trim() === "") {
      unweighted.push(out.length);
      out.push({ symbol, weight: 0 });
    } else {
      const w = Number(wRaw);
      if (!Number.isFinite(w) || w < 0) throw new Error(`"${p}" has an invalid weight.`);
      assigned += w;
      out.push({ symbol, weight: w / 100 });
    }
  }
  if (unweighted.length) {
    const each = Math.max(0, 100 - assigned) / unweighted.length / 100;
    for (const i of unweighted) out[i].weight = each;
  }
  const seen = new Set<string>();
  for (const h of out) {
    const k = h.symbol.toUpperCase();
    if (seen.has(k)) throw new Error(`${k} appears twice; combine it into a single weight.`);
    seen.add(k);
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }

  const auth = await requireAccessOrSession(req);
  if (!auth.ok) { res.status(401).json({ error: auth.reason }); return; }

  const period = (one(req.query.period).trim() || "5Y").toUpperCase();
  const rebalance = (one(req.query.rebalance).trim() || "quarterly").toLowerCase();
  const benchmark = one(req.query.benchmark).trim();

  try {
    if (!PERIODS.includes(period as PeriodKey)) {
      throw new Error(`Unknown period "${period}". Use one of ${PERIODS.join(", ")}.`);
    }
    if (!REBALANCE_POLICIES.includes(rebalance as RebalancePolicy)) {
      throw new Error(
        `Unknown rebalance policy "${rebalance}". Use one of ${REBALANCE_POLICIES.join(", ")}.`
      );
    }
    if (benchmark && !SYMBOL_OK.test(benchmark)) {
      throw new Error(`"${benchmark}" is not a valid benchmark symbol.`);
    }
    const holdings = parseHoldings(one(req.query.holdings));

    const initialRaw = Number(one(req.query.initial));
    const initial = Number.isFinite(initialRaw) && initialRaw > 0 ? initialRaw : 10000;
    const thrRaw = Number(one(req.query.threshold));
    const thresholdPct = Number.isFinite(thrRaw) && thrRaw > 0 ? thrRaw / 100 : 0.05;
    const rfRaw = Number(one(req.query.riskFree));
    const riskFree = Number.isFinite(rfRaw) ? rfRaw / 100 : 0;

    const payload = await buildPortfolio({
      holdings,
      benchmark: benchmark || null,
      period: period as PeriodKey,
      rebalance: rebalance as RebalancePolicy,
      thresholdPct,
      initial,
      riskFree,
    });

    res.setHeader("Cache-Control", "private, max-age=900");
    res.status(200).json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A bad symbol or malformed weight is the caller's problem (400); an
    // upstream failure is ours (502). Collapsing both to 500 would make the
    // console show "server error" for a typo'd ticker.
    const isInput =
      /not a valid|Unknown period|Unknown rebalance|holdings is required|Too many holdings|invalid weight|appears twice|sum to more/.test(message);
    res.status(isInput ? 400 : 502).json({ error: message, period, rebalance });
  }
}
