/**
 * Query handlers for IPEDS endowment data.
 *
 * Tools:
 *   endowment_lookup    — single (UNITID, FY) or full history for one institution
 *   endowment_history   — alias for time-series view
 *   endowment_search    — filter by state/sector/control/size band, sorted
 *   endowment_peer_set  — for a target institution, find N closest by endowment size
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
      contributions: endowments.contributions,
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
