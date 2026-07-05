/**
 * Macro market-signals layer — a curated composite of leading indicators,
 * credit conditions, liquidity plumbing, and sentiment, built on the
 * already-verified FRED client. One call = the state of the market's
 * early-warning system.
 *
 * Tools:
 *   macro_market_signals — 21 indicators across six pillars, fetched in
 *     parallel, each with latest value, ~1-month and ~3-month priors,
 *     changes, and a threshold-based signal reading; plus computed Fed NET
 *     LIQUIDITY (WALCL − ON RRP − TGA, unit-normalized) and a highlights
 *     array of currently-firing signals.
 *   fred_batch_latest — generic parallel fetch of any FRED series list
 *     with the same latest/1m/3m math (feeds ad-hoc dashboards and
 *     Randall's pre-market briefs).
 *
 * These are historical-relationship indicators, not predictions. The
 * interpretation strings state well-documented empirical regularities
 * (e.g. 3M-10Y inversion preceding recessions) and threshold context —
 * nothing here is investment advice.
 */
import { getSeries, getObservations } from "../fred/client";

interface SeriesPoint {
  date: string;
  value: number;
}

async function fetchRecent(seriesId: string, units?: string): Promise<SeriesPoint[]> {
  const obs = await getObservations(seriesId, {
    limit: 90,
    sortOrder: "desc",
    ...(units ? { units: units as any } : {}),
  });
  return (obs.observations ?? [])
    .filter((o: any) => o.value !== ".")
    .map((o: any) => ({ date: o.date, value: parseFloat(o.value) }));
}

function daysAgoIso(fromIso: string, days: number): string {
  const d = new Date(fromIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** points sorted newest-first; first point at or before target date */
function valueAtOrBefore(points: SeriesPoint[], targetDate: string): SeriesPoint | null {
  for (const p of points) {
    if (p.date <= targetDate) return p;
  }
  return null;
}

function round3(x: number | null): number | null {
  return x == null || !Number.isFinite(x) ? null : +x.toFixed(3);
}

type SignalFn = (latest: number, change3m: number | null) => { signal: string; firing: boolean };

interface IndicatorDef {
  id: string;
  name: string;
  pillar: "curve" | "credit" | "liquidity" | "growth" | "inflation" | "sentiment";
  unitLabel: string;
  fredUnits?: string; // FRED transform, e.g. pc1 for YoY %
  rule?: SignalFn;
}

const trendRule =
  (risingMeans: string, fallingMeans: string): SignalFn =>
  (_latest, change3m) => {
    if (change3m == null || change3m === 0) return { signal: "roughly flat vs 3 months ago", firing: false };
    return {
      signal: change3m > 0 ? `rising vs 3 months ago — ${risingMeans}` : `falling vs 3 months ago — ${fallingMeans}`,
      firing: false,
    };
  };

const INDICATORS: IndicatorDef[] = [
  // —— Curve & rates ——
  {
    id: "T10Y3M", name: "10Y–3M Treasury spread", pillar: "curve", unitLabel: "%",
    rule: (v) => v < 0
      ? { signal: "INVERTED — 3M-10Y inversion has preceded every U.S. recession since the late 1960s, typically by 6–18 months; the re-steepening out of inversion has historically been the later-cycle warning", firing: true }
      : { signal: "positively sloped", firing: false },
  },
  {
    id: "T10Y2Y", name: "10Y–2Y Treasury spread", pillar: "curve", unitLabel: "%",
    rule: (v) => v < 0
      ? { signal: "INVERTED — the classic curve recession signal", firing: true }
      : { signal: "positively sloped", firing: false },
  },
  { id: "DGS10", name: "10Y Treasury yield", pillar: "curve", unitLabel: "%", rule: trendRule("rates headwind building", "rates easing") },
  { id: "DFII10", name: "10Y TIPS real yield", pillar: "curve", unitLabel: "%", rule: trendRule("real-rate tightening (historically pressures long-duration assets and gold)", "real-rate easing") },
  // —— Credit & financial conditions ——
  {
    id: "BAMLH0A0HYM2", name: "ICE BofA US High Yield OAS", pillar: "credit", unitLabel: "%",
    rule: (v) => {
      if (v >= 7) return { signal: "STRESS — spreads at levels seen in credit events/recessions", firing: true };
      if (v >= 5) return { signal: "elevated — credit risk being repriced", firing: true };
      if (v < 3) return { signal: "tight — historically associated with late-cycle complacency and thin compensation for risk", firing: false };
      return { signal: "normal range", firing: false };
    },
  },
  { id: "BAMLC0A0CM", name: "ICE BofA US Corporate (IG) OAS", pillar: "credit", unitLabel: "%", rule: trendRule("IG credit repricing wider", "IG credit firm") },
  {
    id: "NFCI", name: "Chicago Fed National Financial Conditions Index", pillar: "credit", unitLabel: "index (0 = avg)",
    rule: (v) => v > 0
      ? { signal: "TIGHTER-than-average financial conditions — a leading drag on activity", firing: true }
      : { signal: "looser-than-average financial conditions", firing: false },
  },
  {
    id: "STLFSI4", name: "St. Louis Fed Financial Stress Index", pillar: "credit", unitLabel: "index (0 = avg)",
    rule: (v) => v > 0
      ? { signal: "ABOVE-average financial stress", firing: true }
      : { signal: "below-average financial stress", firing: false },
  },
  // —— Liquidity plumbing ——
  { id: "WALCL", name: "Fed balance sheet (total assets)", pillar: "liquidity", unitLabel: "$ millions (weekly, Wed)", rule: trendRule("balance-sheet expansion", "QT / balance-sheet runoff") },
  { id: "RRPONTSYD", name: "Overnight reverse repo (ON RRP)", pillar: "liquidity", unitLabel: "$ billions (daily)", rule: trendRule("cash parking at the Fed (drains market liquidity)", "RRP drain releasing liquidity into the system") },
  { id: "WTREGEN", name: "Treasury General Account (TGA)", pillar: "liquidity", unitLabel: "$ billions (weekly, Wed)", rule: trendRule("TGA rebuild absorbing liquidity", "TGA drawdown adding liquidity") },
  // —— Growth & labor ——
  {
    id: "ICSA", name: "Initial jobless claims", pillar: "growth", unitLabel: "claims (weekly)",
    rule: (_v, c3) => {
      if (c3 != null && c3 > 0) return { signal: "rising vs 3 months ago — labor softening is one of the earliest cycle turns", firing: c3 > 25000 };
      return { signal: "stable-to-falling — labor market holding", firing: false };
    },
  },
  {
    id: "SAHMREALTIME", name: "Sahm rule recession indicator", pillar: "growth", unitLabel: "pp (trigger ≥ 0.50)",
    rule: (v) => v >= 0.5
      ? { signal: "TRIGGERED — the Sahm rule has flagged every U.S. recession since 1970 in real time", firing: true }
      : { signal: `below the 0.50 trigger (${v.toFixed(2)})`, firing: false },
  },
  { id: "WEI", name: "Weekly Economic Index (Lewis-Mertens-Stock)", pillar: "growth", unitLabel: "scaled to 4-qtr GDP growth, %", rule: trendRule("activity accelerating", "activity decelerating") },
  { id: "PERMIT", name: "Building permits", pillar: "growth", unitLabel: "thousands, SAAR", rule: trendRule("housing pipeline expanding — housing historically leads the cycle", "housing pipeline contracting — housing historically leads the cycle down") },
  { id: "UNRATE", name: "Unemployment rate", pillar: "growth", unitLabel: "%", rule: trendRule("unemployment rising", "unemployment falling") },
  // —— Inflation expectations ——
  { id: "T10YIE", name: "10Y breakeven inflation", pillar: "inflation", unitLabel: "%", rule: trendRule("inflation expectations building", "inflation expectations easing") },
  { id: "T5YIFR", name: "5Y5Y forward inflation expectation", pillar: "inflation", unitLabel: "%", rule: (v) => v > 2.6 ? { signal: "above the range the Fed treats as anchored — pressure for tighter policy", firing: true } : v < 2.0 ? { signal: "below 2% — disinflation/undershoot signal", firing: false } : { signal: "anchored near the Fed's comfort zone", firing: false } },
  { id: "CPIAUCSL", name: "CPI inflation (YoY)", pillar: "inflation", unitLabel: "% YoY", fredUnits: "pc1", rule: trendRule("inflation re-accelerating", "disinflation in train") },
  // —— Sentiment & volatility ——
  {
    id: "VIXCLS", name: "CBOE VIX", pillar: "sentiment", unitLabel: "index",
    rule: (v) => {
      if (v >= 30) return { signal: "HIGH volatility regime — stress/liquidation conditions", firing: true };
      if (v >= 20) return { signal: "elevated volatility", firing: true };
      if (v < 13) return { signal: "very low vol — historically a complacency reading, vulnerable to shocks", firing: false };
      return { signal: "normal volatility", firing: false };
    },
  },
  { id: "UMCSENT", name: "U. Michigan consumer sentiment", pillar: "sentiment", unitLabel: "index", rule: trendRule("consumer mood improving", "consumer mood deteriorating") },
  { id: "USEPUINDXD", name: "Economic Policy Uncertainty index (daily)", pillar: "sentiment", unitLabel: "index", rule: trendRule("policy uncertainty building", "policy uncertainty receding") },
];

const PILLARS = ["curve", "credit", "liquidity", "growth", "inflation", "sentiment"] as const;

interface IndicatorReading {
  id: string;
  name: string;
  pillar: string;
  unit: string;
  latest: number | null;
  date: string | null;
  oneMonthAgo: SeriesPoint | null;
  threeMonthsAgo: SeriesPoint | null;
  change1m: number | null;
  change3m: number | null;
  signal: string | null;
  error?: string;
}

async function readIndicator(def: IndicatorDef): Promise<{ reading: IndicatorReading; firing: boolean; points: SeriesPoint[] }> {
  try {
    const points = await fetchRecent(def.id, def.fredUnits);
    const latest = points[0] ?? null;
    if (!latest) {
      return {
        reading: { id: def.id, name: def.name, pillar: def.pillar, unit: def.unitLabel, latest: null, date: null, oneMonthAgo: null, threeMonthsAgo: null, change1m: null, change3m: null, signal: null, error: "no observations returned" },
        firing: false,
        points: [],
      };
    }
    const m1 = valueAtOrBefore(points, daysAgoIso(latest.date, 30));
    const m3 = valueAtOrBefore(points, daysAgoIso(latest.date, 91));
    const change1m = m1 ? round3(latest.value - m1.value) : null;
    const change3m = m3 ? round3(latest.value - m3.value) : null;
    const ruled = def.rule ? def.rule(latest.value, change3m) : { signal: "", firing: false };
    return {
      reading: {
        id: def.id, name: def.name, pillar: def.pillar, unit: def.unitLabel,
        latest: round3(latest.value), date: latest.date,
        oneMonthAgo: m1 ? { date: m1.date, value: round3(m1.value)! } : null,
        threeMonthsAgo: m3 ? { date: m3.date, value: round3(m3.value)! } : null,
        change1m, change3m,
        signal: ruled.signal || null,
      },
      firing: ruled.firing,
      points,
    };
  } catch (err) {
    return {
      reading: { id: def.id, name: def.name, pillar: def.pillar, unit: def.unitLabel, latest: null, date: null, oneMonthAgo: null, threeMonthsAgo: null, change1m: null, change3m: null, signal: null, error: err instanceof Error ? err.message : String(err) },
      firing: false,
      points: [],
    };
  }
}

export interface MacroMarketSignalsArgs {
  pillars?: string[];
}

export async function macroMarketSignals(args: MacroMarketSignalsArgs = {}) {
  const wanted = args.pillars?.length
    ? args.pillars.map((p) => String(p).toLowerCase()).filter((p) => (PILLARS as readonly string[]).includes(p))
    : [...PILLARS];
  const defs = INDICATORS.filter((d) => wanted.includes(d.pillar));

  const liquidityWanted = wanted.includes("liquidity");
  const [results, walclMeta, rrpMeta, tgaMeta] = await Promise.all([
    Promise.all(defs.map(readIndicator)),
    liquidityWanted ? getSeries("WALCL").catch(() => null) : Promise.resolve(null),
    liquidityWanted ? getSeries("RRPONTSYD").catch(() => null) : Promise.resolve(null),
    liquidityWanted ? getSeries("WTREGEN").catch(() => null) : Promise.resolve(null),
  ]);

  const byId: Record<string, { reading: IndicatorReading; points: SeriesPoint[] }> = {};
  for (const r of results) byId[r.reading.id] = { reading: r.reading, points: r.points };

  const highlights: string[] = [];
  for (const r of results) {
    if (r.firing && r.reading.latest != null) {
      highlights.push(`${r.reading.name}: ${r.reading.latest} ${r.reading.unit} — ${r.reading.signal}`);
    }
  }

  // —— Net liquidity: WALCL ($MM) − ON RRP ($B) − TGA ($B) ——
  let netLiquidity: any = null;
  if (liquidityWanted) {
    const w = byId["WALCL"], r = byId["RRPONTSYD"], t = byId["WTREGEN"];
    const unitWarnings: string[] = [];
    if (walclMeta?.units && !/million/i.test(walclMeta.units)) unitWarnings.push(`WALCL units read '${walclMeta.units}', expected millions`);
    if (rrpMeta?.units && !/billion/i.test(rrpMeta.units)) unitWarnings.push(`RRPONTSYD units read '${rrpMeta.units}', expected billions`);
    if (tgaMeta?.units && !/billion/i.test(tgaMeta.units)) unitWarnings.push(`WTREGEN units read '${tgaMeta.units}', expected billions`);
    const compute = (wp: SeriesPoint | null, rp: SeriesPoint | null, tp: SeriesPoint | null): number | null =>
      wp && rp && tp ? wp.value * 1e6 - rp.value * 1e9 - tp.value * 1e9 : null;
    const latestNet = compute(w?.points[0] ?? null, r?.points[0] ?? null, t?.points[0] ?? null);
    if (latestNet != null) {
      const anchor = w!.points[0]!.date;
      const net1m = compute(
        valueAtOrBefore(w!.points, daysAgoIso(anchor, 30)),
        valueAtOrBefore(r!.points, daysAgoIso(anchor, 30)),
        valueAtOrBefore(t!.points, daysAgoIso(anchor, 30))
      );
      const net3m = compute(
        valueAtOrBefore(w!.points, daysAgoIso(anchor, 91)),
        valueAtOrBefore(r!.points, daysAgoIso(anchor, 91)),
        valueAtOrBefore(t!.points, daysAgoIso(anchor, 91))
      );
      const trn = (x: number | null) => (x == null ? null : +(x / 1e12).toFixed(3));
      netLiquidity = {
        definition: "Fed balance sheet (WALCL) − overnight reverse repo (RRPONTSYD) − Treasury General Account (WTREGEN), normalized to USD",
        latestUsdTrillions: trn(latestNet),
        oneMonthAgoUsdTrillions: trn(net1m),
        threeMonthsAgoUsdTrillions: trn(net3m),
        change3mUsdTrillions: net3m != null ? trn(latestNet - net3m + 0) : null,
        asOf: { walcl: w!.points[0]!.date, rrp: r!.points[0]!.date, tga: t!.points[0]!.date },
        note: "Rising net liquidity has historically coincided with support for risk assets; drains (QT + TGA rebuilds + RRP growth) with headwinds. Components mix weekly and daily frequencies — asOf dates differ.",
        ...(unitWarnings.length ? { unitWarnings } : {}),
      };
      if (netLiquidity.change3mUsdTrillions != null && Math.abs(netLiquidity.change3mUsdTrillions) >= 0.2) {
        highlights.push(`Net liquidity ${netLiquidity.change3mUsdTrillions > 0 ? "UP" : "DOWN"} ${Math.abs(netLiquidity.change3mUsdTrillions)}T over ~3 months (now ${netLiquidity.latestUsdTrillions}T)`);
      }
    }
  }

  const failed = results.filter((r) => r.reading.error);
  const pillars: Record<string, IndicatorReading[]> = {};
  for (const p of wanted) pillars[p] = results.filter((r) => r.reading.pillar === p).map((r) => r.reading);

  return {
    dataSource: "FRED (Federal Reserve Bank of St. Louis), live — curated macro signal composite",
    asOf: new Date().toISOString().slice(0, 10),
    highlights: highlights.length ? highlights : ["No threshold signals currently firing across the requested pillars."],
    ...(netLiquidity ? { netLiquidity } : {}),
    pillars,
    indicatorsRequested: defs.length,
    indicatorsReturned: results.length - failed.length,
    ...(failed.length ? { failedIndicators: failed.map((f) => ({ id: f.reading.id, error: f.reading.error })) } : {}),
    note:
      "Leading/coincident indicators with threshold context based on well-documented historical relationships — NOT predictions or investment advice. change1m/change3m are absolute changes vs the observation nearest ~30/~91 days before each series' latest print; mixed frequencies mean dates differ by series. Pair with ofr_financial_stress_index (daily systemic gauge) and fred_yield_curve (full curve). For deeper history on any indicator use fred_get_series with its id.",
  };
}

export interface FredBatchLatestArgs {
  seriesIds: string[];
  maxSeries?: number;
}

export async function fredBatchLatest(args: FredBatchLatestArgs) {
  if (!args.seriesIds || !Array.isArray(args.seriesIds) || args.seriesIds.length === 0) {
    throw new Error("fred_batch_latest requires seriesIds (array of FRED series IDs, e.g. ['VIXCLS','T10Y2Y']).");
  }
  const cap = Math.min(args.maxSeries ?? 15, 15);
  const ids = [...new Set(args.seriesIds.map((s) => String(s).trim().toUpperCase()).filter(Boolean))].slice(0, cap);

  const rows = await Promise.all(
    ids.map(async (id) => {
      try {
        const [meta, points] = await Promise.all([getSeries(id).catch(() => null), fetchRecent(id)]);
        const latest = points[0] ?? null;
        if (!latest) return { seriesId: id, error: "no observations returned" };
        const m1 = valueAtOrBefore(points, daysAgoIso(latest.date, 30));
        const m3 = valueAtOrBefore(points, daysAgoIso(latest.date, 91));
        return {
          seriesId: id,
          title: meta?.title ?? null,
          units: meta?.units ?? null,
          frequency: meta?.frequency ?? null,
          latest: round3(latest.value),
          date: latest.date,
          oneMonthAgo: m1 ? { date: m1.date, value: round3(m1.value) } : null,
          threeMonthsAgo: m3 ? { date: m3.date, value: round3(m3.value) } : null,
          change1m: m1 ? round3(latest.value - m1.value) : null,
          change3m: m3 ? round3(latest.value - m3.value) : null,
        };
      } catch (err) {
        return { seriesId: id, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  return {
    dataSource: "FRED (Federal Reserve Bank of St. Louis), live",
    requested: ids.length,
    returned: rows.filter((r: any) => !r.error).length,
    series: rows,
    note:
      "Latest print plus the observations nearest ~30 and ~91 days prior, with absolute changes. Max 15 series per call. Find IDs with fred_series_search; for full history use fred_get_series.",
  };
}
