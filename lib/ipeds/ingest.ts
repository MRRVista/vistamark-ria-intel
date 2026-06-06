/**
 * IPEDS Finance Survey + Directory ingest pipeline.
 *
 * Strategy:
 *   1. Download a single annual zip from NCES (HD{YYYY}.zip or F{YY}{YY}_F2.zip etc.)
 *   2. Unzip in-memory via adm-zip (IPEDS zips contain exactly one CSV)
 *   3. Stream-parse the CSV row-by-row using the same primitives as DOL 5500
 *   4. Batch-upsert 500 rows at a time using ON CONFLICT DO UPDATE
 *
 * One Vercel function call ingests one (year, fileType) tuple. Each call
 * processes ~6,400 rows (directory) or ~2,000 rows (F2 finance, only schools
 * with endowments). Comfortably under the 300s maxDuration ceiling.
 */

import AdmZip from "adm-zip";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  ipedsInstitutions,
  endowments,
  ingestRuns,
} from "../db/schema";
import type {
  IpedsInstitutionInsert,
  EndowmentInsert,
} from "../db/schema";
import { politeFetch } from "../data/http";
import {
  buildHeaderIndex,
  consumeCsvChunk,
  finishCsvStream,
  newStreamState,
  hdRowToRecord,
  financeRowToRecord,
} from "./parser";
import {
  directoryUrl,
  financeUrl,
  DEFAULT_FINANCE_YEARS,
  DEFAULT_DIRECTORY_YEAR,
} from "./columns";
import type { IpedsFinanceFile } from "./columns";

const SOURCE_PREFIX = "ipeds";
const BATCH_SIZE = 500;

export interface IngestResult {
  source: string;
  url: string;
  rowsProcessed: number;
  rowsUpserted: number;
  rowsSkippedNoKey: number;
  headerSample: string[];
  firstRowSample: string[];
  durationMs: number;
}

async function downloadCsv(url: string): Promise<Buffer> {
  const res = await politeFetch(url, { timeoutMs: 240_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buffer);
  // IPEDS zips contain exactly one .csv plus optional revised .csv (rv_ prefix).
  // Prefer the revised version when available (institutions revised data the
  // following year), since it's the more accurate "final" reading.
  const entries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && /\.csv$/i.test(e.entryName));
  if (entries.length === 0) {
    throw new Error(`No CSV in ${url}`);
  }
  const revised = entries.find((e) => /^rv_/i.test(e.entryName));
  const chosen = revised ?? entries[0]!;
  return chosen.getData();
}

export async function ingestDirectory(year: number): Promise<IngestResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  const url = directoryUrl(year);
  const source = `${SOURCE_PREFIX}/hd/${year}`;

  const runInsert = await db
    .insert(ingestRuns)
    .values({ source, status: "running" })
    .returning({ id: ingestRuns.id });
  const runId = runInsert[0]!.id;

  let rowsProcessed = 0;
  let rowsUpserted = 0;
  let rowsSkippedNoKey = 0;
  let headerSample: string[] = [];
  let firstRowSample: string[] = [];

  try {
    const csvBuffer = await downloadCsv(url);
    const state = newStreamState();
    const decoder = new TextDecoder("latin1");
    let headerIndex: Record<string, number> | null = null;
    let batch: IpedsInstitutionInsert[] = [];

    const CHUNK = 4 * 1024 * 1024;
    for (let offset = 0; offset < csvBuffer.length; offset += CHUNK) {
      const slice = csvBuffer.subarray(offset, Math.min(offset + CHUNK, csvBuffer.length));
      const text = decoder.decode(slice, { stream: true });
      consumeCsvChunk(state, text, (row) => {
        if (!headerIndex) {
          headerSample = row.slice(0, 10).map((c) => c.slice(0, 32));
          headerIndex = buildHeaderIndex(row);
          return;
        }
        rowsProcessed++;
        if (firstRowSample.length === 0) {
          firstRowSample = row.slice(0, 10).map((c) => c.slice(0, 32));
        }
        const record = hdRowToRecord(row, headerIndex);
        if (record) batch.push(record);
        else rowsSkippedNoKey++;
      });
      while (batch.length >= BATCH_SIZE) {
        const chunk = batch.splice(0, BATCH_SIZE);
        await upsertInstitutions(chunk);
        rowsUpserted += chunk.length;
      }
    }
    finishCsvStream(state, (row) => {
      if (!headerIndex) {
        headerSample = row.slice(0, 10).map((c) => c.slice(0, 32));
        headerIndex = buildHeaderIndex(row);
        return;
      }
      rowsProcessed++;
      if (firstRowSample.length === 0) {
        firstRowSample = row.slice(0, 10).map((c) => c.slice(0, 32));
      }
      const record = hdRowToRecord(row, headerIndex);
      if (record) batch.push(record);
      else rowsSkippedNoKey++;
    });
    if (batch.length > 0) {
      await upsertInstitutions(batch);
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
      firstRowSample,
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

export async function ingestFinance(
  fyear: number,
  fileType: IpedsFinanceFile
): Promise<IngestResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();
  const url = financeUrl(fyear, fileType);
  const source = `${SOURCE_PREFIX}/${fileType.toLowerCase()}/${fyear}`;

  const runInsert = await db
    .insert(ingestRuns)
    .values({ source, status: "running" })
    .returning({ id: ingestRuns.id });
  const runId = runInsert[0]!.id;

  let rowsProcessed = 0;
  let rowsUpserted = 0;
  let rowsSkippedNoKey = 0;
  let headerSample: string[] = [];
  let firstRowSample: string[] = [];

  try {
    const csvBuffer = await downloadCsv(url);
    const state = newStreamState();
    const decoder = new TextDecoder("latin1");
    let headerIndex: Record<string, number> | null = null;
    let batch: EndowmentInsert[] = [];

    const CHUNK = 4 * 1024 * 1024;
    for (let offset = 0; offset < csvBuffer.length; offset += CHUNK) {
      const slice = csvBuffer.subarray(offset, Math.min(offset + CHUNK, csvBuffer.length));
      const text = decoder.decode(slice, { stream: true });
      consumeCsvChunk(state, text, (row) => {
        if (!headerIndex) {
          headerSample = row.slice(0, 10).map((c) => c.slice(0, 32));
          headerIndex = buildHeaderIndex(row);
          return;
        }
        rowsProcessed++;
        if (firstRowSample.length === 0) {
          firstRowSample = row.slice(0, 10).map((c) => c.slice(0, 32));
        }
        const record = financeRowToRecord(row, headerIndex, fyear, fileType);
        if (record) batch.push(record);
        else rowsSkippedNoKey++;
      });
      while (batch.length >= BATCH_SIZE) {
        const chunk = batch.splice(0, BATCH_SIZE);
        await upsertEndowments(chunk);
        rowsUpserted += chunk.length;
      }
    }
    finishCsvStream(state, (row) => {
      if (!headerIndex) {
        headerSample = row.slice(0, 10).map((c) => c.slice(0, 32));
        headerIndex = buildHeaderIndex(row);
        return;
      }
      rowsProcessed++;
      if (firstRowSample.length === 0) {
        firstRowSample = row.slice(0, 10).map((c) => c.slice(0, 32));
      }
      const record = financeRowToRecord(row, headerIndex, fyear, fileType);
      if (record) batch.push(record);
      else rowsSkippedNoKey++;
    });
    if (batch.length > 0) {
      await upsertEndowments(batch);
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
      firstRowSample,
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

async function upsertInstitutions(rows: IpedsInstitutionInsert[]): Promise<void> {
  if (!db || rows.length === 0) return;
  await db
    .insert(ipedsInstitutions)
    .values(rows)
    .onConflictDoUpdate({
      target: ipedsInstitutions.unitid,
      set: {
        instnm: sql`excluded.instnm`,
        city: sql`excluded.city`,
        state: sql`excluded.state`,
        zip: sql`excluded.zip`,
        sector: sql`excluded.sector`,
        control: sql`excluded.control`,
        iclevel: sql`excluded.iclevel`,
        obereg: sql`excluded.obereg`,
        webaddr: sql`excluded.webaddr`,
        closedDate: sql`excluded.closed_date`,
        lastUpdatedAt: sql`NOW()`,
      },
    });
}

async function upsertEndowments(rows: EndowmentInsert[]): Promise<void> {
  if (!db || rows.length === 0) return;
  await db
    .insert(endowments)
    .values(rows)
    .onConflictDoUpdate({
      target: [endowments.unitid, endowments.fyear],
      set: {
        fileType: sql`excluded.file_type`,
        marketValueBoy: sql`excluded.market_value_boy`,
        marketValueEoy: sql`excluded.market_value_eoy`,
        contributions: sql`excluded.contributions`,
        netInvestmentReturn: sql`excluded.net_investment_return`,
        withdrawals: sql`excluded.withdrawals`,
        otherAdjustments: sql`excluded.other_adjustments`,
        lastUpdatedAt: sql`NOW()`,
      },
    });
}

/**
 * Pick the next (year, fileType) tuple to ingest. Strategy: walk through the
 * default backfill list of (year, F2), (year, F1A) pairs from most recent
 * back to oldest, returning the first one without a successful run yet.
 *
 * extraSkip lets the caller mark sources to skip within the current session
 * (e.g. ones that just 404'd or errored this run). Pass it as a set of
 * source identifiers like "ipeds/f2/2024".
 *
 * Returns null when nothing left to try.
 */
export async function pickNextFinance(
  extraSkip?: Set<string>
): Promise<{ fyear: number; fileType: IpedsFinanceFile } | null> {
  if (!db) throw new Error("Database not configured");
  const okRuns = await db.execute(sql`
    SELECT source FROM ingest_runs
    WHERE status = 'ok' AND source LIKE ${`${SOURCE_PREFIX}/%`} AND firms_inserted > 0
  `);
  const done = new Set<string>();
  for (const r of (okRuns as any).rows ?? []) {
    done.add(String(r.source));
  }

  const years = [...DEFAULT_FINANCE_YEARS].reverse();
  const files: IpedsFinanceFile[] = ["F2", "F1A"];

  for (const fyear of years) {
    for (const fileType of files) {
      const source = `${SOURCE_PREFIX}/${fileType.toLowerCase()}/${fyear}`;
      if (done.has(source)) continue;
      if (extraSkip?.has(source)) continue;
      return { fyear, fileType };
    }
  }
  return null;
}

export async function isDirectoryNeeded(): Promise<boolean> {
  if (!db) return false;
  // Treat the directory as "done" only if a successful run is on file AND
  // it actually upserted some rows. The earlier v0.4.2 run created an 'ok'
  // ingest_runs entry with 0 inserted rows (BOM-corrupted headers), which
  // would otherwise cause this function to wrongly return false.
  const okRuns = await db.execute(sql`
    SELECT firms_inserted FROM ingest_runs
    WHERE status = 'ok' AND source = ${`${SOURCE_PREFIX}/hd/${DEFAULT_DIRECTORY_YEAR}`}
      AND firms_inserted > 0
    LIMIT 1
  `);
  return ((okRuns as any).rows ?? []).length === 0;
}

export { DEFAULT_DIRECTORY_YEAR, DEFAULT_FINANCE_YEARS };
