/**
 * DOL 5500 Schedule H/I family — plan financial statements and asset mix from
 * Postgres dol_sch_h_i (migration 0010, loaded by api/admin/refresh-dol-sch-h).
 *
 *   dol_plan_financials    — full H/I financial block + asset-mix % for one or a few plans
 *   dol_plans_by_asset_mix — screen plans by state / size / asset-class share (targeting)
 *   dol_sch_h_status       — row counts by year + schedule, last ingest runs
 *
 * All three are guarded: before migration 0010 they return {empty:true} with an
 * ingest hint instead of throwing. Sponsor name / state come from `plans`
 * (lib/db/schema.ts) via LEFT JOIN on ack_id, so they are null for years where
 * refresh-dol-5500 has not run.
 */
import { sql, type SQL } from "drizzle-orm";
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { db, isDbReady } from "../db";
import { schHTableExists } from "../dol-5500/schedule-h";

const DS = "DOL Form 5500 Schedule H (large plans) / Schedule I (small plans), EBSA FOIA bulk files → Postgres dol_sch_h_i ⋈ plans";

function rowsOf(r: any): any[] {
  return (r?.rows ?? r) as any[];
}
function n(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
function pct(part: unknown, total: unknown): number | null {
  const p = n(part);
  const t = n(total);
  if (p == null || t == null || t <= 0) return null;
  return Math.round((p / t) * 1000) / 10;
}

async function guard(): Promise<any | null> {
  if (!isDbReady()) return { dataSource: DS, empty: true, note: "DATABASE_URL not configured." };
  if (!(await schHTableExists())) {
    return {
      dataSource: DS,
      empty: true,
      note: "Table dol_sch_h_i does not exist yet (migration 0010 not applied). Run POST /api/admin/migrate, then POST /api/admin/refresh-dol-sch-h?year=YYYY with Bearer CRON_SECRET. Until then dol_plan_search works but its asset filters return nothing for 2024+.",
    };
  }
  return null;
}

/** Asset-class buckets (EOY) an adviser screens on. Keys = column names. */
const ASSET_CLASSES: Record<string, { label: string; cols: string[] }> = {
  cash: { label: "Cash (interest + non-interest bearing)", cols: ["non_int_bear_cash_eoy_amt", "int_bear_cash_eoy_amt"] },
  govt_sec: { label: "US government securities", cols: ["govt_sec_eoy_amt"] },
  corp_debt: { label: "Corporate debt", cols: ["corp_debt_preferred_eoy_amt", "corp_debt_other_eoy_amt"] },
  stock: { label: "Direct stock holdings (common + preferred)", cols: ["common_stock_eoy_amt", "pref_stock_eoy_amt"] },
  mutual_funds: { label: "Registered investment companies (mutual funds)", cols: ["int_reg_invst_co_eoy_amt"] },
  cct: { label: "Common/collective trusts", cols: ["int_common_tr_eoy_amt"] },
  psa: { label: "Pooled separate accounts (insurance)", cols: ["int_pool_sep_acct_eoy_amt"] },
  master_trust: { label: "Master trust investment accounts", cols: ["int_master_tr_eoy_amt"] },
  entity_103_12: { label: "103-12 investment entities", cols: ["int_103_12_invst_eoy_amt"] },
  ins_general_acct: { label: "Insurance company general account", cols: ["ins_co_gen_acct_eoy_amt"] },
  employer_securities: { label: "Employer securities", cols: ["emplr_sec_eoy_amt"] },
  employer_property: { label: "Employer real property", cols: ["emplr_prop_eoy_amt"] },
  real_estate: { label: "Real estate (investment)", cols: ["real_estate_eoy_amt"] },
  partnerships: { label: "Partnership / joint venture interests", cols: ["joint_venture_eoy_amt"] },
  participant_loans: { label: "Participant loans", cols: ["partcp_loans_eoy_amt"] },
  other_loans: { label: "Other loans / mortgages", cols: ["other_loans_eoy_amt"] },
  other: { label: "Other investments", cols: ["oth_invst_eoy_amt"] },
};
const ASSET_CLASS_KEYS = Object.keys(ASSET_CLASSES);

function classExpr(key: string): SQL {
  const cols = ASSET_CLASSES[key]!.cols;
  return sql.raw(`(${cols.map((c) => `COALESCE(s.${c},0)`).join(" + ")})`);
}

function shapeFinancials(r: any) {
  const tot = n(r.tot_assets_eoy_amt);
  const mix: Record<string, { usd: number; pct: number | null }> = {};
  if (r.schedule === "H") {
    for (const k of ASSET_CLASS_KEYS) {
      const usd = ASSET_CLASSES[k]!.cols.reduce((a, c) => a + (n(r[c]) ?? 0), 0);
      if (usd !== 0) mix[k] = { usd, pct: pct(usd, tot) };
    }
  } else {
    for (const k of ["employer_securities", "employer_property", "real_estate", "partnerships", "participant_loans", "other_loans"]) {
      const usd = ASSET_CLASSES[k]!.cols.reduce((a, c) => a + (n(r[c]) ?? 0), 0);
      if (usd !== 0) mix[k] = { usd, pct: pct(usd, tot) };
    }
  }
  const contrib = n(r.tot_contrib_amt);
  return {
    ackId: r.ack_id,
    schedule: r.schedule,
    filingYear: r.filing_year,
    planYearBegin: r.plan_year_begin_date,
    planYearEnd: r.tax_prd,
    ein: r.ein,
    pn: r.pn,
    planName: r.plan_name ?? null,
    sponsor: r.spons_dfe_name ?? null,
    location: [r.spons_dfe_mail_city, r.spons_dfe_mail_state].filter(Boolean).join(", ") || null,
    activeParticipants: r.tot_active_partcp_cnt ?? null,
    balanceSheet: {
      totalAssetsBoy: n(r.tot_assets_boy_amt),
      totalAssetsEoy: tot,
      totalLiabilitiesEoy: n(r.tot_liabilities_eoy_amt),
      netAssetsEoy: n(r.net_assets_eoy_amt),
      netAssetsBoy: n(r.net_assets_boy_amt),
      assetGrowthPct: pct((tot ?? 0) - (n(r.tot_assets_boy_amt) ?? 0), r.tot_assets_boy_amt),
    },
    incomeStatement: {
      employerContributions: n(r.emplr_contrib_income_amt),
      participantContributions: n(r.participant_contrib_amt),
      otherContributions: n(r.oth_contrib_rcvd_amt),
      totalContributions: contrib,
      netInvestmentGain: n(r.net_invst_gain_amt),
      netInvestmentReturnPct: pct(r.net_invst_gain_amt, r.tot_assets_boy_amt),
      totalIncome: n(r.tot_income_amt),
      benefitsPaid: n(r.tot_distrib_bnft_amt),
      adminExpenses: n(r.tot_admin_expenses_amt),
      investmentMgmtFees: n(r.invst_mgmt_fees_amt),
      adminExpenseBps: tot && n(r.tot_admin_expenses_amt) != null ? Math.round((Number(r.tot_admin_expenses_amt) / tot) * 10000) : null,
      totalExpenses: n(r.tot_expenses_amt),
      netIncome: n(r.net_income_amt),
    },
    assetMix: mix,
    serviceProviders: {
      auditor: r.accountant_firm_name ?? null,
      auditOpinion: r.acctnt_opinion_type_cd != null ? ({ "1": "unqualified", "2": "qualified", "3": "disclaimer", "4": "adverse" } as any)[String(r.acctnt_opinion_type_cd)] ?? r.acctnt_opinion_type_cd : null,
      trustee: r.fdcry_trust_name ?? null,
      trusteeCustodian: r.fdcry_trustee_cust_name ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// dol_plan_financials
// ---------------------------------------------------------------------------

export interface PlanFinancialsArgs {
  ackId?: string;
  ein?: string;
  sponsorName?: string;
  state?: string;
  filingYear?: number;
  limit?: number;
}

export async function dolPlanFinancials(args: PlanFinancialsArgs) {
  const g = await guard();
  if (g) return g;
  if (!args.ackId && !args.ein && !args.sponsorName) {
    return { dataSource: DS, error: "Provide ackId, ein (sponsor EIN), or sponsorName (optionally + state).", plans: [] };
  }
  const limit = Math.max(1, Math.min(args.limit ?? 3, 10));
  const conds: SQL[] = [];
  if (args.ackId) conds.push(sql`s.ack_id = ${args.ackId.trim()}`);
  if (args.ein) conds.push(sql`s.ein = ${args.ein.replace(/\D/g, "")}`);
  if (args.sponsorName) {
    const like = `%${args.sponsorName.trim()}%`;
    conds.push(sql`(pl.spons_dfe_name ILIKE ${like} OR pl.plan_name ILIKE ${like})`);
  }
  if (args.state) conds.push(sql`pl.spons_dfe_mail_state = ${args.state.toUpperCase()}`);
  if (args.filingYear) conds.push(sql`s.filing_year = ${args.filingYear}`);
  const rows = rowsOf(
    await db.execute(sql`
      SELECT s.*, pl.plan_name, pl.spons_dfe_name, pl.spons_dfe_mail_city, pl.spons_dfe_mail_state, pl.tot_active_partcp_cnt
      FROM dol_sch_h_i s LEFT JOIN plans pl ON pl.ack_id = s.ack_id
      WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY s.tot_assets_eoy_amt DESC NULLS LAST, s.filing_year DESC
      LIMIT ${limit}`)
  );
  if (!rows.length) {
    const any = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM dol_sch_h_i`))[0]?.n ?? 0;
    if (!any) return { dataSource: DS, empty: true, note: "dol_sch_h_i is empty — POST /api/admin/refresh-dol-sch-h?year=YYYY has not run." };
    return { dataSource: DS, plans: [], note: "No Schedule H/I row matched. sponsorName/state need the plans table loaded for the same year (refresh-dol-5500); try ackId from dol_plan_search or the sponsor EIN." };
  }
  return {
    dataSource: DS,
    returned: rows.length,
    plans: rows.map(shapeFinancials),
    note:
      "USD for the plan year. Schedule H = 100+ participant plans (full asset-class breakdown, audited); Schedule I = small plans (totals + a few flagged asset types only). assetMix pct = share of total assets EOY. netInvestmentGain = total income − total contributions (includes unrealized appreciation). adminExpenseBps = admin expenses / total assets × 10,000.",
  };
}

// ---------------------------------------------------------------------------
// dol_plans_by_asset_mix
// ---------------------------------------------------------------------------

export interface PlansByAssetMixArgs {
  state?: string;
  city?: string;
  filingYear?: number;
  schedule?: "H" | "I";
  minAssets?: number;
  maxAssets?: number;
  assetClass?: string;
  minSharePct?: number;
  maxSharePct?: number;
  minAmount?: number;
  minAdminExpenseBps?: number;
  sortBy?: "assets" | "share" | "amount" | "admin_bps" | "net_return";
  limit?: number;
  offset?: number;
}

export async function dolPlansByAssetMix(args: PlansByAssetMixArgs) {
  const g = await guard();
  if (g) return g;
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const offset = Math.max(0, args.offset ?? 0);
  const cls = args.assetClass ? args.assetClass.toLowerCase() : null;
  if (cls && !ASSET_CLASSES[cls]) {
    return { dataSource: DS, error: `Unknown assetClass '${args.assetClass}'. One of: ${ASSET_CLASS_KEYS.join(", ")}`, rows: [] };
  }
  const classAmt = cls ? classExpr(cls) : sql`NULL::bigint`;
  const classShare = cls ? sql`CASE WHEN s.tot_assets_eoy_amt > 0 THEN ${classAmt}::numeric * 100 / s.tot_assets_eoy_amt END` : sql`NULL::numeric`;
  const adminBps = sql`CASE WHEN s.tot_assets_eoy_amt > 0 THEN s.tot_admin_expenses_amt::numeric * 10000 / s.tot_assets_eoy_amt END`;
  const netRet = sql`CASE WHEN s.tot_assets_boy_amt > 0 THEN s.net_invst_gain_amt::numeric * 100 / s.tot_assets_boy_amt END`;

  const conds: SQL[] = [sql`s.tot_assets_eoy_amt > 0`];
  const needPlans = !!(args.state || args.city);
  if (args.state) conds.push(sql`pl.spons_dfe_mail_state = ${args.state.toUpperCase()}`);
  if (args.city) conds.push(sql`pl.spons_dfe_mail_city ILIKE ${args.city}`);
  if (args.filingYear) conds.push(sql`s.filing_year = ${args.filingYear}`);
  if (args.schedule) conds.push(sql`s.schedule = ${args.schedule.toUpperCase()}`);
  else if (cls && !["employer_securities", "employer_property", "real_estate", "partnerships", "participant_loans", "other_loans"].includes(cls)) {
    conds.push(sql`s.schedule = 'H'`); // class only reported on Sch H
  }
  if (args.minAssets != null) conds.push(sql`s.tot_assets_eoy_amt >= ${args.minAssets}`);
  if (args.maxAssets != null) conds.push(sql`s.tot_assets_eoy_amt <= ${args.maxAssets}`);
  if (cls && args.minSharePct != null) conds.push(sql`${classShare} >= ${args.minSharePct}`);
  if (cls && args.maxSharePct != null) conds.push(sql`${classShare} <= ${args.maxSharePct}`);
  if (cls && args.minAmount != null) conds.push(sql`${classAmt} >= ${args.minAmount}`);
  if (args.minAdminExpenseBps != null) conds.push(sql`${adminBps} >= ${args.minAdminExpenseBps}`);
  const where = sql.join(conds, sql` AND `);
  const join = needPlans ? sql`JOIN plans pl ON pl.ack_id = s.ack_id` : sql`LEFT JOIN plans pl ON pl.ack_id = s.ack_id`;
  const order = {
    assets: sql`s.tot_assets_eoy_amt DESC`,
    share: cls ? sql`${classShare} DESC NULLS LAST, s.tot_assets_eoy_amt DESC` : sql`s.tot_assets_eoy_amt DESC`,
    amount: cls ? sql`${classAmt} DESC, s.tot_assets_eoy_amt DESC` : sql`s.tot_assets_eoy_amt DESC`,
    admin_bps: sql`${adminBps} DESC NULLS LAST`,
    net_return: sql`${netRet} DESC NULLS LAST`,
  }[args.sortBy ?? (cls ? "amount" : "assets")];

  const [summary] = rowsOf(
    await db.execute(sql`
      SELECT COUNT(*)::int AS plans, SUM(s.tot_assets_eoy_amt)::bigint AS total_assets,
             SUM(${classAmt})::bigint AS class_amount
      FROM dol_sch_h_i s ${join} WHERE ${where}`)
  );
  const rows = rowsOf(
    await db.execute(sql`
      SELECT s.ack_id, s.schedule, s.filing_year, s.ein, s.pn, s.tax_prd, s.tot_assets_eoy_amt, s.tot_assets_boy_amt,
             s.tot_contrib_amt, s.tot_distrib_bnft_amt, s.tot_admin_expenses_amt, s.emplr_sec_eoy_amt,
             s.fdcry_trustee_cust_name, s.accountant_firm_name,
             ${classAmt} AS class_amt, ${classShare} AS class_share, ${adminBps} AS admin_bps, ${netRet} AS net_ret,
             pl.plan_name, pl.spons_dfe_name, pl.spons_dfe_mail_city, pl.spons_dfe_mail_state, pl.tot_active_partcp_cnt
      FROM dol_sch_h_i s ${join}
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${offset}`)
  );
  if (!rows.length && !summary?.plans) {
    const any = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM dol_sch_h_i`))[0]?.n ?? 0;
    if (!any) return { dataSource: DS, empty: true, note: "dol_sch_h_i is empty — POST /api/admin/refresh-dol-sch-h?year=YYYY has not run." };
  }
  return {
    dataSource: DS,
    filters: { ...args, assetClass: cls ?? undefined },
    summary: {
      plans: summary?.plans ?? 0,
      totalAssetsUsd: n(summary?.total_assets),
      ...(cls ? { assetClass: cls, assetClassLabel: ASSET_CLASSES[cls]!.label, classAmountUsd: n(summary?.class_amount) } : {}),
    },
    returned: rows.length,
    rows: rows.map((r) => ({
      ackId: r.ack_id,
      schedule: r.schedule,
      filingYear: r.filing_year,
      planName: r.plan_name ?? null,
      sponsor: r.spons_dfe_name ?? null,
      sponsorEin: r.ein,
      location: [r.spons_dfe_mail_city, r.spons_dfe_mail_state].filter(Boolean).join(", ") || null,
      planYearEnd: r.tax_prd,
      activeParticipants: r.tot_active_partcp_cnt ?? null,
      totalAssetsEoy: n(r.tot_assets_eoy_amt),
      ...(cls ? { classAmountUsd: n(r.class_amt), classSharePct: r.class_share != null ? Math.round(Number(r.class_share) * 10) / 10 : null } : {}),
      employerSecuritiesUsd: n(r.emplr_sec_eoy_amt),
      contributions: n(r.tot_contrib_amt),
      benefitsPaid: n(r.tot_distrib_bnft_amt),
      adminExpenseBps: r.admin_bps != null ? Math.round(Number(r.admin_bps)) : null,
      netInvestmentReturnPct: r.net_ret != null ? Math.round(Number(r.net_ret) * 10) / 10 : null,
      trusteeCustodian: r.fdcry_trustee_cust_name ?? null,
      auditor: r.accountant_firm_name ?? null,
    })),
    note:
      "Screen over Schedule H/I filings (one row per filing). Asset classes other than employer_securities/employer_property/real_estate/partnerships/participant_loans/other_loans exist only on Schedule H (100+ participants), so the screen is restricted to H for those. state/city require the plans table loaded for the same year. Sponsor name is null where plans is not loaded; use sponsorEin with dol_plan_lookup. Page with offset.",
  };
}

// ---------------------------------------------------------------------------
// dol_sch_h_status
// ---------------------------------------------------------------------------

export async function dolSchHStatus() {
  const g = await guard();
  if (g) return g;
  const counts = rowsOf(
    await db.execute(sql`
      SELECT filing_year, schedule, COUNT(*)::int AS rows, SUM(tot_assets_eoy_amt)::bigint AS total_assets_eoy,
             COUNT(*) FILTER (WHERE tot_assets_eoy_amt IS NULL)::int AS null_assets,
             MAX(last_updated_at) AS last_updated
      FROM dol_sch_h_i GROUP BY filing_year, schedule ORDER BY filing_year DESC, schedule`)
  );
  const runs = rowsOf(
    await db.execute(sql`
      SELECT source, status, started_at, finished_at, firms_processed, firms_inserted, error_message
      FROM ingest_runs WHERE source LIKE 'dol-sch-h/%' ORDER BY started_at DESC LIMIT 6`)
  );
  let coverage: any[] = [];
  try {
    coverage = rowsOf(
      await db.execute(sql`
        SELECT pl.plan_year, COUNT(*)::int AS plans,
               COUNT(s.ack_id)::int AS with_sch_h_i,
               COUNT(*) FILTER (WHERE pl.tot_assets_eoy_amt IS NULL AND s.tot_assets_eoy_amt IS NOT NULL)::int AS assets_restored
        FROM plans pl LEFT JOIN dol_sch_h_i s ON s.ack_id = pl.ack_id
        GROUP BY pl.plan_year ORDER BY pl.plan_year DESC LIMIT 6`)
    );
  } catch {
    coverage = []; // plans table missing (migration 0002 not applied)
  }
  return {
    dataSource: DS,
    byYear: counts.map((c) => ({
      filingYear: c.filing_year,
      schedule: c.schedule,
      rows: c.rows,
      totalAssetsEoyUsd: n(c.total_assets_eoy),
      nullAssets: c.null_assets,
      lastUpdated: c.last_updated,
    })),
    plansCoverage: coverage.map((c: any) => ({ planYear: c.plan_year, plans: c.plans, withScheduleHI: c.with_sch_h_i, assetsRestored: c.assets_restored })),
    recentRuns: runs.map((r) => ({
      source: r.source,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      rowsProcessed: r.firms_processed,
      rowsUpserted: r.firms_inserted,
      error: r.error_message ?? undefined,
    })),
    empty: counts.length === 0,
    note: counts.length ? "assetsRestored = plans rows whose F_5500 total assets were null but Schedule H/I supplies them (dol_plan_search COALESCEs these)." : "No rows yet — POST /api/admin/refresh-dol-sch-h?year=YYYY (Bearer CRON_SECRET).",
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DOLSCHH_TOOLS: ToolDef[] = [
  {
    name: "dol_plan_financials",
    description:
      "Full financial statement for an ERISA plan from DOL Form 5500 Schedule H (100+ participant plans) or Schedule I (small plans), stored in Postgres dol_sch_h_i (EBSA FOIA bulk files; a filing year's data is published ~9 months after year end, refreshed when refresh-dol-sch-h runs). Look up by ackId (from dol_plan_search), sponsor ein, or sponsorName (+ state). Returns balance sheet (total assets BOY/EOY, liabilities, net assets), income statement (employer/participant contributions, net investment gain and return %, benefits paid, admin expenses and bps, investment-management fees), the Schedule H asset-class mix in USD and % (cash, govt/corp debt, direct stock, mutual funds, CCT, pooled separate accounts, master trust, insurance general account, employer securities, real estate, partnerships, participant loans), and the auditor / trustee named on the schedule. Use after dol_plan_search to size and profile a plan before outreach; use dol_sch_c_providers_by_plan for who is paid by the plan.",
    inputSchema: {
      type: "object",
      properties: {
        ackId: { type: "string", description: "DOL filing identifier (ACK_ID)" },
        ein: { type: "string", description: "Plan sponsor EIN (9 digits) — returns that sponsor's plans" },
        sponsorName: { type: "string", description: "Contains-match on sponsor / plan name (needs plans table loaded)" },
        state: { type: "string", description: "2-letter sponsor mailing state (with sponsorName)" },
        filingYear: { type: "number", description: "DOL FOIA file year (e.g. 2024)" },
        limit: { type: "number", default: 3, maximum: 10 },
      },
    },
    handler: dolPlanFinancials,
  },
  {
    name: "dol_plans_by_asset_mix",
    description:
      "Screen ERISA plans by size and asset allocation using DOL Form 5500 Schedule H/I (Postgres dol_sch_h_i joined to plans for sponsor/state). Filters: state, city, filingYear, schedule (H|I), minAssets/maxAssets (total assets EOY, USD), assetClass + minSharePct/maxSharePct/minAmount (e.g. employer_securities share > 20% = concentrated company-stock plans; cct or ins_general_acct share high = bundled/insurance platforms ripe for an open-architecture pitch; stock > 0 = plans holding individual securities, often with an outside manager), minAdminExpenseBps (expensive plans). assetClass keys: cash, govt_sec, corp_debt, stock, mutual_funds, cct, psa, master_trust, entity_103_12, ins_general_acct, employer_securities, employer_property, real_estate, partnerships, participant_loans, other_loans, other. Sort by assets | share | amount | admin_bps | net_return. Returns summary totals + up to 100 rows (default 25) with assets, class amount/share, contributions, benefits paid, admin bps, net investment return %, trustee/custodian and auditor. Advisory prospect targeting; use dol_plan_search for participant/plan-type filters.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string" },
        city: { type: "string" },
        filingYear: { type: "number" },
        schedule: { type: "string", enum: ["H", "I"] },
        minAssets: { type: "number" },
        maxAssets: { type: "number" },
        assetClass: { type: "string", enum: ASSET_CLASS_KEYS },
        minSharePct: { type: "number", description: "min % of total assets in assetClass" },
        maxSharePct: { type: "number" },
        minAmount: { type: "number", description: "min USD in assetClass" },
        minAdminExpenseBps: { type: "number" },
        sortBy: { type: "string", enum: ["assets", "share", "amount", "admin_bps", "net_return"] },
        limit: { type: "number", default: 25, maximum: 100 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: dolPlansByAssetMix,
  },
  {
    name: "dol_sch_h_status",
    description:
      "Ingest status for DOL Form 5500 Schedule H/I plan financials (Postgres dol_sch_h_i): row counts and total assets by filing year and schedule, how many `plans` rows per plan year have their missing F_5500 asset totals restored from Schedule H/I, and the last refresh-dol-sch-h runs. Use to check whether asset filters in dol_plan_search / dol_sch_c_plans_by_provider are live for a year before relying on them. Keyless, no args.",
    inputSchema: { type: "object", properties: {} },
    handler: dolSchHStatus,
  },
];

export const DOLSCHH_DOMAIN: CatalogDomain = {
  id: "dolschh",
  label: "DOL 5500 Schedule H/I (plan financials & asset mix)",
  source:
    "DOL EBSA Form 5500 Schedule H + Schedule I bulk files (askebsa.dol.gov FOIA, F_SCH_H_<year>_Latest.zip / F_SCH_I_<year>_Latest.zip) → Postgres dol_sch_h_i (migration 0010) ⋈ plans",
  tools: [
    { name: "dol_plan_financials", backing: "postgres", probe: "unprobed", note: "Empty until migration 0010 + POST /api/admin/refresh-dol-sch-h?year=YYYY" },
    { name: "dol_plans_by_asset_mix", backing: "postgres", probe: "unprobed", note: "Asset-class filters are Schedule H only; state/city need plans loaded for the year" },
    { name: "dol_sch_h_status", backing: "postgres", probe: "unprobed" },
  ],
};

export const DOLSCHH_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "sch H/I status (tolerates missing table)", tool: "dol_sch_h_status", args: {}, note: "empty:true with ingest hint until migration 0010 + refresh-dol-sch-h" },
  { name: "sch H financials by ackId", tool: "dol_plan_financials", args: { ackId: "20250924180752NAL0007831025001" }, note: "2024 Schedule H row; empty until ingested" },
  { name: "IL plans with >20% employer securities", tool: "dol_plans_by_asset_mix", args: { state: "IL", assetClass: "employer_securities", minSharePct: 20, minAssets: 10_000_000, limit: 5 } },
];
