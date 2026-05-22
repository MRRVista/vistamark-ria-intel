/**
 * DOL Form 5500 ingest pipeline.
 *
 * Strategy:
 *   1. Download the annual ZIP from EBSA (configurable URL).
 *   2. Unzip in-memory using adm-zip; the ZIP contains a single CSV.
 *   3. Stream-parse the CSV row-by-row using the same primitives as the IRS
 *      BMF ingest (consumeCsvChunk / finishCsvStream).
 *   4. Batch-upsert 500 rows at a time via INSERT ... ON CONFLICT DO UPDATE
 *      keyed on ACK_ID (DOL's unique filing identifier).
 */

import AdmZip from "adm-zip";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { plans, ingestRuns } from "../db/schema";
import type { PlanInsert } from "../db/schema";
import { politeFetch } from "../data/http";
import {
  buildHeaderIndex,
  consumeCsvChunk,
  finishCsvStream,
  newStreamState,
  planRowToRecord,
} from "./parser";

const SOURCE_PREFIX = "dol-5500";
const BATCH_SIZE = 500;
const DOL_BASE_URL =
  process.env.DOL_5500_BASE_URL ?? "https://askebsa.dol.gov/FOIA%20Files";

export function defaultIngestYear(): number {
  const envYear = process.env.DOL_5500_YEAR;
  if (envYear && /^\d{4}$/.test(envYear)) return Number(envYear);
  return new Date().getUTCFullYear() - 2;
}

export function dolZipUrl(year: number): string {
  return `${DOL_BASE_URL}/${year}/Latest/F_5500_${year}_Latest.zip`;
}

export interface IngestYearResult {
  year: number;
  rowsProcessed: number;
  rowsUpserted: number;
  durationMs: number;
  csvFile: string;
}

export async function ingestYear(year: number): Promise<IngestYearResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  const url = dolZipUrl(year);

  const runInsert = await db
    .insert(ingestRuns)
    .values({ source: `${SOURCE_PREFIX}/${year}`, status: "running" })
    .returning({ id: ingestRuns.id });
  const runId = runInsert[0]!.id;

  let rowsProcessed = 0;
  let rowsUpserted = 0;
  let csvFile = "";

  try {
    const res = await politeFetch(url, { timeoutMs: 240_000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const zip = new AdmZip(buffer);
    const entries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.endsWith(".csv"));
    if (entries.length === 0) {
      throw new Error(`No CSV entry found in ${url}`);
    }
    const csvEntry = entries[0]!;
    csvFile = csvEntry.entryName;
    const csvBuffer = csvEntry.getData();

    const state = newStreamState();
    let headerIndex: Record<string, number> | null = null;
    let batch: PlanInsert[] = [];

    const decoder = new TextDecoder("utf-8");
    const CHUNK = 4 * 1024 * 1024;
    for (let offset = 0; offset < csvBuffer.length; offset += CHUNK) {
      const slice = csvBuffer.subarray(offset, Math.min(offset + CHUNK, csvBuffer.length));
      const text = decoder.decode(slice, { stream: true });
      consumeCsvChunk(state, text, (row) => {
        if (!headerIndex) {
          headerIndex = buildHeaderIndex(row);
          return;
        }
        rowsProcessed++;
        const record = planRowToRecord(row, headerIndex);
        if (record) batch.push(record);
      });
      while (batch.length >= BATCH_SIZE) {
        const chunk = batch.splice(0, BATCH_SIZE);
        await upsertBatch(chunk);
        rowsUpserted += chunk.length;
      }
    }
    finishCsvStream(state, (row) => {
      if (!headerIndex) {
        headerIndex = buildHeaderIndex(row);
        return;
      }
      rowsProcessed++;
      const record = planRowToRecord(row, headerIndex);
      if (record) batch.push(record);
    });
    if (batch.length > 0) {
      await upsertBatch(batch);
      rowsUpserted += batch.length;
      batch = [];
    }

    await db
      .update(ingestRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        firmsProcessed: rowsProcessed,
        firmsInserted: rowsUpserted,
        firmsUpdated: 0,
      })
      .where(sql`${ingestRuns.id} = ${runId}`);

    return {
      year,
      rowsProcessed,
      rowsUpserted,
      durationMs: Date.now() - start,
      csvFile,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(ingestRuns)
      .set({
        status: "error",
        finishedAt: new Date(),
        errorMessage: message,
        firmsProcessed: rowsProcessed,
        firmsInserted: rowsUpserted,
      })
      .where(sql`${ingestRuns.id} = ${runId}`);
    throw err;
  }
}

async function upsertBatch(rows: PlanInsert[]): Promise<void> {
  if (!db) throw new Error("Database not configured");
  if (rows.length === 0) return;
  await db
    .insert(plans)
    .values(rows)
    .onConflictDoUpdate({
      target: plans.ackId,
      set: {
        formPlanYearBeginDate: sql`excluded.form_plan_year_begin_date`,
        formTaxPrd: sql`excluded.form_tax_prd`,
        typePlanEntityCd: sql`excluded.type_plan_entity_cd`,
        typeDfePlanEntityCd: sql`excluded.type_dfe_plan_entity_cd`,
        initialFilingInd: sql`excluded.initial_filing_ind`,
        amendedInd: sql`excluded.amended_ind`,
        finalFilingInd: sql`excluded.final_filing_ind`,
        shortPlanYrInd: sql`excluded.short_plan_yr_ind`,
        collectiveBargainInd: sql`excluded.collective_bargain_ind`,
        planYear: sql`excluded.plan_year`,
        planName: sql`excluded.plan_name`,
        sponsDfePn: sql`excluded.spons_dfe_pn`,
        sponsDfeEin: sql`excluded.spons_dfe_ein`,
        sponsDfeName: sql`excluded.spons_dfe_name`,
        sponsDfeDbaName: sql`excluded.spons_dfe_dba_name`,
        sponsDfeMailAddr1: sql`excluded.spons_dfe_mail_addr1`,
        sponsDfeMailCity: sql`excluded.spons_dfe_mail_city`,
        sponsDfeMailState: sql`excluded.spons_dfe_mail_state`,
        sponsDfeMailZip: sql`excluded.spons_dfe_mail_zip`,
        sponsDfePhone: sql`excluded.spons_dfe_phone`,
        adminName: sql`excluded.admin_name`,
        adminEin: sql`excluded.admin_ein`,
        adminPhone: sql`excluded.admin_phone`,
        adminAddr1: sql`excluded.admin_addr1`,
        adminCity: sql`excluded.admin_city`,
        adminState: sql`excluded.admin_state`,
        adminZip: sql`excluded.admin_zip`,
        totActivePartcpCnt: sql`excluded.tot_active_partcp_cnt`,
        totPartcpBoyCnt: sql`excluded.tot_partcp_boy_cnt`,
        rtrdSepPartcpRcvgCnt: sql`excluded.rtrd_sep_partcp_rcvg_cnt`,
        rtrdSepPartcpFutCnt: sql`excluded.rtrd_sep_partcp_fut_cnt`,
        pensionPlanFeatureCodes: sql`excluded.pension_plan_feature_codes`,
        welfarePlanFeatureCodes: sql`excluded.welfare_plan_feature_codes`,
        schAAttachedInd: sql`excluded.sch_a_attached_ind`,
        schCAttachedInd: sql`excluded.sch_c_attached_ind`,
        schDAttachedInd: sql`excluded.sch_d_attached_ind`,
        schGAttachedInd: sql`excluded.sch_g_attached_ind`,
        schHAttachedInd: sql`excluded.sch_h_attached_ind`,
        schIAttachedInd: sql`excluded.sch_i_attached_ind`,
        schRAttachedInd: sql`excluded.sch_r_attached_ind`,
        schMbAttachedInd: sql`excluded.sch_mb_attached_ind`,
        schSbAttachedInd: sql`excluded.sch_sb_attached_ind`,
        totAssetsBoyAmt: sql`excluded.tot_assets_boy_amt`,
        totAssetsEoyAmt: sql`excluded.tot_assets_eoy_amt`,
        netAssetsBoyAmt: sql`excluded.net_assets_boy_amt`,
        netAssetsEoyAmt: sql`excluded.net_assets_eoy_amt`,
        dateReceived: sql`excluded.date_received`,
        lastUpdatedAt: sql`NOW()`,
      },
    });
}
