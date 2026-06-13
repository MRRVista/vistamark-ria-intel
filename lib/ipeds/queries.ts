/**
 * Query handlers for IPEDS endowment data.
 *
 * Tools:
 *   endowment_lookup            — single (UNITID, FY) or full history for one institution
 *   endowment_search            — filter by state/sector/control/size band, sorted
 *   endowment_peer_set          — for a target institution, find N closest by endowment size
 *   endowment_percentile_rank   — where a school ranks vs all institutions in a given FY
 *   endowment_growth_history    — CAGR over 1/3/5/10/all-time windows for one institution
 *   endowment_decade_comparison — compare two N-year windows for one institution
 *
 * v0.5.0 note: the endowments.contributions column was renamed to
 * net_change_in_endowment (IPEDS f2h03 = EOY-minus-BOY net change, not gifts).
 */

import { and, asc, desc, eq, gte, ilike, isNotNull, lte, sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { endowments, ipedsInstitutions } from "../db/schema";
import { SECTOR_LABEL, CONTROL_LABEL } from "./columns";

function decorateInstitution(row: any) {
  if (!row) return row;
  return {
    ...row,
    sectorLabel: row.sector != null ? SECTOR_LABEL[row.sector] ?? null : null,
    controlLabel: row.control != null ? CONTROL_LABEL[row.control] ?? null : null,
  };
}

export interface EndowmentLookupArgs {
  unitid?: number;
  instnm?: string;
  fyear?: number;
}

export async function endowmentLookup(args: EndowmentLookupArgs) {
  if (!isDbReady()) return { row: null, history: [], dbReady: false };
  let unitid = args.unitid;
  if (!unitid && args.instnm) {
    const m = await db
      .select({ unitid: ipedsInstitutions.unitid, instnm: ipedsInstitutions.instnm })
      .from(ipedsInstitutions)
      .where(ilike(ipedsInstitutions.instnm, `%${args.instnm}%`))
      .orderBy(asc(ipedsInstitutions.instnm))
      .limit(5);
    if (m.length === 0) {
      return { row: null, history: [], match: null, candidates: [], dbReady: true };
    }
    unitid = m[0]!.unitid;
  }
  if (unitid == null) throw new Error("endowment_lookup requires unitid or instnm");

  const instRows = await db
    .select()
    .from(ipedsInstitutions)
    .where(eq(ipedsInstitutions.unitid, unitid))
    .limit(1);
  const inst = instRows[0] ? decorateInstitution(instRows[0]) : null;

  const conds = [eq(endowments.unitid, unitid)];
  if (args.fyear != null) conds.push(eq(endowments.fyear, args.fyear));

  const rows = await db
    .select()
    .from(endowments)
    .where(and(...conds))
    .orderBy(desc(endowments.fyear));

  return {
    institution: inst,
    history: rows,
    latest: rows[0] ?? null,
    dbReady: true,
  };
}

export interface EndowmentSearchArgs {
  state?: string;
  control?: number;
  sector?: number;
  minEndowment?: number;
  maxEndowment?: number;
  fyear?: number;
  nameContains?: string;
  sortBy?: "market_value_eoy" | "market_value_boy" | "name" | "fyear";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function endowmentSearch(args: EndowmentSearchArgs) {
  if (!isDbReady()) return { rows: [], total: 0, dbReady: false };

  // Determine the FY to filter on. If no fyear is provided, use the most
  // recent FY for which we have any endowment data.
  let fyear = args.fyear;
  if (fyear == null) {
    const maxRow = await db
      .select({ maxFy: sql<number>`max(${endowments.fyear})::int` })
      .from(endowments)
      .where(isNotNull(endowments.marketValueEoy));
    fyear = maxRow[0]?.maxFy ?? null;
    if (fyear == null) return { rows: [], total: 0, dbReady: true };
  }

  const conds = [eq(endowments.fyear, fyear)];
  if (args.minEndowment != null) conds.push(gte(endowments.marketValueEoy, args.minEndowment));
  if (args.maxEndowment != null) conds.push(lte(endowments.marketValueEoy, args.maxEndowment));
  conds.push(isNotNull(endowments.marketValueEoy));

  const instConds: any[] = [];
  if (args.state) instConds.push(eq(ipedsInstitutions.state, args.state.toUpperCase()));
  if (args.control != null) instConds.push(eq(ipedsInstitutions.control, args.control));
  if (args.sector != null) instConds.push(eq(ipedsInstitutions.sector, args.sector));
  if (args.nameContains) {
    instConds.push(ilike(ipedsInstitutions.instnm, `%${args.nameContains}%`));
  }

  const sortDir = args.sortDir === "asc" ? asc : desc;
  const sortCol = {
    market_value_eoy: endowments.marketValueEoy,
    market_value_boy: endowments.marketValueBoy,
    name: ipedsInstitutions.instnm,
    fyear: endowments.fyear,
  }[args.sortBy ?? "market_value_eoy"];

  const limit = Math.min(args.limit ?? 50, 500);
  const offset = args.offset ?? 0;

  const allConds = [...conds, ...instConds];
  const where = and(...allConds);

  const rows = await db
    .select({
      unitid: ipedsInstitutions.unitid,
      instnm: ipedsInstitutions.instnm,
      city: ipedsInstitutions.city,
      state: ipedsInstitutions.state,
      sector: ipedsInstitutions.sector,
      control: ipedsInstitutions.control,
      webaddr: ipedsInstitutions.webaddr,
      fyear: endowments.fyear,
      fileType: endowments.fileType,
      marketValueBoy: endowments.marketValueBoy,
      marketValueEoy: endowments.marketValueEoy,
      netChangeInEndowment: endowments.netChangeInEndowment,
      netInvestmentReturn: endowments.netInvestmentReturn,
      withdrawals: endowments.withdrawals,
    })
    .from(endowments)
    .innerJoin(ipedsInstitutions, eq(ipedsInstitutions.unitid, endowments.unitid))
    .where(where)
    .orderBy(sortDir(sortCol))
    .limit(limit)
    .offset(offset);

  const totalRes = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(endowments)
    .innerJoin(ipedsInstitutions, eq(ipedsInstitutions.unitid, endowments.unitid))
    .where(where);

  return {
    rows: rows.map(decorateInstitution),
    total: totalRes[0]?.count ?? 0,
    fyear,
    dbReady: true,
  };
}

export interface EndowmentPeerSetArgs {
  unitid?: number;
  instnm?: string;
  fyear?: number;
  sizeBandPct?: number; // ± percent around target endowment (default 25)
  limit?: number;
  sameControl?: boolean;
}

export async function endowmentPeerSet(args: EndowmentPeerSetArgs) {
  if (!isDbReady()) return { peers: [], target: null, dbReady: false };
  const target = await endowmentLookup({
    unitid: args.unitid,
    instnm: args.instnm,
    fyear: args.fyear,
  });
  const latest = (target as any).latest;
  if (!latest || latest.marketValueEoy == null) {
    return { peers: [], target, dbReady: true, reason: "No endowment data on target" };
  }
  const pct = (args.sizeBandPct ?? 25) / 100;
  const lo = Math.round(latest.marketValueEoy * (1 - pct));
  const hi = Math.round(latest.marketValueEoy * (1 + pct));
  const limit = Math.min(args.limit ?? 25, 100);

  const fyear = latest.fyear;
  const conds: any[] = [
    eq(endowments.fyear, fyear),
    gte(endowments.marketValueEoy, lo),
    lte(endowments.marketValueEoy, hi),
  ];

  const targetControl = (target as any).institution?.control ?? null;
  if (args.sameControl && targetControl != null) {
    conds.push(eq(ipedsInstitutions.control, targetControl));
  }

  const rows = await db
    .select({
      unitid: ipedsInstitutions.unitid,
      instnm: ipedsInstitutions.instnm,
      city: ipedsInstitutions.city,
      state: ipedsInstitutions.state,
      sector: ipedsInstitutions.sector,
      control: ipedsInstitutions.control,
      marketValueEoy: endowments.marketValueEoy,
      fyear: endowments.fyear,
    })
    .from(endowments)
    .innerJoin(ipedsInstitutions, eq(ipedsInstitutions.unitid, endowments.unitid))
    .where(and(...conds))
    .orderBy(desc(endowments.marketValueEoy))
    .limit(limit);

  return {
    target,
    peers: rows.map(decorateInstitution).filter((r) => r.unitid !== latest.unitid),
    fyear,
    bandLow: lo,
    bandHigh: hi,
    dbReady: true,
  };
}

// ---------------------------------------------------------------------------
// v0.5.0 — new analytical tools
// ---------------------------------------------------------------------------

async function resolveUnitid(
  unitid?: number,
  instnm?: string
): Promise<{ unitid: number | null; institution: any | null; candidates?: any[] }> {
  if (unitid != null) {
    const rows = await db
      .select()
      .from(ipedsInstitutions)
      .where(eq(ipedsInstitutions.unitid, unitid))
      .limit(1);
    return { unitid, institution: rows[0] ? decorateInstitution(rows[0]) : null };
  }
  if (instnm) {
    const m = await db
      .select()
      .from(ipedsInstitutions)
      .where(ilike(ipedsInstitutions.instnm, `%${instnm}%`))
      .orderBy(asc(ipedsInstitutions.instnm))
      .limit(5);
    if (m.length === 0) return { unitid: null, institution: null, candidates: [] };
    return {
      unitid: m[0]!.unitid,
      institution: decorateInstitution(m[0]),
      candidates: m.map(decorateInstitution),
    };
  }
  return { unitid: null, institution: null };
}

export interface EndowmentPercentileRankArgs {
  unitid?: number;
  instnm?: string;
  fyear?: number;
}

/**
 * Given a target institution and fiscal year, compute where its end-of-year
 * endowment falls in the distribution of ALL institutions reporting that year.
 * Returns the target value, its percentile (0-100), absolute rank, the size of
 * the reporting universe, and the distribution breakpoints (p10..p99).
 */
export async function endowmentPercentileRank(args: EndowmentPercentileRankArgs) {
  if (!isDbReady()) return { dbReady: false };
  const resolved = await resolveUnitid(args.unitid, args.instnm);
  if (resolved.unitid == null) {
    return { dbReady: true, target: null, candidates: resolved.candidates ?? [], reason: "Institution not found" };
  }
  const unitid = resolved.unitid;

  // Resolve fyear: explicit, else the institution's latest reported FY.
  let fyear = args.fyear;
  if (fyear == null) {
    const fyRow = await db
      .select({ maxFy: sql<number>`max(${endowments.fyear})::int` })
      .from(endowments)
      .where(and(eq(endowments.unitid, unitid), isNotNull(endowments.marketValueEoy)));
    fyear = fyRow[0]?.maxFy ?? null;
    if (fyear == null) {
      return { dbReady: true, target: resolved.institution, reason: "No endowment data for institution" };
    }
  }

  const targetRow = await db
    .select({ eoy: endowments.marketValueEoy })
    .from(endowments)
    .where(and(eq(endowments.unitid, unitid), eq(endowments.fyear, fyear)))
    .limit(1);
  const targetValue = targetRow[0]?.eoy ?? null;
  if (targetValue == null) {
    return { dbReady: true, target: resolved.institution, fyear, reason: "No endowment value for that FY" };
  }

  // Distribution breakpoints for the FY universe.
  const breaks = await db.execute(sql`
    SELECT
      percentile_cont(0.10) WITHIN GROUP (ORDER BY market_value_eoy) AS p10,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY market_value_eoy) AS p25,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY market_value_eoy) AS p50,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY market_value_eoy) AS p75,
      percentile_cont(0.90) WITHIN GROUP (ORDER BY market_value_eoy) AS p90,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY market_value_eoy) AS p99
    FROM endowments
    WHERE fyear = ${fyear} AND market_value_eoy IS NOT NULL
  `);
  const countRes = await db.execute(sql`
    SELECT
      COUNT(*)::int                                              AS n,
      COUNT(*) FILTER (WHERE market_value_eoy < ${targetValue})::int  AS n_below
    FROM endowments
    WHERE fyear = ${fyear} AND market_value_eoy IS NOT NULL
  `);

  const c = (countRes as any).rows?.[0] ?? { n: 0, n_below: 0 };
  const n = Number(c.n) || 0;
  const nBelow = Number(c.n_below) || 0;
  const percentile = n > 0 ? Math.round((nBelow / n) * 1000) / 10 : null;
  const rank = n - nBelow; // 1 = largest

  return {
    dbReady: true,
    target: resolved.institution,
    fyear,
    targetValueEoy: targetValue,
    universeSize: n,
    rank,
    percentile, // e.g. 98.7 means larger than 98.7% of reporting institutions
    distribution: (breaks as any).rows?.[0] ?? null,
  };
}

export interface EndowmentGrowthHistoryArgs {
  unitid?: number;
  instnm?: string;
}

function cagr(begin: number, end: number, years: number): number | null {
  if (begin == null || end == null || begin <= 0 || years <= 0) return null;
  return Math.round((Math.pow(end / begin, 1 / years) - 1) * 1000) / 10; // percent, 1 decimal
}

/**
 * Full growth analytics for one institution: CAGR over 1/3/5/10-year and
 * all-time windows (using EOY values), plus the best and worst single-year
 * moves and a count of declining years.
 */
export async function endowmentGrowthHistory(args: EndowmentGrowthHistoryArgs) {
  if (!isDbReady()) return { dbReady: false };
  const resolved = await resolveUnitid(args.unitid, args.instnm);
  if (resolved.unitid == null) {
    return { dbReady: true, target: null, candidates: resolved.candidates ?? [], reason: "Institution not found" };
  }
  const unitid = resolved.unitid;

  const rows = await db
    .select({ fyear: endowments.fyear, eoy: endowments.marketValueEoy })
    .from(endowments)
    .where(and(eq(endowments.unitid, unitid), isNotNull(endowments.marketValueEoy)))
    .orderBy(asc(endowments.fyear));

  if (rows.length === 0) {
    return { dbReady: true, target: resolved.institution, reason: "No endowment data" };
  }

  const series = rows.map((r) => ({ fyear: r.fyear, eoy: Number(r.eoy) }));
  const latest = series[series.length - 1]!;
  const earliest = series[0]!;
  const byYear = new Map(series.map((s) => [s.fyear, s.eoy]));

  function cagrOver(years: number): number | null {
    const startYear = latest.fyear - years;
    const startVal = byYear.get(startYear);
    if (startVal == null) return null;
    return cagr(startVal, latest.eoy, years);
  }

  // Year-over-year moves for best/worst/decline count.
  let bestYear: { fyear: number; pct: number } | null = null;
  let worstYear: { fyear: number; pct: number } | null = null;
  let declineYears = 0;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const cur = series[i]!;
    if (prev.eoy <= 0) continue;
    const pct = Math.round(((cur.eoy - prev.eoy) / prev.eoy) * 1000) / 10;
    if (pct < 0) declineYears++;
    if (!bestYear || pct > bestYear.pct) bestYear = { fyear: cur.fyear, pct };
    if (!worstYear || pct < worstYear.pct) worstYear = { fyear: cur.fyear, pct };
  }

  const allTimeYears = latest.fyear - earliest.fyear;

  return {
    dbReady: true,
    target: resolved.institution,
    earliestFyear: earliest.fyear,
    latestFyear: latest.fyear,
    earliestEoy: earliest.eoy,
    latestEoy: latest.eoy,
    yearsTracked: series.length,
    cagr: {
      oneYear: cagrOver(1),
      threeYear: cagrOver(3),
      fiveYear: cagrOver(5),
      tenYear: cagrOver(10),
      allTime: allTimeYears > 0 ? cagr(earliest.eoy, latest.eoy, allTimeYears) : null,
    },
    bestYear,
    worstYear,
    declineYears,
    series,
  };
}

export interface EndowmentDecadeComparisonArgs {
  unitid?: number;
  instnm?: string;
  windowYears?: number; // default 10
}

/**
 * Compare two consecutive N-year windows (default 10) for one institution:
 * the most recent N years vs the N years before that. Returns start/end
 * values, total growth %, and CAGR for each window, plus the delta in CAGR
 * between the two windows (is growth accelerating or decelerating?).
 */
export async function endowmentDecadeComparison(args: EndowmentDecadeComparisonArgs) {
  if (!isDbReady()) return { dbReady: false };
  const resolved = await resolveUnitid(args.unitid, args.instnm);
  if (resolved.unitid == null) {
    return { dbReady: true, target: null, candidates: resolved.candidates ?? [], reason: "Institution not found" };
  }
  const unitid = resolved.unitid;
  const win = args.windowYears ?? 10;

  const rows = await db
    .select({ fyear: endowments.fyear, eoy: endowments.marketValueEoy })
    .from(endowments)
    .where(and(eq(endowments.unitid, unitid), isNotNull(endowments.marketValueEoy)))
    .orderBy(asc(endowments.fyear));

  if (rows.length === 0) {
    return { dbReady: true, target: resolved.institution, reason: "No endowment data" };
  }

  const byYear = new Map(rows.map((r) => [r.fyear, Number(r.eoy)]));
  const latestYear = rows[rows.length - 1]!.fyear;

  const recentEndYear = latestYear;
  const recentStartYear = latestYear - win;
  const priorEndYear = recentStartYear;
  const priorStartYear = recentStartYear - win;

  function windowStats(startYear: number, endYear: number) {
    const startVal = byYear.get(startYear);
    const endVal = byYear.get(endYear);
    if (startVal == null || endVal == null) return null;
    const totalGrowthPct = startVal > 0 ? Math.round(((endVal - startVal) / startVal) * 1000) / 10 : null;
    return {
      startYear,
      endYear,
      startEoy: startVal,
      endEoy: endVal,
      totalGrowthPct,
      cagr: cagr(startVal, endVal, endYear - startYear),
    };
  }

  const recent = windowStats(recentStartYear, recentEndYear);
  const prior = windowStats(priorStartYear, priorEndYear);
  const cagrDelta =
    recent?.cagr != null && prior?.cagr != null
      ? Math.round((recent.cagr - prior.cagr) * 10) / 10
      : null;

  return {
    dbReady: true,
    target: resolved.institution,
    windowYears: win,
    recentWindow: recent,
    priorWindow: prior,
    cagrDeltaPctPoints: cagrDelta, // positive = recent decade grew faster
    interpretation:
      cagrDelta == null
        ? "Insufficient history for both windows"
        : cagrDelta > 0
        ? "Growth accelerating vs prior window"
        : cagrDelta < 0
        ? "Growth decelerating vs prior window"
        : "Growth steady across windows",
  };
}
