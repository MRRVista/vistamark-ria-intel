/**
 * Query handlers for NACUBO public benchmark data.
 *
 * Tools:
 *   nacubo_benchmark_lookup — returns aggregate NCSE/NTSE/NES stats for a
 *                              given fiscal year and cohort
 */

import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { nacuboBenchmarks } from "../db/schema";
import { NACUBO_COHORT_LABELS } from "./data";

function decorate(row: any) {
  if (!row) return row;
  return {
    ...row,
    cohortLabel: NACUBO_COHORT_LABELS[row.cohort] ?? row.cohort,
    assetAllocation: row.assetAllocJson ? safeJson(row.assetAllocJson) : null,
  };
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface NacuboBenchmarkLookupArgs {
  fyear?: number;
  cohort?: string;
  minFyear?: number;
  maxFyear?: number;
  limit?: number;
}

export async function nacuboBenchmarkLookup(args: NacuboBenchmarkLookupArgs) {
  if (!isDbReady()) return { rows: [], dbReady: false };

  const conds: any[] = [];
  if (args.fyear != null) conds.push(eq(nacuboBenchmarks.fyear, args.fyear));
  if (args.cohort) conds.push(eq(nacuboBenchmarks.cohort, args.cohort));
  if (args.minFyear != null) conds.push(gte(nacuboBenchmarks.fyear, args.minFyear));
  if (args.maxFyear != null) conds.push(lte(nacuboBenchmarks.fyear, args.maxFyear));

  const where = conds.length ? and(...conds) : undefined;
  const limit = Math.min(args.limit ?? 50, 500);

  const rows = await db
    .select()
    .from(nacuboBenchmarks)
    .where(where)
    .orderBy(desc(nacuboBenchmarks.fyear), asc(nacuboBenchmarks.cohort))
    .limit(limit);

  return {
    rows: rows.map(decorate),
    cohorts: Object.entries(NACUBO_COHORT_LABELS).map(([code, label]) => ({ code, label })),
    note:
      "NACUBO public benchmarks are FREE aggregate data published in annual NCSE " +
      "press releases and public tables. Institution-specific returns/allocations/spending " +
      "are paywalled by NACUBO ($500/yr).",
    dbReady: true,
  };
}
