/**
 * Query handlers for SEC Form 13F institutional holdings.
 *
 * Tools:
 *   holdings_by_manager  — given a manager name (fuzzy), return their most
 *                          recent filing's positions, sorted by value. Answers
 *                          "what does institution X hold?"
 *   holders_of_security  — given a CUSIP or issuer name, return which managers
 *                          hold it and how much. Answers "who owns Y?" — the
 *                          crowding / smart-money view.
 *
 * Holdings are only present for managers/periods that have actually been
 * ingested (ingest is targeted by manager filter), so these tools operate over
 * whatever subset Matt has loaded, not the entire 13F universe.
 */

import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { f13fFilings, f13fHoldings } from "../db/schema";

export interface HoldingsByManagerArgs {
  managerName?: string;
  cik?: string;
  periodOfReport?: string; // YYYY-MM-DD; defaults to manager's latest
  limit?: number;
  minValueUsd?: number;
}

export async function holdingsByManager(args: HoldingsByManagerArgs) {
  if (!isDbReady()) return { dbReady: false };
  if (!args.managerName && !args.cik) {
    throw new Error("holdings_by_manager requires managerName or cik");
  }

  // Resolve the target filing: most recent period for the matched manager,
  // unless an explicit period is supplied.
  const filingConds: any[] = [];
  if (args.cik) filingConds.push(eq(f13fFilings.cik, args.cik));
  if (args.managerName) {
    filingConds.push(ilike(f13fFilings.filingManagerName, `%${args.managerName}%`));
  }
  if (args.periodOfReport) {
    filingConds.push(eq(f13fFilings.periodOfReport, args.periodOfReport));
  }

  const candidate = await db
    .select({
      accessionNumber: f13fFilings.accessionNumber,
      cik: f13fFilings.cik,
      managerName: f13fFilings.filingManagerName,
      city: f13fFilings.filingManagerCity,
      state: f13fFilings.filingManagerState,
      periodOfReport: f13fFilings.periodOfReport,
      filingDate: f13fFilings.filingDate,
      tableValueTotalUsd: f13fFilings.tableValueTotalUsd,
      tableEntryTotal: f13fFilings.tableEntryTotal,
      submissionType: f13fFilings.submissionType,
    })
    .from(f13fFilings)
    .where(and(...filingConds))
    .orderBy(desc(f13fFilings.periodOfReport), desc(f13fFilings.filingDate))
    .limit(1);

  if (candidate.length === 0) {
    return { dbReady: true, filing: null, holdings: [], reason: "No matching filing ingested" };
  }
  const filing = candidate[0]!;

  const holdConds: any[] = [eq(f13fHoldings.accessionNumber, filing.accessionNumber)];
  if (args.minValueUsd != null) {
    holdConds.push(sql`${f13fHoldings.valueUsd} >= ${args.minValueUsd}`);
  }
  const limit = Math.min(args.limit ?? 100, 1000);

  const holdings = await db
    .select({
      nameOfIssuer: f13fHoldings.nameOfIssuer,
      titleOfClass: f13fHoldings.titleOfClass,
      cusip: f13fHoldings.cusip,
      valueUsd: f13fHoldings.valueUsd,
      sshPrnamt: f13fHoldings.sshPrnamt,
      sshPrnamtType: f13fHoldings.sshPrnamtType,
      putCall: f13fHoldings.putCall,
      investmentDiscretion: f13fHoldings.investmentDiscretion,
    })
    .from(f13fHoldings)
    .where(and(...holdConds))
    .orderBy(desc(f13fHoldings.valueUsd))
    .limit(limit);

  const totalRes = await db
    .select({
      positions: sql<number>`count(*)::int`,
      totalValueUsd: sql<number>`coalesce(sum(${f13fHoldings.valueUsd}),0)::bigint`,
    })
    .from(f13fHoldings)
    .where(eq(f13fHoldings.accessionNumber, filing.accessionNumber));

  return {
    dbReady: true,
    filing,
    positionsInFiling: totalRes[0]?.positions ?? 0,
    totalValueUsd: totalRes[0]?.totalValueUsd ?? 0,
    holdings,
    note:
      "VALUE normalized to whole USD (pre-2023 filings were in thousands; corrected here).",
  };
}

export interface HoldersOfSecurityArgs {
  cusip?: string;
  issuerContains?: string;
  periodOfReport?: string;
  limit?: number;
  minValueUsd?: number;
}

export async function holdersOfSecurity(args: HoldersOfSecurityArgs) {
  if (!isDbReady()) return { dbReady: false };
  if (!args.cusip && !args.issuerContains) {
    throw new Error("holders_of_security requires cusip or issuerContains");
  }

  const conds: any[] = [];
  if (args.cusip) conds.push(eq(f13fHoldings.cusip, args.cusip.toUpperCase()));
  if (args.issuerContains) {
    conds.push(ilike(f13fHoldings.nameOfIssuer, `%${args.issuerContains}%`));
  }
  if (args.periodOfReport) {
    conds.push(eq(f13fHoldings.periodOfReport, args.periodOfReport));
  }
  if (args.minValueUsd != null) {
    conds.push(sql`${f13fHoldings.valueUsd} >= ${args.minValueUsd}`);
  }
  const limit = Math.min(args.limit ?? 100, 1000);

  // Join holdings to filings to attach the manager name. One row per
  // (manager filing, security position).
  const rows = await db
    .select({
      managerName: f13fFilings.filingManagerName,
      cik: f13fFilings.cik,
      periodOfReport: f13fHoldings.periodOfReport,
      nameOfIssuer: f13fHoldings.nameOfIssuer,
      titleOfClass: f13fHoldings.titleOfClass,
      cusip: f13fHoldings.cusip,
      valueUsd: f13fHoldings.valueUsd,
      sshPrnamt: f13fHoldings.sshPrnamt,
      putCall: f13fHoldings.putCall,
    })
    .from(f13fHoldings)
    .innerJoin(f13fFilings, eq(f13fFilings.accessionNumber, f13fHoldings.accessionNumber))
    .where(and(...conds))
    .orderBy(desc(f13fHoldings.valueUsd))
    .limit(limit);

  const agg = await db
    .select({
      holders: sql<number>`count(distinct ${f13fFilings.cik})::int`,
      positions: sql<number>`count(*)::int`,
      totalValueUsd: sql<number>`coalesce(sum(${f13fHoldings.valueUsd}),0)::bigint`,
    })
    .from(f13fHoldings)
    .innerJoin(f13fFilings, eq(f13fFilings.accessionNumber, f13fHoldings.accessionNumber))
    .where(and(...conds));

  return {
    dbReady: true,
    distinctHolders: agg[0]?.holders ?? 0,
    totalPositions: agg[0]?.positions ?? 0,
    aggregateValueUsd: agg[0]?.totalValueUsd ?? 0,
    rows,
    note:
      "Crowding view across ingested 13F filings only. VALUE normalized to whole USD.",
  };
}
