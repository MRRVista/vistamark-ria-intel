/**
 * Query handlers for the DOL Form 5500 plans table.
 */

import { and, asc, desc, eq, getTableColumns, gte, ilike, isNotNull, lte, sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { plans } from "../db/schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { PLAN_ENTITY_TYPE } from "./columns";
import { schHTableExists } from "./schedule-h";

/**
 * Since the 2024 FOIA files F_5500 no longer carries TOT_ASSETS / NET_ASSETS
 * (null in `plans`); totals live on Schedule H/I (dol_sch_h_i, migration 0010).
 * When that table exists we LEFT JOIN it and COALESCE; before migration 0010
 * the queries run unchanged against `plans` alone.
 */
const SHI = sql`dol_sch_h_i shi`;
const SHI_ON = sql`shi.ack_id = ${plans.ackId}`;
const num = (v: unknown) => (v == null ? null : Number(v)); // bigint arrives as string from the driver
function assetCols(useShi: boolean) {
  const col = (p: AnyPgColumn, shiCol: string) =>
    (useShi ? sql<number | null>`COALESCE(${p}, ${sql.raw(`shi.${shiCol}`)})` : sql<number | null>`${p}`).mapWith(num);
  return {
    totAssetsEoy: col(plans.totAssetsEoyAmt, "tot_assets_eoy_amt"),
    totAssetsBoy: col(plans.totAssetsBoyAmt, "tot_assets_boy_amt"),
    netAssetsEoy: col(plans.netAssetsEoyAmt, "net_assets_eoy_amt"),
    netAssetsBoy: col(plans.netAssetsBoyAmt, "net_assets_boy_amt"),
  };
}

function decorate(row: any) {
  if (!row) return row;
  return {
    ...row,
    planTypeLabel: row.typePlanEntityCd != null ? PLAN_ENTITY_TYPE[row.typePlanEntityCd] ?? null : null,
  };
}

export interface DolPlanSearchArgs {
  sponsorName?: string;
  sponsorEin?: string;
  state?: string;
  city?: string;
  planYear?: number;
  planType?: number;
  is401k?: boolean;
  isDefinedBenefit?: boolean;
  minAssetsEoy?: number;
  maxAssetsEoy?: number;
  minActiveParticipants?: number;
  hasScheduleH?: boolean;
  hasScheduleC?: boolean;
  sortBy?: "assets_eoy" | "assets_boy" | "active_participants" | "plan_year" | "sponsor_name";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function dolPlanSearch(args: DolPlanSearchArgs) {
  if (!isDbReady()) return { rows: [], total: 0, dbReady: false };
  const useShi = await schHTableExists();
  const ac = assetCols(useShi);
  const conds = [];
  if (args.sponsorName) conds.push(ilike(plans.sponsDfeName, `%${args.sponsorName}%`));
  if (args.sponsorEin) conds.push(eq(plans.sponsDfeEin, args.sponsorEin.replace(/\D/g, "")));
  if (args.state) conds.push(eq(plans.sponsDfeMailState, args.state.toUpperCase()));
  if (args.city) conds.push(ilike(plans.sponsDfeMailCity, args.city));
  if (args.planYear != null) conds.push(eq(plans.planYear, args.planYear));
  if (args.planType != null) conds.push(eq(plans.typePlanEntityCd, args.planType));
  // Form 5500 pension feature code 2J = "Code section 401(k) feature".
  // (2C is the MONEY PURCHASE plan code — the previous filter matched the wrong code.)
  if (args.is401k) conds.push(ilike(plans.pensionPlanFeatureCodes, "%2J%"));
  if (args.isDefinedBenefit) {
    // Defined-benefit pension feature codes are 1A–1I (pay-related, flat-dollar,
    // cash balance, floor-offset, 401(h), 414(k), PBGC-covered, PBGC-terminated,
    // frozen). The previous pattern (3[DEFGH]) matched unrelated "other
    // characteristics" codes.
    conds.push(sql`${plans.pensionPlanFeatureCodes} ~ '1[A-I]'`);
  }
  if (args.minAssetsEoy != null) conds.push(gte(ac.totAssetsEoy, args.minAssetsEoy));
  if (args.maxAssetsEoy != null) conds.push(lte(ac.totAssetsEoy, args.maxAssetsEoy));
  if (args.minActiveParticipants != null) conds.push(gte(plans.totActivePartcpCnt, args.minActiveParticipants));
  if (args.hasScheduleH === true) conds.push(eq(plans.schHAttachedInd, true));
  if (args.hasScheduleC === true) conds.push(eq(plans.schCAttachedInd, true));

  const sortDir = args.sortDir === "asc" ? asc : desc;
  const sortCol = {
    assets_eoy: ac.totAssetsEoy,
    assets_boy: ac.totAssetsBoy,
    active_participants: plans.totActivePartcpCnt,
    plan_year: plans.planYear,
    sponsor_name: plans.sponsDfeName,
  }[args.sortBy ?? "assets_eoy"];

  const finalConds = [...conds];
  if (args.sortBy !== "sponsor_name") finalConds.push(isNotNull(sortCol));
  const finalWhere = finalConds.length ? and(...finalConds) : undefined;
  const where = conds.length ? and(...conds) : undefined;

  const limit = Math.min(args.limit ?? 50, 500);
  const offset = args.offset ?? 0;

  let q = db
    .select({
      ackId: plans.ackId,
      planName: plans.planName,
      sponsDfeName: plans.sponsDfeName,
      sponsDfeEin: plans.sponsDfeEin,
      sponsDfePn: plans.sponsDfePn,
      city: plans.sponsDfeMailCity,
      state: plans.sponsDfeMailState,
      zip: plans.sponsDfeMailZip,
      planYear: plans.planYear,
      typePlanEntityCd: plans.typePlanEntityCd,
      totActivePartcpCnt: plans.totActivePartcpCnt,
      totPartcpBoyCnt: plans.totPartcpBoyCnt,
      totAssetsBoyAmt: ac.totAssetsBoy,
      totAssetsEoyAmt: ac.totAssetsEoy,
      netAssetsEoyAmt: ac.netAssetsEoy,
      pensionPlanFeatureCodes: plans.pensionPlanFeatureCodes,
      schHAttachedInd: plans.schHAttachedInd,
      schCAttachedInd: plans.schCAttachedInd,
      adminName: plans.adminName,
    })
    .from(plans)
    .$dynamic();
  if (useShi) q = q.leftJoin(SHI, SHI_ON);
  const rows = await q.where(finalWhere).orderBy(sortDir(sortCol)).limit(limit).offset(offset);

  let tq = db.select({ count: sql<number>`count(*)::int` }).from(plans).$dynamic();
  if (useShi) tq = tq.leftJoin(SHI, SHI_ON);
  const totalRes = await tq.where(where);

  return {
    rows: rows.map(decorate),
    total: totalRes[0]?.count ?? 0,
    dbReady: true,
  };
}

export interface DolPlanLookupArgs {
  ackId?: string;
  sponsorEin?: string;
  planNumber?: string;
  planYear?: number;
}

export async function dolPlanLookup(args: DolPlanLookupArgs) {
  if (!isDbReady()) return { row: null, dbReady: false };
  const useShi = await schHTableExists();
  const ac = assetCols(useShi);
  // Fill the four asset totals from Schedule H/I when F_5500 left them null.
  const withAssets = (r: any) =>
    r && useShi ? { ...r, totAssetsBoyAmt: r.__boy, totAssetsEoyAmt: r.__eoy, netAssetsBoyAmt: r.__nboy, netAssetsEoyAmt: r.__neoy, __boy: undefined, __eoy: undefined, __nboy: undefined, __neoy: undefined } : r;
  const sel = useShi
    ? db.select({ ...getTableColumns(plans), __boy: ac.totAssetsBoy, __eoy: ac.totAssetsEoy, __nboy: ac.netAssetsBoy, __neoy: ac.netAssetsEoy }).from(plans).$dynamic().leftJoin(SHI, SHI_ON)
    : db.select().from(plans).$dynamic();
  if (args.ackId) {
    const rows = await sel.where(eq(plans.ackId, args.ackId));
    return { row: rows[0] ? decorate(withAssets(rows[0])) : null, dbReady: true };
  }
  if (args.sponsorEin && args.planNumber) {
    const conds = [
      eq(plans.sponsDfeEin, args.sponsorEin.replace(/\D/g, "")),
      eq(plans.sponsDfePn, args.planNumber.padStart(3, "0")),
    ];
    if (args.planYear != null) conds.push(eq(plans.planYear, args.planYear));
    const rows = await sel
      .where(and(...conds))
      .orderBy(desc(plans.planYear))
      .limit(args.planYear != null ? 1 : 50);
    return { rows: rows.map((r: any) => decorate(withAssets(r))), dbReady: true };
  }
  throw new Error("dol_plan_lookup requires either ackId or (sponsorEin + planNumber)");
}
