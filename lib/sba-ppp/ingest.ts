/**
 * SBA PPP ingest pipeline.
 *
 * Unlike IPEDS/BMF, the SBA PPP FOIA files are NOT zipped on data.sba.gov —
 * they are raw .csv downloads (the >=$150k file is ~250 MB / ~1M rows; the
 * per-state <$150k files are smaller). A single Vercel function can't hold a
 * 250 MB CSV fully in memory comfortably, so this ingest streams the HTTP
 * response body and parses incrementally, upserting in 1,000-row batches.
 *
 * Because one function invocation may not finish a 1M-row file within the
 * 300s ceiling, ingestPpp accepts a `maxRows` cap and returns how far it got.
 * For very large files prefer pointing it at the per-state <$150k files, or
 * run repeatedly with a cursor. (Cursor support is intentionally omitted for
 * now — Matt typically ingests a targeted state file.)
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { pppLoans, ingestRuns } from "../db/schema";
import type { PppLoanInsert } from "../db/schema";
import { politeFetch } from "../data/http";
import {
  buildHeaderIndex,
  newStreamState,
  consumeCsvChunk,
  finishCsvStream,
  pppRowToRecord,
} from "./parser";

const SOURCE_PREFIX = "sba-ppp";
const BATCH_SIZE = 1000;

export interface PppIngestResult {
  source: string;
  url: string;
  rowsProcessed: number;
  rowsUpserted: number;
  rowsSkippedNoKey: number;
  headerSample: string[];
  truncated: boolean;
  durationMs: number;
}

async function upsertPppLoans(rows: PppLoanInsert[]): Promise<void> {
  if (!db || rows.length === 0) return;
  await db
    .insert(pppLoans)
    .values(rows)
    .onConflictDoUpdate({
      target: pppLoans.loanNumber,
      set: {
        dateApproved: sql`excluded.date_approved`,
        borrowerName: sql`excluded.borrower_name`,
        borrowerAddress: sql`excluded.borrower_address`,
        borrowerCity: sql`excluded.borrower_city`,
        borrowerState: sql`excluded.borrower_state`,
        borrowerZip: sql`excluded.borrower_zip`,
        loanStatus: sql`excluded.loan_status`,
        loanStatusDate: sql`excluded.loan_status_date`,
        initialApprovalAmount: sql`excluded.initial_approval_amount`,
        currentApprovalAmount: sql`excluded.current_approval_amount`,
        undisbursedAmount: sql`excluded.undisbursed_amount`,
        businessType: sql`excluded.business_type`,
        nonprofitFlag: sql`excluded.nonprofit_flag`,
        naicsCode: sql`excluded.naics_code`,
        jobsReported: sql`excluded.jobs_reported`,
        originatingLender: sql`excluded.originating_lender`,
        servicingLenderName: sql`excluded.servicing_lender_name`,
        forgivenessAmount: sql`excluded.forgiveness_amount`,
        forgivenessDate: sql`excluded.forgiveness_date`,
        ruralUrbanIndicator: sql`excluded.rural_urban_indicator`,
        hubzoneIndicator: sql`excluded.hubzone_indicator`,
        lmiIndicator: sql`excluded.lmi_indicator`,
        lastUpdatedAt: sql`NOW()`,
      },
    });
}

/**
 * Ingest a single SBA PPP CSV file from a URL. Streams the body, parses
 * incrementally, upserts in batches. Stops after `maxRows` data rows if
 * provided (returns truncated=true), so callers stay within the function
 * time budget on very large files.
 */
export async function ingestPpp(
  url: string,
  maxRows?: number
): Promise<PppIngestResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  // Derive a stable source label from the filename.
  const fileLabel = url.split("/").pop()?.split("?")[0] ?? "file";
  const source = `${SOURCE_PREFIX}/${fileLabel}`.slice(0, 64);

  const runInsert = await db
    .insert(ingestRuns)
    .values({ source, status: "running" })
    .returning({ id: ingestRuns.id });
  const runId = runInsert[0]!.id;

  let rowsProcessed = 0;
  let rowsUpserted = 0;
  let rowsSkippedNoKey = 0;
  let headerSample: string[] = [];
  let truncated = false;

  try {
    const res = await politeFetch(url, { timeoutMs: 280_000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    if (!res.body) throw new Error(`No response body from ${url}`);

    const state = newStreamState();
    const decoder = new TextDecoder("utf-8");
    let headerIndex: Record<string, number> | null = null;
    let batch: PppLoanInsert[] = [];
    let stop = false;

    const reader = res.body.getReader();
    while (!stop) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });

      // We must await inside a sync onRow callback path, so collect to batch
      // and flush between chunks.
      consumeCsvChunk(state, text, (row) => {
        if (stop) return;
        if (!headerIndex) {
          headerSample = row.slice(0, 12).map((c) => c.slice(0, 40));
          headerIndex = buildHeaderIndex(row);
          return;
        }
        rowsProcessed++;
        const record = pppRowToRecord(row, headerIndex);
        if (record) batch.push(record);
        else rowsSkippedNoKey++;
        if (maxRows != null && rowsProcessed >= maxRows) {
          stop = true;
          truncated = true;
        }
      });

      while (batch.length >= BATCH_SIZE) {
        const chunk = batch.splice(0, BATCH_SIZE);
        await upsertPppLoans(chunk);
        rowsUpserted += chunk.length;
      }
    }

    if (!stop) {
      finishCsvStream(state, (row) => {
        if (!headerIndex) {
          headerIndex = buildHeaderIndex(row);
          return;
        }
        rowsProcessed++;
        const record = pppRowToRecord(row, headerIndex);
        if (record) batch.push(record);
        else rowsSkippedNoKey++;
      });
    }

    if (batch.length > 0) {
      await upsertPppLoans(batch);
      rowsUpserted += batch.length;
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
      source,
      url,
      rowsProcessed,
      rowsUpserted,
      rowsSkippedNoKey,
      headerSample,
      truncated,
      durationMs: Date.now() - start,
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
