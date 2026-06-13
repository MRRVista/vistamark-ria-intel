/**
 * Query handlers for SBA PPP loan data.
 *
 * Tools:
 *   ppp_search  — filter loans by state / borrower name / amount range /
 *                 NAICS / business type / nonprofit flag / loan status, sorted
 *   ppp_lookup  — a specific loan_number, or all loans for a borrower (fuzzy name)
 */

import { and, asc, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { pppLoans } from "../db/schema";

export interface PppSearchArgs {
  state?: string;
  nameContains?: string;
  minAmount?: number;
  maxAmount?: number;
  naicsCode?: string;
  naicsPrefix?: string;
  businessType?: string;
  nonprofitOnly?: boolean;
  loanStatus?: string;
  city?: string;
  sortBy?: "current_approval_amount" | "initial_approval_amount" | "forgiveness_amount" | "jobs_reported" | "name" | "date_approved";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function pppSearch(args: PppSearchArgs) {
  if (!isDbReady()) return { rows: [], total: 0, dbReady: false };

  const conds: any[] = [];
  if (args.state) conds.push(eq(pppLoans.borrowerState, args.state.toUpperCase()));
  if (args.city) conds.push(ilike(pppLoans.borrowerCity, `%${args.city}%`));
  if (args.nameContains) conds.push(ilike(pppLoans.borrowerName, `%${args.nameContains}%`));
  if (args.minAmount != null) conds.push(gte(pppLoans.currentApprovalAmount, args.minAmount));
  if (args.maxAmount != null) conds.push(lte(pppLoans.currentApprovalAmount, args.maxAmount));
  if (args.naicsCode) conds.push(eq(pppLoans.naicsCode, args.naicsCode));
  if (args.naicsPrefix) conds.push(ilike(pppLoans.naicsCode, `${args.naicsPrefix}%`));
  if (args.businessType) conds.push(ilike(pppLoans.businessType, `%${args.businessType}%`));
  if (args.nonprofitOnly) conds.push(eq(pppLoans.nonprofitFlag, true));
  if (args.loanStatus) conds.push(ilike(pppLoans.loanStatus, `%${args.loanStatus}%`));

  const sortDir = args.sortDir === "asc" ? asc : desc;
  const sortCol = {
    current_approval_amount: pppLoans.currentApprovalAmount,
    initial_approval_amount: pppLoans.initialApprovalAmount,
    forgiveness_amount: pppLoans.forgivenessAmount,
    jobs_reported: pppLoans.jobsReported,
    name: pppLoans.borrowerName,
    date_approved: pppLoans.dateApproved,
  }[args.sortBy ?? "current_approval_amount"];

  const limit = Math.min(args.limit ?? 50, 500);
  const offset = args.offset ?? 0;
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db
    .select()
    .from(pppLoans)
    .where(where)
    .orderBy(sortDir(sortCol))
    .limit(limit)
    .offset(offset);

  const totalRes = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pppLoans)
    .where(where);

  return {
    rows,
    total: totalRes[0]?.count ?? 0,
    dbReady: true,
  };
}

export interface PppLookupArgs {
  loanNumber?: string;
  borrowerName?: string;
  state?: string;
  limit?: number;
}

export async function pppLookup(args: PppLookupArgs) {
  if (!isDbReady()) return { rows: [], dbReady: false };

  if (args.loanNumber) {
    const rows = await db
      .select()
      .from(pppLoans)
      .where(eq(pppLoans.loanNumber, args.loanNumber))
      .limit(1);
    return { loan: rows[0] ?? null, dbReady: true };
  }

  if (args.borrowerName) {
    const conds: any[] = [ilike(pppLoans.borrowerName, `%${args.borrowerName}%`)];
    if (args.state) conds.push(eq(pppLoans.borrowerState, args.state.toUpperCase()));
    const limit = Math.min(args.limit ?? 25, 200);
    const rows = await db
      .select()
      .from(pppLoans)
      .where(and(...conds))
      .orderBy(desc(pppLoans.currentApprovalAmount))
      .limit(limit);
    return { rows, matchedOn: "borrowerName", dbReady: true };
  }

  throw new Error("ppp_lookup requires loanNumber or borrowerName");
}
