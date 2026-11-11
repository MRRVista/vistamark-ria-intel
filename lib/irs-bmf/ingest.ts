/**
 * IRS EO BMF ingest pipeline.
 *
 * Strategy: stream each regional CSV (eo1..eo4, eo_pr, eo_xx) row-by-row,
 * batch into chunks of 500 NonprofitInsert records, upsert to Postgres
 * with onConflictDoUpdate keyed on EIN.
 *
 * Memory: streaming keeps RSS below ~150 MB even on the largest region (eo4,
 *         ~500K rows). The whole file is never held in memory.
 * Time:   one upsert round trip per 500 rows against Neon HTTP. Run strictly
 *         one after another, the largest regions outgrew the 300s function
 *         limit (weekly timeouts from 2026-07 on), so batches are now written
 *         UPSERT_CONCURRENCY at a time — EINs are unique within a file, so
 *         concurrent batches never touch the same row. A wall-clock budget
 *         stops the run cleanly (status 'error', counts recorded) before
 *         Vercel would kill it and strand the run row in 'running'.
 *
 * Note on ingest_runs columns: the existing schema uses `firms_*` count fields
 * which originated with ADV. For BMF we reuse them — `firms_processed` =
 * nonprofits processed, etc. The `source` column distinguishes runs by feed.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { nonprofits, ingestRuns } from "../db/schema";
import type { NonprofitInsert } from "../db/schema";
import { politeFetch } from "../data/http";
import { BMF_REGIONS, bmfUrl } from "./columns";
import type { BmfRegion } from "./columns";
import {
  bmfRowToRecord,
  consumeCsvChunk,
  finishCsvStream,
  newStreamState,
} from "./parser";

const SOURCE_PREFIX = "irs-bmf";
const BATCH_SIZE = 500;
const UPSERT_CONCURRENCY = 6;
/** Stop reading and fail cleanly before the 300s function limit. */
const TIME_BUDGET_MS = 270_000;

export interface IngestRegionResult {
  region: BmfRegion;
  rowsProcessed: number;
  rowsInserted: number;
  rowsUpdated: number;
  durationMs: number;
}

/**
 * Pick which region to process next. Strategy: the region whose most recent
 * ATTEMPT is oldest wins (so we round-robin through all 6 regions over time).
 * If a region has never been attempted, that one goes first.
 *
 * It used to rank by the latest *successful* run. A region that kept timing
 * out never recorded one, so it stayed "oldest" and was picked every week
 * while the other five went unrefreshed.
 */
export async function pickNextRegion(): Promise<BmfRegion> {
  if (!db) throw new Error("Database not configured");
  const latestRuns = await db.execute(sql`
    SELECT source, MAX(started_at) AS last_done
    FROM ingest_runs
    WHERE source LIKE ${`${SOURCE_PREFIX}/%`}
    GROUP BY source
  `);
  const seen = new Map<string, Date>();
  for (const r of (latestRuns as any).rows ?? []) {
    seen.set(String(r.source), new Date(r.last_done));
  }
  for (const region of BMF_REGIONS) {
    if (!seen.has(`${SOURCE_PREFIX}/${region}`)) return region;
  }
  let oldestRegion: BmfRegion = BMF_REGIONS[0];
  let oldestTime = Infinity;
  for (const region of BMF_REGIONS) {
    const t = seen.get(`${SOURCE_PREFIX}/${region}`)!.getTime();
    if (t < oldestTime) {
      oldestTime = t;
      oldestRegion = region;
    }
  }
  return oldestRegion;
}

/**
 * Ingest one BMF region end-to-end: HTTP stream → CSV parse → batch upsert.
 */
export async function ingestRegion(region: BmfRegion): Promise<IngestRegionResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  const url = bmfUrl(region);

  const runInsert = await db
    .insert(ingestRuns)
    .values({
      source: `${SOURCE_PREFIX}/${region}`,
      status: "running",
    })
    .returning({ id: ingestRuns.id });
  const runId = runInsert[0]!.id;

  let rowsProcessed = 0;
  let rowsInserted = 0;
  let rowsUpdated = 0;

  try {
    const res = await politeFetch(url, { timeoutMs: 120_000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    if (!res.body) throw new Error(`No response body for ${url}`);

    const reader = (res.body as any).getReader
      ? (res.body as ReadableStream<Uint8Array>).getReader()
      : null;
    if (!reader) throw new Error("Stream reader unavailable for response body");

    const decoder = new TextDecoder("utf-8");
    const state = newStreamState();
    let headerSkipped = false;
    let batch: NonprofitInsert[] = [];

    // Up to UPSERT_CONCURRENCY upserts in flight; the reader waits for a free
    // slot, so memory stays bounded at a handful of 500-row batches.
    const inFlight = new Set<Promise<void>>();
    let writeError: unknown = null;
    const submit = async (chunk: NonprofitInsert[]) => {
      if (chunk.length === 0) return;
      while (inFlight.size >= UPSERT_CONCURRENCY) await Promise.race(inFlight);
      if (writeError) throw writeError;
      const p: Promise<void> = upsertBatch(chunk)
        .then((result) => { rowsInserted += result.inserted; rowsUpdated += result.updated; })
        .catch((e) => { writeError = writeError ?? e; })
        .finally(() => { inFlight.delete(p); });
      inFlight.add(p);
    };
    const drain = async () => {
      await Promise.all(inFlight);
      if (writeError) throw writeError;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      consumeCsvChunk(state, text, (row) => {
        if (!headerSkipped) {
          headerSkipped = true;
          return;
        }
        rowsProcessed++;
        const record = bmfRowToRecord(row, region);
        if (record) batch.push(record);
      });
      while (batch.length >= BATCH_SIZE) await submit(batch.splice(0, BATCH_SIZE));
      if (Date.now() - start > TIME_BUDGET_MS) {
        await reader.cancel().catch(() => {});
        await drain().catch(() => {});
        throw new Error(`time budget (${TIME_BUDGET_MS / 1000}s) reached after ${rowsProcessed} rows — region not finished; rows written so far are kept`);
      }
    }
    finishCsvStream(state, (row) => {
      rowsProcessed++;
      const record = bmfRowToRecord(row, region);
      if (record) batch.push(record);
    });
    while (batch.length > 0) await submit(batch.splice(0, BATCH_SIZE));
    await drain();

    await db
      .update(ingestRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        firmsProcessed: rowsProcessed,
        firmsInserted: rowsInserted,
        firmsUpdated: rowsUpdated,
      })
      .where(sql`${ingestRuns.id} = ${runId}`);

    return {
      region,
      rowsProcessed,
      rowsInserted,
      rowsUpdated,
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
        firmsInserted: rowsInserted,
        firmsUpdated: rowsUpdated,
      })
      .where(sql`${ingestRuns.id} = ${runId}`);
    throw err;
  }
}

async function upsertBatch(
  rows: NonprofitInsert[]
): Promise<{ inserted: number; updated: number }> {
  if (!db) throw new Error("Database not configured");
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  const inserted = await db
    .insert(nonprofits)
    .values(rows)
    .onConflictDoUpdate({
      target: nonprofits.ein,
      set: {
        name: sql`excluded.name`,
        inCareOf: sql`excluded.in_care_of`,
        street: sql`excluded.street`,
        city: sql`excluded.city`,
        state: sql`excluded.state`,
        zip: sql`excluded.zip`,
        groupCode: sql`excluded.group_code`,
        subsection: sql`excluded.subsection`,
        affiliation: sql`excluded.affiliation`,
        classification: sql`excluded.classification`,
        rulingDate: sql`excluded.ruling_date`,
        deductibility: sql`excluded.deductibility`,
        foundation: sql`excluded.foundation`,
        activityCodes: sql`excluded.activity_codes`,
        organizationCode: sql`excluded.organization_code`,
        statusCode: sql`excluded.status_code`,
        taxPeriod: sql`excluded.tax_period`,
        assetCode: sql`excluded.asset_code`,
        incomeCode: sql`excluded.income_code`,
        filingReqCode: sql`excluded.filing_req_code`,
        pfFilingReqCode: sql`excluded.pf_filing_req_code`,
        acctPeriod: sql`excluded.acct_period`,
        assetAmt: sql`excluded.asset_amt`,
        incomeAmt: sql`excluded.income_amt`,
        revenueAmt: sql`excluded.revenue_amt`,
        nteeCode: sql`excluded.ntee_code`,
        sortName: sql`excluded.sort_name`,
        region: sql`excluded.region`,
        lastUpdatedAt: sql`NOW()`,
      },
    });
  void inserted;
  return { inserted: rows.length, updated: 0 };
}
