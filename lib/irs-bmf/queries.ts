/**
 * Query handlers for the IRS EO BMF dataset stored in the `nonprofits` table.
 *
 * Tools:
 *   irs_eo_lookup — single-EIN fetch (fast PK lookup)
 *   irs_eo_search — multi-filter search (name fuzzy, state, subsection,
 *                  NTEE prefix, asset/income bands, revenue floor)
 */

import { and, asc, desc, eq, gte, ilike, isNotNull, lte, sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { nonprofits } from "../db/schema";
import {
  ASSET_INCOME_RANGE,
  DEDUCTIBILITY_CODE,
  FOUNDATION_CODE,
  STATUS_CODE,
  SUBSECTION_LABEL,
} from "./columns";

function decorate(row: any) {
  if (!row) return row;
  return {
    ...row,
    subsectionLabel: row.subsection != null ? SUBSECTION_LABEL[row.subsection] ?? null : null,
    foundationLabel: row.foundation != null ? FOUNDATION_CODE[row.foundation] ?? null : null,
    deductibilityLabel:
      row.deductibility != null ? DEDUCTIBILITY_CODE[row.deductibility] ?? null : null,
    statusLabel: row.statusCode != null ? STATUS_CODE[row.statusCode] ?? null : null,
    assetRange: row.assetCode != null ? ASSET_INCOME_RANGE[row.assetCode] ?? null : null,
    incomeRange: row.incomeCode != null ? ASSET_INCOME_RANGE[row.incomeCode] ?? null : null,
  };
}

export interface IrsEoLookupArgs {
  ein: string | number;
}

export async function irsEoLookup(args: IrsEoLookupArgs) {
  if (!isDbReady()) return { row: null, dbReady: false };
  if (args.ein == null) throw new Error("irs_eo_lookup requires `ein`");
  const ein = String(args.ein).replace(/\D/g, "").padStart(9, "0");
  if (ein.length !== 9) throw new Error(`Invalid EIN: ${args.ein}`);
  const rows = await db.select().from(nonprofits).where(eq(nonprofits.ein, ein));
  return { row: rows[0] ? decorate(rows[0]) : null, dbReady: true };
}

export interface IrsEoSearchArgs {
  name?: string;
  state?: string;
  subsection?: number;
  nteeCodePrefix?: string;
  city?: string;
  minAssetCode?: number;
  minIncomeCode?: number;
  minAssetAmt?: number;
  maxAssetAmt?: number;
  minRevenueAmt?: number;
  foundationCode?: number;
  sortBy?: "asset_amt" | "income_amt" | "revenue_amt" | "name";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function irsEoSearch(args: IrsEoSearchArgs) {
  if (!isDbReady()) return { rows: [], total: 0, dbReady: false };
  const conds = [];
  if (args.name) conds.push(ilike(nonprofits.name, `%${args.name}%`));
  if (args.state) conds.push(eq(nonprofits.state, args.state.toUpperCase()));
  if (args.subsection != null) conds.push(eq(nonprofits.subsection, args.subsection));
  if (args.nteeCodePrefix) {
    conds.push(ilike(nonprofits.nteeCode, `${args.nteeCodePrefix.toUpperCase()}%`));
  }
  if (args.city) conds.push(ilike(nonprofits.city, args.city));
  if (args.minAssetCode != null) conds.push(gte(nonprofits.assetCode, args.minAssetCode));
  if (args.minIncomeCode != null) conds.push(gte(nonprofits.incomeCode, args.minIncomeCode));
  if (args.minAssetAmt != null) conds.push(gte(nonprofits.assetAmt, args.minAssetAmt));
  if (args.maxAssetAmt != null) conds.push(lte(nonprofits.assetAmt, args.maxAssetAmt));
  if (args.minRevenueAmt != null) conds.push(gte(nonprofits.revenueAmt, args.minRevenueAmt));
  if (args.foundationCode != null) conds.push(eq(nonprofits.foundation, args.foundationCode));

  const where = conds.length ? and(...conds) : undefined;
  const sortDir = args.sortDir === "asc" ? asc : desc;
  const sortCol = {
    asset_amt: nonprofits.assetAmt,
    income_amt: nonprofits.incomeAmt,
    revenue_amt: nonprofits.revenueAmt,
    name: nonprofits.name,
  }[args.sortBy ?? "asset_amt"];

  const finalConds = [...conds];
  if (args.sortBy !== "name") finalConds.push(isNotNull(sortCol));
  const finalWhere = finalConds.length ? and(...finalConds) : undefined;

  const limit = Math.min(args.limit ?? 50, 500);
  const offset = args.offset ?? 0;

  const rows = await db
    .select({
      ein: nonprofits.ein,
      name: nonprofits.name,
      city: nonprofits.city,
      state: nonprofits.state,
      zip: nonprofits.zip,
      subsection: nonprofits.subsection,
      foundation: nonprofits.foundation,
      deductibility: nonprofits.deductibility,
      statusCode: nonprofits.statusCode,
      nteeCode: nonprofits.nteeCode,
      assetCode: nonprofits.assetCode,
      incomeCode: nonprofits.incomeCode,
      assetAmt: nonprofits.assetAmt,
      incomeAmt: nonprofits.incomeAmt,
      revenueAmt: nonprofits.revenueAmt,
      taxPeriod: nonprofits.taxPeriod,
    })
    .from(nonprofits)
    .where(finalWhere)
    .orderBy(sortDir(sortCol))
    .limit(limit)
    .offset(offset);

  const totalRes = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(nonprofits)
    .where(where);

  return {
    rows: rows.map(decorate),
    total: totalRes[0]?.count ?? 0,
    dbReady: true,
  };
}
