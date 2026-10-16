/**
 * IRS Form 990 e-file loader — TEOS zip batches → Postgres.
 *
 * This module is written for a long-running Node process (GitHub Actions,
 * a desk machine, a laptop), NOT for a Vercel function: one IRS batch is
 * 50–500 MB of zipped XML and takes 5–40 minutes to load. It talks to Neon
 * over a real `pg` connection (not the HTTP driver) so multi-row inserts
 * and long sessions behave.
 *
 * IDEMPOTENCY
 *   `irs990_batches` is the ledger. `loadNewBatches()` diff-loads whatever the
 *   IRS index lists that we have not marked `ok`. Re-loading a batch replaces
 *   its filings (ON CONFLICT object_id) and their people (delete + insert),
 *   so a crashed run can simply be re-run.
 *
 * OBSERVABILITY
 *   Every batch also writes an `ingest_runs` row with source
 *   `irs-990/<batchId>`, so `database_status` → pipelineHealth and the
 *   console Status page see this family exactly like ADV / BMF / 5500.
 */

import { createWriteStream, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import AdmZip from "adm-zip";
import { Pool } from "pg";
import { parseReturnXml } from "./parse";
import type { ParsedFiling, ParsedPerson } from "./parse";

export const IRS_XML_BASE = "https://apps.irs.gov/pub/epostcard/990/xml";
export const DEFAULT_INDEX_YEARS = [2021, 2022, 2023, 2024, 2025, 2026];

const USER_AGENT =
  process.env.VISTAMARK_USER_AGENT ??
  "Vistamark Intel (vistamark-ria-intel; mrice@vistamarkllc.com)";

const FLUSH_EVERY = 400; // filings per insert round-trip (~4K person rows)

export interface IndexBatch {
  batchId: string;
  indexYear: number;
  url: string;
  indexedFilings: number;
  byType: Record<string, number>;
}

export interface LoadBatchResult {
  batchId: string;
  status: "ok" | "error";
  filesTotal: number;
  filingsLoaded: number;
  filingsSkipped: number;
  personsLoaded: number;
  parseErrors: number;
  bytes: number;
  durationMs: number;
  error?: string;
}

export interface LoaderOptions {
  databaseUrl?: string;
  runner?: string;
  log?: (line: string) => void;
  /** keep the downloaded zip (debugging) */
  keepZip?: boolean;
  /** stop after this many zip entries (dry runs) */
  maxEntries?: number;
}

function makePool(databaseUrl?: string): Pool {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not configured");
  return new Pool({
    connectionString: url,
    max: 2,
    ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 600_000,
  });
}

export function indexUrl(year: number): string {
  return `${IRS_XML_BASE}/${year}/index_${year}.csv`;
}
export function batchUrl(year: number, batchId: string): string {
  return `${IRS_XML_BASE}/${year}/${batchId}.zip`;
}

/**
 * Read the IRS yearly index and group it by zip batch. The index is the only
 * authoritative list of which zips exist for a year (the HTML page lags).
 */
export async function listIndexBatches(year: number): Promise<IndexBatch[]> {
  const res = await fetch(indexUrl(year), { headers: { "User-Agent": USER_AGENT } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${indexUrl(year)}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  const header = (lines.shift() ?? "").split(",");
  const iBatch = header.indexOf("XML_BATCH_ID");
  const iType = header.indexOf("RETURN_TYPE");
  if (iBatch < 0) throw new Error(`index_${year}.csv has no XML_BATCH_ID column`);
  const map = new Map<string, IndexBatch>();
  for (const line of lines) {
    if (!line) continue;
    // Index has no quoted commas in practice; TAXPAYER_NAME is the only free
    // text and the IRS strips commas. Guard anyway by taking the LAST column.
    const cols = line.split(",");
    const batchId = cols[cols.length - 1]?.trim();
    const type = cols[iType]?.trim() ?? "";
    if (!batchId || !/^\d{4}_TEOS_XML_/.test(batchId)) continue;
    let b = map.get(batchId);
    if (!b) {
      b = { batchId, indexYear: year, url: batchUrl(year, batchId), indexedFilings: 0, byType: {} };
      map.set(batchId, b);
    }
    b.indexedFilings++;
    b.byType[type] = (b.byType[type] ?? 0) + 1;
  }
  return [...map.values()].sort((a, b) => a.batchId.localeCompare(b.batchId));
}

async function downloadToFile(url: string, dest: string, log: (s: string) => void): Promise<number> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  log(`download ${url} (${total ? (total / 1e6).toFixed(0) + " MB" : "size unknown"})`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
  return statSync(dest).size;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const FILING_COLS = [
  "object_id", "batch_id", "ein", "return_type", "tax_year", "tax_period_begin", "tax_period_end",
  "return_ts", "amended_return", "final_return", "return_version", "org_name", "org_name2",
  "in_care_of", "address_line1", "address_line2", "city", "state", "zip", "country", "website",
  "phone", "formation_year", "mission", "gross_receipts", "total_revenue", "total_expenses",
  "total_assets_eoy", "total_liabilities_eoy", "net_assets_eoy", "contributions",
  "investment_income", "investments_public", "investments_other", "investments_program",
  "endowment_eoy", "invest_mgmt_fees", "voting_members", "independent_members", "employees", "volunteers",
  "officer_count", "signer_name", "signer_title",
] as const;

const PERSON_COLS = [
  "object_id", "ein", "tax_year", "seq", "name_raw", "name_norm", "surname", "is_business", "title",
  "avg_hours", "avg_hours_related", "is_individual_trustee", "is_institutional_trustee",
  "is_officer", "is_key_employee", "is_highest_comp", "is_former", "comp_org", "comp_related",
  "comp_other", "address_line1", "city", "state", "zip",
] as const;

function filingRow(objectId: string, batchId: string, f: ParsedFiling): unknown[] {
  return [
    objectId, batchId, f.ein, f.returnType, f.taxYear, f.taxPeriodBegin, f.taxPeriodEnd,
    f.returnTs, f.amendedReturn, f.finalReturn, f.returnVersion, f.orgName, f.orgName2,
    f.inCareOf, f.addressLine1, f.addressLine2, f.city, f.state, f.zip, f.country, f.website,
    f.phone, f.formationYear, f.mission, f.grossReceipts, f.totalRevenue, f.totalExpenses,
    f.totalAssetsEoy, f.totalLiabilitiesEoy, f.netAssetsEoy, f.contributions,
    f.investmentIncome, f.investmentsPublic, f.investmentsOther, f.investmentsProgram,
    f.endowmentEoy, f.investMgmtFees, f.votingMembers, f.independentMembers, f.employees, f.volunteers,
    f.persons.length, f.signerName, f.signerTitle,
  ];
}

function personRow(objectId: string, f: ParsedFiling, p: ParsedPerson): unknown[] {
  return [
    objectId, f.ein, f.taxYear, p.seq, p.nameRaw, p.nameNorm, p.surname, p.isBusiness, p.title,
    p.avgHours, p.avgHoursRelated, p.isIndividualTrustee, p.isInstitutionalTrustee,
    p.isOfficer, p.isKeyEmployee, p.isHighestComp, p.isFormer, p.compOrg, p.compRelated,
    p.compOther, p.addressLine1, p.city, p.state, p.zip,
  ];
}

/** Build a multi-row VALUES insert: ($1,$2,...),($n,...) */
function multiInsert(table: string, cols: readonly string[], rows: unknown[][], onConflict: string): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples: string[] = [];
  let i = 1;
  for (const r of rows) {
    const ph: string[] = [];
    for (const v of r) {
      values.push(v);
      ph.push(`$${i++}`);
    }
    tuples.push(`(${ph.join(",")})`);
  }
  return {
    text: `INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")} ${onConflict}`,
    values,
  };
}

const FILING_UPSERT =
  "ON CONFLICT (object_id) DO UPDATE SET " +
  FILING_COLS.filter((c) => c !== "object_id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ") +
  ", loaded_at = NOW()";

async function flushBatch(
  pool: Pool,
  batchId: string,
  pending: Array<{ objectId: string; filing: ParsedFiling }>
): Promise<{ filings: number; persons: number }> {
  if (pending.length === 0) return { filings: 0, persons: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Postgres caps bind params at 65535; 400 filings × 44 cols = 17.6K, fine.
    const fq = multiInsert("irs990_filings", FILING_COLS, pending.map((p) => filingRow(p.objectId, batchId, p.filing)), FILING_UPSERT);
    await client.query(fq.text, fq.values);
    await client.query("DELETE FROM irs990_persons WHERE object_id = ANY($1::text[])", [pending.map((p) => p.objectId)]);
    const personRows: unknown[][] = [];
    for (const p of pending) for (const person of p.filing.persons) personRows.push(personRow(p.objectId, p.filing, person));
    // 24 cols → ≤ 2700 rows per statement under the 65535 param cap
    for (let i = 0; i < personRows.length; i += 2500) {
      const pq = multiInsert("irs990_persons", PERSON_COLS, personRows.slice(i, i + 2500), "");
      await client.query(pq.text, pq.values);
    }
    await client.query("COMMIT");
    return { filings: pending.length, persons: personRows.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// batch loader
// ---------------------------------------------------------------------------

export async function loadBatch(batch: IndexBatch, opts: LoaderOptions = {}): Promise<LoadBatchResult> {
  const log = opts.log ?? ((s) => console.log(`[irs990] ${s}`));
  const pool = makePool(opts.databaseUrl);
  const started = Date.now();
  const runner = opts.runner ?? (process.env.GITHUB_RUN_ID ? `github-actions:${process.env.GITHUB_RUN_ID}` : "local");
  const errors: Array<{ entry: string; error: string }> = [];
  let filesTotal = 0, filingsLoaded = 0, filingsSkipped = 0, personsLoaded = 0, parseErrors = 0, bytes = 0;

  await pool.query(
    `INSERT INTO irs990_batches (batch_id, index_year, url, status, started_at, finished_at, runner,
       files_total, filings_loaded, filings_skipped, persons_loaded, parse_errors, error_sample, error_message)
     VALUES ($1,$2,$3,'running',NOW(),NULL,$4,0,0,0,0,0,NULL,NULL)
     ON CONFLICT (batch_id) DO UPDATE SET status='running', started_at=NOW(), finished_at=NULL, runner=EXCLUDED.runner,
       files_total=0, filings_loaded=0, filings_skipped=0, persons_loaded=0, parse_errors=0, error_sample=NULL, error_message=NULL`,
    [batch.batchId, batch.indexYear, batch.url, runner]
  );
  const runRow = await pool.query(
    `INSERT INTO ingest_runs (source, status) VALUES ($1, 'running') RETURNING id`,
    [`irs-990/${batch.batchId}`]
  );
  const runId = runRow.rows[0].id as number;

  const dir = mkdtempSync(join(tmpdir(), "irs990-"));
  const zipPath = join(dir, `${batch.batchId}.zip`);

  const progress = async () => {
    await pool.query(
      `UPDATE irs990_batches SET files_total=$2, filings_loaded=$3, filings_skipped=$4, persons_loaded=$5, parse_errors=$6, bytes=$7 WHERE batch_id=$1`,
      [batch.batchId, filesTotal, filingsLoaded, filingsSkipped, personsLoaded, parseErrors, bytes]
    );
  };

  try {
    bytes = await downloadToFile(batch.url, zipPath, log);
    log(`${batch.batchId}: ${(bytes / 1e6).toFixed(1)} MB downloaded, opening`);
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.xml$/i.test(e.entryName));
    filesTotal = entries.length;
    log(`${batch.batchId}: ${filesTotal} xml entries (index says ${batch.indexedFilings})`);

    let pending: Array<{ objectId: string; filing: ParsedFiling }> = [];
    let n = 0;
    for (const entry of entries) {
      if (opts.maxEntries && n >= opts.maxEntries) break;
      n++;
      const objectId = entry.entryName.replace(/^.*\//, "").replace(/_public\.xml$/i, "").replace(/\.xml$/i, "");
      let xml: string;
      try {
        xml = entry.getData().toString("utf8");
      } catch (err) {
        parseErrors++;
        if (errors.length < 25) errors.push({ entry: entry.entryName, error: `unzip: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const r = parseReturnXml(xml);
      if (!r.ok) {
        if (r.skip === "990T") filingsSkipped++;
        else {
          parseErrors++;
          if (errors.length < 25) errors.push({ entry: entry.entryName, error: r.skip });
        }
        continue;
      }
      pending.push({ objectId, filing: r.filing });
      if (pending.length >= FLUSH_EVERY) {
        const f = await flushBatch(pool, batch.batchId, pending);
        filingsLoaded += f.filings;
        personsLoaded += f.persons;
        pending = [];
        if (filingsLoaded % (FLUSH_EVERY * 10) === 0) {
          await progress();
          log(`${batch.batchId}: ${filingsLoaded}/${filesTotal} filings, ${personsLoaded} people, ${parseErrors} errors`);
        }
      }
    }
    const f = await flushBatch(pool, batch.batchId, pending);
    filingsLoaded += f.filings;
    personsLoaded += f.persons;

    await pool.query(
      `UPDATE irs990_batches SET status='ok', finished_at=NOW(), files_total=$2, filings_loaded=$3, filings_skipped=$4,
         persons_loaded=$5, parse_errors=$6, bytes=$7, error_sample=$8 WHERE batch_id=$1`,
      [batch.batchId, filesTotal, filingsLoaded, filingsSkipped, personsLoaded, parseErrors, bytes, errors.length ? JSON.stringify(errors) : null]
    );
    await pool.query(
      `UPDATE ingest_runs SET status='ok', finished_at=NOW(), firms_processed=$2, firms_inserted=$3, firms_updated=$4 WHERE id=$1`,
      [runId, filesTotal, filingsLoaded, personsLoaded]
    );
    log(`${batch.batchId}: done — ${filingsLoaded} filings, ${personsLoaded} people, ${filingsSkipped} skipped (990-T), ${parseErrors} parse errors, ${((Date.now() - started) / 1000).toFixed(0)}s`);
    return { batchId: batch.batchId, status: "ok", filesTotal, filingsLoaded, filingsSkipped, personsLoaded, parseErrors, bytes, durationMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE irs990_batches SET status='error', finished_at=NOW(), files_total=$2, filings_loaded=$3, filings_skipped=$4,
         persons_loaded=$5, parse_errors=$6, bytes=$7, error_sample=$8, error_message=$9 WHERE batch_id=$1`,
      [batch.batchId, filesTotal, filingsLoaded, filingsSkipped, personsLoaded, parseErrors, bytes, errors.length ? JSON.stringify(errors) : null, message.slice(0, 2000)]
    ).catch(() => undefined);
    await pool.query(
      `UPDATE ingest_runs SET status='error', finished_at=NOW(), error_message=$2, firms_processed=$3, firms_inserted=$4, firms_updated=$5 WHERE id=$1`,
      [runId, message.slice(0, 2000), filesTotal, filingsLoaded, personsLoaded]
    ).catch(() => undefined);
    log(`${batch.batchId}: FAILED — ${message}`);
    return { batchId: batch.batchId, status: "error", filesTotal, filingsLoaded, filingsSkipped, personsLoaded, parseErrors, bytes, durationMs: Date.now() - started, error: message };
  } finally {
    if (!opts.keepZip) rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

/** Batches the IRS index lists for `years` that are not marked ok in our ledger. */
export async function findNewBatches(years: number[], opts: LoaderOptions = {}): Promise<IndexBatch[]> {
  const pool = makePool(opts.databaseUrl);
  try {
    const done = await pool.query(`SELECT batch_id FROM irs990_batches WHERE status = 'ok'`);
    const doneSet = new Set(done.rows.map((r) => String(r.batch_id)));
    const out: IndexBatch[] = [];
    for (const y of years) {
      const batches = await listIndexBatches(y);
      for (const b of batches) if (!doneSet.has(b.batchId)) out.push(b);
    }
    return out;
  } finally {
    await pool.end();
  }
}

export async function loadNewBatches(years: number[], opts: LoaderOptions & { maxBatches?: number } = {}): Promise<LoadBatchResult[]> {
  const log = opts.log ?? ((s) => console.log(`[irs990] ${s}`));
  const todo = await findNewBatches(years, opts);
  log(`${todo.length} batch(es) to load across ${years.join(",")}: ${todo.map((b) => b.batchId).join(" ") || "(none)"}`);
  const results: LoadBatchResult[] = [];
  for (const b of todo.slice(0, opts.maxBatches ?? todo.length)) {
    results.push(await loadBatch(b, opts));
  }
  return results;
}
