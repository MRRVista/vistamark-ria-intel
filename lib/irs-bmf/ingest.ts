/**
 * IRS EO BMF ingest pipeline.
 *
 * Strategy: stream each regional CSV (eo1..eo4, eo_pr, eo_xx) row-by-row,
 * batch into chunks of 500 NonprofitInsert records, upsert to Postgres
 * with onConflictDoUpdate keyed on EIN.
 *
 * Memory: streaming keeps RSS below ~150 MB even on the largest region (eo4,
 *         ~500K rows). The whole file is never held in memory.
 * Time:   each region takes 60–120s wall-clock against Neon HTTP (network
 *         dominates). Vercel function maxDuration is 300s; we process one
 *         region per cron tick to leave plenty of headroom.
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

export interface IngestRegionResult {
  region: BmfRegion;
  rowsProcessed: number;
  rowsInserted: number;
  rowsUpdated: number;
  durationMs: number;
}

/**
 * Pick which region to process next. Strategy: oldest successful run wins
 * (so we round-robin through all 6 regions over time). If a region has never
 * been ingested, that one goes first.
 */
export async function pickNextRegion(): Promise<BmfRegion> {
  if (!db) throw new Error("Database not configured");
  const latestRuns = await db.execute(sql`
    SELECT source, MAX(finished_at) AS last_done
    FROM ingest_runs
    WHERE status = 'ok' AND source LIKE ${`${SOURCE_PREFIX}/%`}
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

    const flush = async () => {
      if (batch.length === 0) return;
      const result = await upsertBatch(batch);
      rowsInserted += result.inserted;
      rowsUpdated += result.updated;
      batch = [];
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
      while (batch.length >= BATCH_SIZE) {
        const chunk = batch.splice(0, BATCH_SIZE);
        const result = await upsertBatch(chunk);
        rowsInserted += result.inserted;
        rowsUpdated += result.updated;
      }
    }
    finishCsvStream(state, (row) => {
      rowsProcessed++;
      const record = bmfRowToRecord(row, region);
      if (record) batch.push(record);
    });
    await flush();

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
