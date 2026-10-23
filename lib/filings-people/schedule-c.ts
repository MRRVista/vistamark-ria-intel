/**
 * DOL Form 5500 Schedule C — ingest + query handlers.
 *
 * Ingest (api/admin/refresh-dol-sch-c.ts): downloads Part I Item 2 + its
 * CODES file for a year from EBSA's FOIA bulk area, folds codes onto each
 * provider row, and upserts into dol_sch_c_providers (migrations/0009) in
 * 500-row batches keyed on (ack_id, row_order). An ingest_runs row is
 * recorded exactly like lib/dol-5500/ingest.ts.
 *
 * Queries join to the existing `plans` table (lib/db/schema.ts, ack_id PK)
 * for sponsor name/EIN/state/assets — so plan details only appear for years
 * where the main Form 5500 ingest (refresh-dol-5500) has also run.
 *
 * Uses drizzle `sql` raw queries (no schema.ts changes).
 */
import AdmZip from "adm-zip";
import { sql, type SQL } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { politeFetch } from "../data/http";
import { schHTableExists } from "../dol-5500/schedule-h";
import {
  SCH_C_ROLE_CODES,
  buildCodeMap,
  describeCodes,
  forEachCsvRow,
  headerIndex,
  item2RowToRecord,
  normalizeProviderName,
  type SchCProviderRow,
} from "./schedule-c-parse";

const SOURCE_PREFIX = "dol-sch-c";
const BATCH_SIZE = 1000; // 16 params × 1000 = 16k binds (< 65,535 limit); halves Neon round trips vs 500
// askebsa.dol.gov 301-redirects to www.askebsa.dol.gov; use the final host.
const DOL_BASE_URL = process.env.DOL_5500_SCH_C_BASE_URL ?? "https://www.askebsa.dol.gov/FOIA%20Files";

export function defaultSchCYear(): number {
  const envYear = process.env.DOL_5500_YEAR;
  if (envYear && /^\d{4}$/.test(envYear)) return Number(envYear);
  return new Date().getUTCFullYear() - 2;
}

export function schCUrls(year: number) {
  return {
    item2: `${DOL_BASE_URL}/${year}/Latest/F_SCH_C_PART1_ITEM2_${year}_Latest.zip`,
    codes: `${DOL_BASE_URL}/${year}/Latest/F_SCH_C_PART1_ITEM2_CODES_${year}_Latest.zip`,
  };
}

async function downloadCsvFromZip(url: string): Promise<{ name: string; data: Buffer }> {
  const res = await politeFetch(url, { timeoutMs: 120_000, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entry = zip.getEntries().find((e) => !e.isDirectory && /\.csv$/i.test(e.entryName));
  if (!entry) throw new Error(`No CSV entry in ${url}`);
  return { name: entry.entryName, data: entry.getData() };
}

function rowsOf(r: any): any[] {
  return (r?.rows ?? r) as any[];
}

async function upsertBatch(rows: SchCProviderRow[]) {
  if (!rows.length) return;
  const values = sql.join(
    rows.map(
      (r) => sql`(${r.ackId}, ${r.rowOrder}, ${r.filingYear}, ${r.providerName}, ${r.providerNameNorm}, ${r.providerEin},
        ${r.providerCity}, ${r.providerState}, ${r.providerZip}, ${r.relation}, ${r.serviceCodes},
        ${r.directComp}, ${r.indirectCompInd}, ${r.eligIndirectCompInd}, ${r.indirectComp}, ${r.formulaInd}, NOW())`
    ),
    sql`, `
  );
  await db.execute(sql`
    INSERT INTO dol_sch_c_providers (
      ack_id, row_order, filing_year, provider_name, provider_name_norm, provider_ein,
      provider_city, provider_state, provider_zip, relation, service_codes,
      direct_comp, indirect_comp_ind, elig_indirect_comp_ind, indirect_comp, formula_ind, last_updated_at)
    VALUES ${values}
    ON CONFLICT (ack_id, row_order) DO UPDATE SET
      filing_year = excluded.filing_year,
      provider_name = excluded.provider_name,
      provider_name_norm = excluded.provider_name_norm,
      provider_ein = excluded.provider_ein,
      provider_city = excluded.provider_city,
      provider_state = excluded.provider_state,
      provider_zip = excluded.provider_zip,
      relation = excluded.relation,
      service_codes = excluded.service_codes,
      direct_comp = excluded.direct_comp,
      indirect_comp_ind = excluded.indirect_comp_ind,
      elig_indirect_comp_ind = excluded.elig_indirect_comp_ind,
      indirect_comp = excluded.indirect_comp,
      formula_ind = excluded.formula_ind,
      last_updated_at = NOW()
  `);
}

export interface SchCIngestResult {
  year: number;
  rowsProcessed: number;
  rowsUpserted: number;
  rowsWithCodes: number;
  durationMs: number;
  csvFile: string;
}

export async function ingestScheduleC(year: number): Promise<SchCIngestResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  const urls = schCUrls(year);
  const run = rowsOf(
    await db.execute(sql`INSERT INTO ingest_runs (source, status) VALUES (${`${SOURCE_PREFIX}/${year}`}, 'running') RETURNING id`)
  );
  const runId = run[0]?.id;
  let rowsProcessed = 0;
  let rowsUpserted = 0;
  let rowsWithCodes = 0;
  let csvFile = "";
  try {
    const [main, codesZip] = await Promise.all([downloadCsvFromZip(urls.item2), downloadCsvFromZip(urls.codes)]);
    csvFile = main.name;
    const codes = buildCodeMap(codesZip.data);

    // Keyed map: a duplicate (ack_id,row_order) inside one INSERT batch would
    // fail with "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const byKey = new Map<string, SchCProviderRow>();
    let idx: Record<string, number> | null = null;
    forEachCsvRow(main.data, (row) => {
      if (!idx) {
        idx = headerIndex(row);
        if (idx["ACK_ID"] == null || idx["PROVIDER_OTHER_NAME"] == null) {
          throw new Error(`Unexpected Schedule C header: ${row.slice(0, 8).join(",")}`);
        }
        return;
      }
      rowsProcessed++;
      const rec = item2RowToRecord(row, idx, year, codes);
      if (rec) {
        if (rec.serviceCodes) rowsWithCodes++;
        byKey.set(`${rec.ackId}|${rec.rowOrder}`, rec);
      }
    });
    const records = [...byKey.values()];
    byKey.clear();
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      await upsertBatch(chunk);
      rowsUpserted += chunk.length;
    }
    await db.execute(sql`
      UPDATE ingest_runs SET status = 'ok', finished_at = NOW(),
        firms_processed = ${rowsProcessed}, firms_inserted = ${rowsUpserted}, firms_updated = 0
      WHERE id = ${runId}`);
    return { year, rowsProcessed, rowsUpserted, rowsWithCodes, durationMs: Date.now() - start, csvFile };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .execute(sql`
        UPDATE ingest_runs SET status = 'error', finished_at = NOW(), error_message = ${message},
          firms_processed = ${rowsProcessed}, firms_inserted = ${rowsUpserted}
        WHERE id = ${runId}`)
      .catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const DS = "DOL Form 5500 Schedule C Part I Item 2 (Postgres dol_sch_c_providers ⋈ plans)";

/**
 * Plan assets: F_5500 stopped carrying TOT_ASSETS_EOY_AMT in the 2024 files, so
 * COALESCE with Schedule H/I (dol_sch_h_i, migration 0010) when that table
 * exists. Returns the join fragment + the assets expression to use.
 */
async function assetsJoin(): Promise<{ join: SQL; assets: SQL }> {
  if (await schHTableExists()) {
    return { join: sql`LEFT JOIN dol_sch_h_i shi ON shi.ack_id = p.ack_id`, assets: sql`COALESCE(pl.tot_assets_eoy_amt, shi.tot_assets_eoy_amt)` };
  }
  return { join: sql``, assets: sql`pl.tot_assets_eoy_amt` };
}

function missingTable(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  // Only a missing RELATION (dol_sch_c_providers or plans) — not e.g. a missing column.
  return /relation "?[\w.]+"? does not exist|42P01/i.test(m);
}

function emptyResponse(reason: string) {
  return {
    dataSource: DS,
    rows: [],
    empty: true,
    note: `${reason} Run migrations (POST /api/admin/migrate) then POST /api/admin/refresh-dol-sch-c?year=YYYY with Bearer CRON_SECRET to load Schedule C. Until then use dol_plan_search (hasScheduleC=true) to find plans that attached one.`,
  };
}

function shapeProvider(r: any) {
  return {
    provider: r.provider_name,
    ein: r.provider_ein,
    providerLocation: [r.provider_city, r.provider_state].filter(Boolean).join(", ") || null,
    relation: r.relation,
    services: describeCodes(r.service_codes),
    directComp: r.direct_comp != null ? Number(r.direct_comp) : null,
    indirectComp: r.indirect_comp != null ? Number(r.indirect_comp) : null,
    receivesIndirect: r.indirect_comp_ind,
    totalComp:
      r.direct_comp == null && r.indirect_comp == null ? null : Number(r.direct_comp ?? 0) + Number(r.indirect_comp ?? 0),
  };
}

function roleCondition(role?: string): SQL | null {
  if (!role) return null;
  const codes = SCH_C_ROLE_CODES[role.toLowerCase()];
  if (!codes) return null;
  // service_codes is '27,50' — match any code as a whole token.
  const pattern = `(^|,)(${codes.join("|")})(,|$)`;
  return sql`p.service_codes ~ ${pattern}`;
}

export interface SchCByPlanArgs {
  ackId?: string;
  sponsorName?: string;
  sponsorEin?: string;
  state?: string;
  filingYear?: number;
  role?: string;
  limitPlans?: number;
}

export async function schCProvidersByPlan(args: SchCByPlanArgs) {
  if (!isDbReady()) return emptyResponse("DATABASE_URL not configured.");
  if (!args.ackId && !args.sponsorName && !args.sponsorEin) {
    return { dataSource: DS, error: "Provide ackId, sponsorName, or sponsorEin.", rows: [] };
  }
  const limitPlans = Math.max(1, Math.min(args.limitPlans ?? 3, 10));
  try {
    const conds: SQL[] = [];
    if (args.ackId) conds.push(sql`p.ack_id = ${args.ackId.trim()}`);
    if (args.sponsorEin) conds.push(sql`pl.spons_dfe_ein = ${args.sponsorEin.replace(/\D/g, "")}`);
    // plans.spons_dfe_name is null in current ingests (DOL renamed the column to
    // SPONSOR_DFE_NAME; lib/dol-5500/columns.ts still reads SPONS_DFE_NAME), so
    // also match plan_name, which nearly always embeds the sponsor name.
    if (args.sponsorName) {
      const like = `%${args.sponsorName.trim()}%`;
      conds.push(sql`(pl.spons_dfe_name ILIKE ${like} OR pl.plan_name ILIKE ${like})`);
    }
    if (args.state) conds.push(sql`pl.spons_dfe_mail_state = ${args.state.toUpperCase()}`);
    if (args.filingYear) conds.push(sql`p.filing_year = ${args.filingYear}`);
    const role = roleCondition(args.role);
    if (role) conds.push(role);
    const where = sql.join(conds, sql` AND `);
    const shi = await assetsJoin();
    const join = sql`${args.ackId ? sql`LEFT JOIN plans pl ON pl.ack_id = p.ack_id` : sql`JOIN plans pl ON pl.ack_id = p.ack_id`} ${shi.join}`;

    const planRows = rowsOf(
      await db.execute(sql`
        SELECT p.ack_id, MAX(p.filing_year) AS filing_year,
               MAX(pl.plan_name) AS plan_name, MAX(pl.spons_dfe_name) AS sponsor, MAX(pl.spons_dfe_ein) AS sponsor_ein,
               MAX(pl.spons_dfe_mail_city) AS city, MAX(pl.spons_dfe_mail_state) AS state,
               MAX(pl.plan_year) AS plan_year, MAX(${shi.assets}) AS assets_eoy,
               MAX(pl.tot_active_partcp_cnt) AS active_participants
        FROM dol_sch_c_providers p ${join}
        WHERE ${where}
        GROUP BY p.ack_id
        ORDER BY MAX(${shi.assets}) DESC NULLS LAST, MAX(pl.tot_active_partcp_cnt) DESC NULLS LAST, MAX(p.filing_year) DESC
        LIMIT ${limitPlans}`)
    );
    if (!planRows.length) {
      const any = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM dol_sch_c_providers`))[0]?.n ?? 0;
      if (!any) return emptyResponse("dol_sch_c_providers is empty (ingest has not run).");
      return { dataSource: DS, plans: [], note: "No Schedule C providers matched. Sponsor name/EIN filters need the plans table (refresh-dol-5500) loaded for the same year; try ackId from dol_plan_search, or a shorter sponsorName." };
    }
    const acks = planRows.map((r) => r.ack_id);
    const provRows = rowsOf(
      await db.execute(sql`
        SELECT p.* FROM dol_sch_c_providers p
        WHERE p.ack_id IN (${sql.join(acks.map((a) => sql`${a}`), sql`, `)}) ${role ? sql`AND ${role}` : sql``}
        ORDER BY COALESCE(p.direct_comp,0) + COALESCE(p.indirect_comp,0) DESC`)
    );
    return {
      dataSource: DS,
      plans: planRows.map((pr) => ({
        ackId: pr.ack_id,
        filingYear: pr.filing_year,
        planYear: pr.plan_year,
        planName: pr.plan_name,
        sponsor: pr.sponsor,
        sponsorEin: pr.sponsor_ein,
        location: [pr.city, pr.state].filter(Boolean).join(", ") || null,
        assetsEoy: pr.assets_eoy != null ? Number(pr.assets_eoy) : null,
        activeParticipants: pr.active_participants,
        providers: provRows.filter((r) => r.ack_id === pr.ack_id).slice(0, 25).map(shapeProvider),
      })),
      note:
        "Schedule C lists every service provider paid $5,000+ (direct or indirect) by the plan; plans with <100 participants usually don't file it. relation is free text from the filer; services are the official Schedule C codes (27 = investment advisory to the plan, 26 = to participants, 28 = investment management, 15/64 = recordkeeping, 16/17/70 = consulting). " +
        "Comp in USD for the plan year. role filter: adviser | recordkeeper | broker | trustee | auditor | actuary | legal.",
    };
  } catch (e) {
    if (missingTable(e)) return emptyResponse("Table dol_sch_c_providers does not exist yet (migration 0009 not applied).");
    throw e;
  }
}

export interface SchCByProviderArgs {
  providerName?: string;
  providerEin?: string;
  state?: string;
  city?: string;
  minAssets?: number;
  role?: string;
  filingYear?: number;
  limit?: number;
  offset?: number;
}

export async function schCPlansByProvider(args: SchCByProviderArgs) {
  if (!isDbReady()) return emptyResponse("DATABASE_URL not configured.");
  if (!args.providerName && !args.providerEin) {
    return { dataSource: DS, error: "Provide providerName (contains match) or providerEin.", rows: [] };
  }
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const offset = Math.max(0, args.offset ?? 0);
  try {
    const conds: SQL[] = [];
    if (args.providerEin) conds.push(sql`p.provider_ein = ${args.providerEin.replace(/\D/g, "")}`);
    if (args.providerName) {
      const n = normalizeProviderName(args.providerName) ?? args.providerName.toUpperCase();
      conds.push(sql`p.provider_name_norm LIKE ${`%${n}%`}`);
    }
    if (args.state) conds.push(sql`pl.spons_dfe_mail_state = ${args.state.toUpperCase()}`);
    if (args.city) conds.push(sql`pl.spons_dfe_mail_city ILIKE ${args.city}`);
    const shi = await assetsJoin();
    if (args.minAssets != null) conds.push(sql`${shi.assets} >= ${args.minAssets}`);
    if (args.filingYear) conds.push(sql`p.filing_year = ${args.filingYear}`);
    const role = roleCondition(args.role);
    if (role) conds.push(role);
    const where = sql.join(conds, sql` AND `);
    const needPlans = !!(args.state || args.city || args.minAssets != null);
    const join = sql`${needPlans ? sql`JOIN plans pl ON pl.ack_id = p.ack_id` : sql`LEFT JOIN plans pl ON pl.ack_id = p.ack_id`} ${shi.join}`;

    const [summary] = rowsOf(
      await db.execute(sql`
        SELECT COUNT(DISTINCT p.ack_id)::int AS plans,
               SUM(COALESCE(p.direct_comp,0) + COALESCE(p.indirect_comp,0))::bigint AS total_comp,
               SUM(${shi.assets})::bigint AS total_plan_assets,
               COUNT(DISTINCT p.provider_name_norm)::int AS name_variants
        FROM dol_sch_c_providers p ${join} WHERE ${where}`)
    );
    const rows = rowsOf(
      await db.execute(sql`
        SELECT p.*, pl.plan_name, pl.spons_dfe_name, pl.spons_dfe_ein, pl.spons_dfe_mail_city, pl.spons_dfe_mail_state,
               ${shi.assets} AS tot_assets_eoy_amt, pl.tot_active_partcp_cnt, pl.plan_year
        FROM dol_sch_c_providers p ${join}
        WHERE ${where}
        ORDER BY ${shi.assets} DESC NULLS LAST, COALESCE(p.direct_comp,0) + COALESCE(p.indirect_comp,0) DESC, pl.tot_active_partcp_cnt DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}`)
    );
    if (!rows.length) {
      const any = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM dol_sch_c_providers`))[0]?.n ?? 0;
      if (!any) return emptyResponse("dol_sch_c_providers is empty (ingest has not run).");
    }
    const variants = args.providerName
      ? rowsOf(
          await db.execute(sql`
            SELECT p.provider_name, p.provider_ein, COUNT(*)::int AS n
            FROM dol_sch_c_providers p ${join} WHERE ${where}
            GROUP BY p.provider_name, p.provider_ein ORDER BY n DESC LIMIT 8`)
        )
      : [];
    return {
      dataSource: DS,
      summary: {
        plans: summary?.plans ?? 0,
        totalCompUsd: summary?.total_comp != null ? Number(summary.total_comp) : null,
        totalPlanAssetsUsd: summary?.total_plan_assets != null ? Number(summary.total_plan_assets) : null,
      },
      ...(variants.length ? { providerNameVariants: variants.map((v) => ({ name: v.provider_name, ein: v.provider_ein, rows: v.n })) } : {}),
      returned: rows.length,
      rows: rows.map((r) => ({
        ackId: r.ack_id,
        filingYear: r.filing_year,
        sponsor: r.spons_dfe_name ?? null,
        sponsorEin: r.spons_dfe_ein ?? null,
        planName: r.plan_name ?? null,
        location: [r.spons_dfe_mail_city, r.spons_dfe_mail_state].filter(Boolean).join(", ") || null,
        planAssetsEoy: r.tot_assets_eoy_amt != null ? Number(r.tot_assets_eoy_amt) : null,
        activeParticipants: r.tot_active_partcp_cnt ?? null,
        ...shapeProvider(r),
      })),
      note:
        "Plans that report paying this provider on Schedule C (≥$5K comp; mostly 100+ participant plans). Provider names are free text — check providerNameVariants and prefer providerEin once you know it. " +
        "Sponsor name comes from the plans table — null when that year isn't loaded. Plan assets are F_5500 totals, falling back to Schedule H/I (dol_sch_h_i, migration 0010 + refresh-dol-sch-h) since DOL dropped them from F_5500 in 2024; null until that ingest runs. Sorted by plan assets, then comp. role: adviser | recordkeeper | broker | trustee | auditor | actuary | legal. Page with offset.",
    };
  } catch (e) {
    if (missingTable(e)) return emptyResponse("Table dol_sch_c_providers does not exist yet (migration 0009 not applied).");
    throw e;
  }
}
