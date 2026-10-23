/**
 * IRS Exempt-Organization "extras" loader — Pub 78 / Auto-Revocation / 990-N.
 *
 * Written for a long-running Node process (GitHub Actions, a laptop), NOT a
 * Vercel function: the three zips are 30 / 48 / 93 MB and inflate to
 * 100 / 148 / 286 MB of pipe-delimited text. Talks to Postgres over `pg`.
 *
 * PIPELINE (per dataset)
 *   1. stream the zip to a temp file (fetch → fs)                ~2–30 s
 *   2. locate the single entry via the zip central directory and stream that
 *      byte range through zlib.createInflateRaw → readline; the inflated text
 *      never sits in memory (no adm-zip here — it would buffer 286 MB).
 *   3. parse each line, batch rows, INSERT ... SELECT FROM unnest($1::text[], …)
 *      into <table>_new (one bind parameter per column, so 10K rows/statement).
 *   4. build the indexes on <table>_new, then in ONE transaction drop the live
 *      table, rename _new → live and rename indexes/constraints to the
 *      canonical names from migrations/0011. Readers see either the old or
 *      the new table, never a half-loaded one (full-refresh semantics).
 *
 * LEDGER / OBSERVABILITY
 *   irs_eo_extras_loads gets a row per (dataset, run); ingest_runs gets a row
 *   with source 'irs-eo-extras/<dataset>' so database_status / the console
 *   Status page see this exactly like ADV / BMF / 5500 / 990.
 */

import { createReadStream, createWriteStream, mkdtempSync, openSync, readSync, closeSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createInterface } from "readline";
import { createInflateRaw } from "zlib";
import { Pool } from "pg";

export type Dataset = "pub78" | "revocation" | "990n";
export const DATASETS: Dataset[] = ["pub78", "revocation", "990n"];

export const DATASET_URLS: Record<Dataset, string> = {
  pub78: "https://apps.irs.gov/pub/epostcard/data-download-pub78.zip",
  revocation: "https://apps.irs.gov/pub/epostcard/data-download-revocation.zip",
  "990n": "https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip",
};

export const DATASET_TABLES: Record<Dataset, string> = {
  pub78: "irs_pub78",
  revocation: "irs_eo_revocations",
  "990n": "irs_990n",
};

const USER_AGENT =
  process.env.VISTAMARK_USER_AGENT ??
  "Vistamark Intel (vistamark-ria-intel; mrice@vistamarkllc.com)";

const BATCH_ROWS = 10_000;

// ---------------------------------------------------------------------------
// column specs — one entry per table column, in order; `pg` is the SQL type
// used in the unnest() cast. Index specs mirror migrations/0011 exactly.
// ---------------------------------------------------------------------------

interface ColSpec { name: string; pg: "text" | "date" | "boolean" | "smallint" }
interface IndexSpec { name: string; def: string } // def = "USING GIN (name gin_trgm_ops)" | "(state, city)"

interface TableSpec {
  table: string;
  pk: string[];
  cols: ColSpec[];
  indexes: IndexSpec[];
}

const PUB78_SPEC: TableSpec = {
  table: "irs_pub78",
  pk: ["ein"],
  cols: [
    { name: "ein", pg: "text" }, { name: "name", pg: "text" }, { name: "city", pg: "text" },
    { name: "state", pg: "text" }, { name: "country", pg: "text" }, { name: "deductibility_codes", pg: "text" },
  ],
  indexes: [
    { name: "irs_pub78_state_idx", def: "(state, city)" },
    { name: "irs_pub78_name_trgm_idx", def: "USING GIN (name gin_trgm_ops)" },
  ],
};

const REVOCATION_SPEC: TableSpec = {
  table: "irs_eo_revocations",
  pk: ["ein", "revocation_date"],
  cols: [
    { name: "ein", pg: "text" }, { name: "revocation_date", pg: "date" }, { name: "name", pg: "text" },
    { name: "dba", pg: "text" }, { name: "address", pg: "text" }, { name: "city", pg: "text" },
    { name: "state", pg: "text" }, { name: "zip", pg: "text" }, { name: "country", pg: "text" },
    { name: "exemption_type", pg: "text" }, { name: "posting_date", pg: "date" },
    { name: "reinstatement_date", pg: "date" }, { name: "reinstatement_type", pg: "text" },
  ],
  indexes: [
    { name: "irs_eo_revocations_state_idx", def: "(state, city)" },
    { name: "irs_eo_revocations_date_idx", def: "(revocation_date DESC)" },
    { name: "irs_eo_revocations_name_trgm_idx", def: "USING GIN (name gin_trgm_ops)" },
    { name: "irs_eo_revocations_zip_idx", def: "(zip varchar_pattern_ops)" },
  ],
};

const N990_SPEC: TableSpec = {
  table: "irs_990n",
  pk: ["ein", "tax_year"],
  cols: [
    { name: "ein", pg: "text" }, { name: "tax_year", pg: "smallint" }, { name: "name", pg: "text" },
    { name: "gross_receipts_under_50k", pg: "boolean" }, { name: "terminated", pg: "boolean" },
    { name: "tax_period_begin", pg: "date" }, { name: "tax_period_end", pg: "date" }, { name: "website", pg: "text" },
    { name: "officer_name", pg: "text" }, { name: "officer_address1", pg: "text" }, { name: "officer_address2", pg: "text" },
    { name: "officer_city", pg: "text" }, { name: "officer_province", pg: "text" }, { name: "officer_state", pg: "text" },
    { name: "officer_zip", pg: "text" }, { name: "officer_country", pg: "text" },
    { name: "org_address1", pg: "text" }, { name: "org_address2", pg: "text" }, { name: "org_city", pg: "text" },
    { name: "org_province", pg: "text" }, { name: "org_state", pg: "text" }, { name: "org_zip", pg: "text" },
    { name: "org_country", pg: "text" }, { name: "dba1", pg: "text" }, { name: "dba2", pg: "text" }, { name: "dba3", pg: "text" },
  ],
  indexes: [
    { name: "irs_990n_org_state_idx", def: "(org_state, org_zip)" },
    { name: "irs_990n_officer_state_idx", def: "(officer_state, officer_zip)" },
    { name: "irs_990n_tax_year_idx", def: "(tax_year)" },
    { name: "irs_990n_org_zip_idx", def: "(org_zip varchar_pattern_ops)" },
    { name: "irs_990n_officer_zip_idx", def: "(officer_zip varchar_pattern_ops)" },
    { name: "irs_990n_name_trgm_idx", def: "USING GIN (name gin_trgm_ops)" },
    { name: "irs_990n_officer_trgm_idx", def: "USING GIN (officer_name gin_trgm_ops)" },
  ],
};

export const SPECS: Record<Dataset, TableSpec> = { pub78: PUB78_SPEC, revocation: REVOCATION_SPEC, "990n": N990_SPEC };

// ---------------------------------------------------------------------------
// line parsers — return a row (array aligned with spec.cols) or a reject reason
// ---------------------------------------------------------------------------

type Row = (string | number | boolean | null)[];
type Parsed = { row: Row } | { reject: string };

const MON: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

const blank = (s: string | undefined): string | null => {
  const t = (s ?? "").trim();
  return t.length ? t : null;
};
/** blank() clipped to a column width (free-text fields occasionally overflow the IRS layout). */
const clip = (s: string | undefined, n: number): string | null => {
  const t = blank(s);
  return t && t.length > n ? t.slice(0, n) : t;
};
const code2 = (s: string | undefined, n = 8): string | null => clip(s, n)?.toUpperCase() ?? null;
const ein9 = (s: string): string | null => {
  const d = s.replace(/\D/g, "");
  return d.length === 9 ? d : d.length > 0 && d.length < 9 ? d.padStart(9, "0") : null;
};
/** DD-MON-YYYY → YYYY-MM-DD (revocation file) */
export function dateDMonY(s: string | undefined): string | null | "bad" {
  const t = (s ?? "").trim();
  if (!t) return null;
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/i.exec(t);
  if (!m || !MON[m[2].toUpperCase()]) return "bad";
  return `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
}
/** MM-DD-YYYY → YYYY-MM-DD (990-N file) */
export function dateMDY(s: string | undefined): string | null | "bad" {
  const t = (s ?? "").trim();
  if (!t) return null;
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(t);
  if (!m) return "bad";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** EIN|name|city|state|country|deductibility codes */
export function parsePub78Line(line: string): Parsed {
  const f = line.split("|");
  if (f.length !== 6) return { reject: `expected 6 fields, got ${f.length}` };
  const ein = ein9(f[0]);
  if (!ein) return { reject: "bad EIN" };
  if (!blank(f[1])) return { reject: "blank name" };
  return { row: [ein, f[1].trim(), clip(f[2], 128), code2(f[3], 4), clip(f[4], 64), (clip(f[5], 64) ?? "UNKWN").toUpperCase()] };
}

/** EIN|name|DBA|address|city|state|zip|country|exemption type|revocation date|posting date|reinstatement date */
export function parseRevocationLine(line: string): Parsed {
  const f = line.split("|");
  if (f.length < 12 || f.length > 13) return { reject: `expected 12 fields, got ${f.length}` };
  const ein = ein9(f[0]);
  if (!ein) return { reject: "bad EIN" };
  const rev = dateDMonY(f[9]);
  if (rev === "bad" || rev === null) return { reject: `bad revocation date '${f[9]}'` };
  const post = dateDMonY(f[10]);
  const rein = dateDMonY(f[11]);
  return {
    row: [
      ein, rev, blank(f[1]) ?? "(unnamed)", blank(f[2]), blank(f[3]), clip(f[4], 128), code2(f[5], 4),
      clip(f[6], 32), code2(f[7], 8), clip(f[8], 4), post === "bad" ? null : post, rein === "bad" ? null : rein,
      f.length === 13 ? clip(f[12], 16) : null,
    ],
  };
}

/**
 * EIN|tax year|name|gross receipts ≤$50K (T/F)|terminated (T/F)|period begin|period end|website|
 * officer name|officer addr1|officer addr2|officer city|officer province|officer state|officer zip|officer country|
 * org addr1|org addr2|org city|org province|org state|org zip|org country|DBA1|DBA2|DBA3   (26 fields)
 * The website field is free text and occasionally contains '|' — extra fields are folded back into it.
 */
export function parse990nLine(line: string): Parsed {
  let f = line.split("|");
  if (f.length < 26) return { reject: `expected 26 fields, got ${f.length}` };
  if (f.length > 26) {
    const extra = f.length - 26;
    f = [...f.slice(0, 7), f.slice(7, 8 + extra).join("|"), ...f.slice(8 + extra)];
  }
  const ein = ein9(f[0]);
  if (!ein) return { reject: "bad EIN" };
  const year = Number(f[1]);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { reject: `bad tax year '${f[1]}'` };
  const tf = (s: string): boolean | null => (s === "T" ? true : s === "F" ? false : null);
  const pb = dateMDY(f[5]);
  const pe = dateMDY(f[6]);
  return {
    row: [
      ein, year, blank(f[2]) ?? "(unnamed)", tf(f[3].trim()), tf(f[4].trim()) ?? false,
      pb === "bad" ? null : pb, pe === "bad" ? null : pe, blank(f[7]),
      blank(f[8]), blank(f[9]), blank(f[10]), clip(f[11], 128), clip(f[12], 64), code2(f[13], 8), clip(f[14], 32), code2(f[15], 8),
      blank(f[16]), blank(f[17]), clip(f[18], 128), clip(f[19], 64), code2(f[20], 8), clip(f[21], 32), code2(f[22], 8),
      blank(f[23]), blank(f[24]), blank(f[25]),
    ],
  };
}

export const PARSERS: Record<Dataset, (line: string) => Parsed> = {
  pub78: parsePub78Line,
  revocation: parseRevocationLine,
  "990n": parse990nLine,
};

// ---------------------------------------------------------------------------
// zip: find the single entry via the central directory, stream it inflated
// ---------------------------------------------------------------------------

interface ZipEntry { name: string; method: number; compressedSize: number; uncompressedSize: number; dataOffset: number }

export function locateZipEntry(zipPath: string): ZipEntry {
  const size = statSync(zipPath).size;
  const fd = openSync(zipPath, "r");
  try {
    const tailLen = Math.min(size, 66_000);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${zipPath}: no end-of-central-directory record (not a zip?)`);
    const cdEntries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error(`${zipPath}: zip64 archive not supported by this loader`);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    const entries: ZipEntry[] = [];
    for (let n = 0; n < cdEntries && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error(`${zipPath}: zip64 entry not supported`);
      // local header: 30 bytes + name + extra (local extra length can differ from central)
      const lh = Buffer.alloc(30);
      readSync(fd, lh, 0, 30, localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`${zipPath}: bad local header for ${name}`);
      const dataOffset = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (!name.endsWith("/")) entries.push({ name, method, compressedSize, uncompressedSize, dataOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    const txt = entries.filter((e) => /\.txt$/i.test(e.name));
    const pick = txt[0] ?? entries[0];
    if (!pick) throw new Error(`${zipPath}: zip has no file entries`);
    if (pick.method !== 8 && pick.method !== 0) throw new Error(`${zipPath}: unsupported compression method ${pick.method} for ${pick.name}`);
    return pick;
  } finally {
    closeSync(fd);
  }
}

/** Async line iterator over the (single) text entry of a zip, without inflating it to memory. */
export function zipLines(zipPath: string): { entry: ZipEntry; lines: AsyncIterable<string> } {
  const entry = locateZipEntry(zipPath);
  const raw = createReadStream(zipPath, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1, highWaterMark: 1 << 20 });
  const src = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  raw.on("error", (e) => src.emit("error", e));
  const rl = createInterface({ input: src, crlfDelay: Infinity });
  return { entry, lines: rl };
}

async function downloadToFile(url: string, dest: string, log: (s: string) => void): Promise<{ bytes: number; lastModified: string | null }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/zip,*/*" } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} fetching ${url}`);
      const total = Number(res.headers.get("content-length") ?? 0);
      log(`download ${url} (${total ? (total / 1e6).toFixed(0) + " MB" : "size unknown"})`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
      const bytes = statSync(dest).size;
      if (total && bytes !== total) throw new Error(`short download: ${bytes} of ${total} bytes`);
      return { bytes, lastModified: res.headers.get("last-modified") };
    } catch (err) {
      lastErr = err;
      log(`download attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function makePool(databaseUrl?: string): Pool {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not configured");
  return new Pool({
    connectionString: url,
    max: 2,
    ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 1_800_000, // index builds on 1.5M-row trigram columns can take minutes on Neon
  });
}

/** INSERT INTO <table>_new SELECT * FROM unnest($1::text[], $2::date[], ...) — one param per column. */
function unnestInsert(spec: TableSpec, target: string, rows: Row[]): { text: string; values: unknown[] } {
  const cols = spec.cols;
  const arrays: unknown[][] = cols.map(() => []);
  for (const r of rows) for (let c = 0; c < cols.length; c++) arrays[c].push(r[c] ?? null);
  const params = cols.map((c, i) => `$${i + 1}::${c.pg}[]`).join(", ");
  const names = cols.map((c) => c.name).join(", ");
  return {
    text: `INSERT INTO ${target} (${names}) SELECT ${names} FROM unnest(${params}) AS t(${names}) ON CONFLICT (${spec.pk.join(", ")}) DO NOTHING`,
    values: arrays,
  };
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const r = await pool.query(`SELECT to_regclass($1) AS r`, [`public.${table}`]);
  return r.rows[0]?.r != null;
}

// ---------------------------------------------------------------------------
// dataset loader
// ---------------------------------------------------------------------------

export interface LoadOptions {
  databaseUrl?: string;
  runner?: string;
  log?: (line: string) => void;
  /** parse + count only, no DB connection at all */
  dry?: boolean;
  /** stop after this many rows (partial / smoke loads) */
  maxRows?: number;
  /** use an already-downloaded zip instead of fetching */
  zipPath?: string;
  /** keep the downloaded zip */
  keepZip?: boolean;
  /** swap even when the new load is < 80% of the live row count */
  forceSwap?: boolean;
}

export interface LoadResult {
  dataset: Dataset;
  table: string;
  status: "ok" | "error" | "dry";
  rowsRead: number;
  rowsLoaded: number;
  rowsRejected: number;
  bytes: number;
  sourceLastModified: string | null;
  durationMs: number;
  phases: Record<string, number>; // ms per phase
  rejectSample: Array<{ line: number; reason: string; text: string }>;
  error?: string;
}

export async function loadDataset(dataset: Dataset, opts: LoadOptions = {}): Promise<LoadResult> {
  const log = opts.log ?? ((s) => console.log(`[irs-eo-extras] ${s}`));
  const spec = SPECS[dataset];
  const url = DATASET_URLS[dataset];
  const started = Date.now();
  const phases: Record<string, number> = {};
  const runner = opts.runner ?? (process.env.GITHUB_RUN_ID ? `github-actions:${process.env.GITHUB_RUN_ID}` : "local");
  const rejects: LoadResult["rejectSample"] = [];
  let rowsRead = 0, rowsLoaded = 0, rowsRejected = 0, bytes = 0;
  let sourceLastModified: string | null = null;

  const pool = opts.dry ? null : makePool(opts.databaseUrl);
  let loadId: number | null = null;
  let runId: number | null = null;
  const tmp = opts.zipPath ? null : mkdtempSync(join(tmpdir(), `irseox-${dataset}-`));
  const zipPath = opts.zipPath ?? join(tmp!, `${dataset}.zip`);
  const newTable = `${spec.table}_new`;

  const result = (status: LoadResult["status"], error?: string): LoadResult => ({
    dataset, table: spec.table, status, rowsRead, rowsLoaded, rowsRejected, bytes, sourceLastModified,
    durationMs: Date.now() - started, phases, rejectSample: rejects, ...(error ? { error } : {}),
  });

  try {
    if (pool) {
      if (!(await tableExists(pool, spec.table)))
        throw new Error(`${spec.table} does not exist — run scripts/migrate.ts (migrations/0011_irs_eo_extras.sql) first`);
      const l = await pool.query(
        `INSERT INTO irs_eo_extras_loads (dataset, url, status, runner) VALUES ($1,$2,'running',$3) RETURNING id`,
        [dataset, url, runner]
      );
      loadId = l.rows[0].id;
      const r = await pool.query(`INSERT INTO ingest_runs (source, status) VALUES ($1,'running') RETURNING id`, [`irs-eo-extras/${dataset}`]);
      runId = r.rows[0].id;
    }

    // 1. download
    let t = Date.now();
    if (opts.zipPath) {
      bytes = statSync(zipPath).size;
      log(`${dataset}: using local ${zipPath} (${(bytes / 1e6).toFixed(1)} MB)`);
    } else {
      const d = await downloadToFile(url, zipPath, log);
      bytes = d.bytes;
      sourceLastModified = d.lastModified;
      log(`${dataset}: ${(bytes / 1e6).toFixed(1)} MB downloaded, Last-Modified ${sourceLastModified ?? "?"}`);
    }
    phases.downloadMs = Date.now() - t;
    if (pool && loadId != null) {
      await pool.query(`UPDATE irs_eo_extras_loads SET bytes=$2, source_last_modified=$3 WHERE id=$1`, [loadId, bytes, sourceLastModified ? new Date(sourceLastModified) : null]);
    }

    // 2. stage table
    t = Date.now();
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${newTable}`);
      await pool.query(`CREATE TABLE ${newTable} (LIKE ${spec.table} INCLUDING DEFAULTS)`);
      await pool.query(`ALTER TABLE ${newTable} ADD CONSTRAINT ${newTable}_pkey PRIMARY KEY (${spec.pk.join(", ")})`);
    }

    // 3. stream + parse + insert
    const { entry, lines } = zipLines(zipPath);
    log(`${dataset}: entry ${entry.name} (${(entry.uncompressedSize / 1e6).toFixed(0)} MB inflated, method ${entry.method})`);
    const parse = PARSERS[dataset];
    let batch: Row[] = [];
    let lineNo = 0;
    const flush = async () => {
      if (!batch.length) return;
      if (pool) {
        const q = unnestInsert(spec, newTable, batch);
        const r = await pool.query(q.text, q.values);
        rowsLoaded += r.rowCount ?? batch.length;
      } else {
        rowsLoaded += batch.length;
      }
      batch = [];
    };
    for await (const raw of lines) {
      lineNo++;
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      rowsRead++;
      const p = parse(line);
      if ("reject" in p) {
        rowsRejected++;
        if (rejects.length < 25) rejects.push({ line: lineNo, reason: p.reject, text: line.slice(0, 200) });
        continue;
      }
      batch.push(p.row);
      if (batch.length >= BATCH_ROWS) {
        await flush();
        if (rowsLoaded % 200_000 === 0) log(`${dataset}: ${rowsLoaded.toLocaleString()} rows loaded`);
      }
      if (opts.maxRows && rowsRead >= opts.maxRows) break;
    }
    await flush();
    phases.loadMs = Date.now() - t;
    log(`${dataset}: ${rowsRead.toLocaleString()} lines read, ${rowsLoaded.toLocaleString()} loaded, ${rowsRejected} rejected (${(phases.loadMs / 1000).toFixed(0)}s)`);

    if (!pool) {
      if (tmp && !opts.keepZip) rmSync(tmp, { recursive: true, force: true });
      return result("dry");
    }

    if (rowsLoaded === 0) throw new Error(`${dataset}: zero rows parsed — refusing to swap in an empty table (layout change upstream?)`);
    const liveCount = Number((await pool.query(`SELECT count(*)::bigint AS n FROM ${spec.table}`)).rows[0].n);
    if (!opts.maxRows && !opts.forceSwap && liveCount > 0 && rowsLoaded < liveCount * 0.8)
      throw new Error(`${dataset}: new load has ${rowsLoaded} rows vs ${liveCount} live (< 80%) — refusing to swap; re-run with --force-swap after checking the IRS file`);

    // 4. indexes on the staging table
    t = Date.now();
    for (const ix of spec.indexes) {
      await pool.query(`CREATE INDEX ${ix.name}_new ON ${newTable} ${ix.def}`);
    }
    await pool.query(`ANALYZE ${newTable}`);
    phases.indexMs = Date.now() - t;
    log(`${dataset}: ${spec.indexes.length} indexes built (${(phases.indexMs / 1000).toFixed(0)}s)`);

    // 5. swap
    t = Date.now();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DROP TABLE ${spec.table}`);
      await client.query(`ALTER TABLE ${newTable} RENAME TO ${spec.table}`);
      await client.query(`ALTER TABLE ${spec.table} RENAME CONSTRAINT ${newTable}_pkey TO ${spec.table}_pkey`);
      for (const ix of spec.indexes) await client.query(`ALTER INDEX ${ix.name}_new RENAME TO ${ix.name}`);
      await client.query(
        `UPDATE irs_eo_extras_loads SET status='ok', finished_at=NOW(), rows_read=$2, rows_loaded=$3, rows_rejected=$4, error_sample=$5 WHERE id=$1`,
        [loadId, rowsRead, rowsLoaded, rowsRejected, rejects.length ? JSON.stringify(rejects) : null]
      );
      await client.query(
        `UPDATE ingest_runs SET status='ok', finished_at=NOW(), firms_processed=$2, firms_inserted=$3, firms_updated=0 WHERE id=$1`,
        [runId, rowsRead, rowsLoaded]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    phases.swapMs = Date.now() - t;
    log(`${dataset}: swapped in — ${rowsLoaded.toLocaleString()} rows live in ${spec.table} (${((Date.now() - started) / 1000).toFixed(0)}s total)`);
    return result("ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${newTable}`).catch(() => undefined);
      if (loadId != null)
        await pool.query(
          `UPDATE irs_eo_extras_loads SET status='error', finished_at=NOW(), rows_read=$2, rows_loaded=$3, rows_rejected=$4, error_sample=$5, error_message=$6 WHERE id=$1`,
          [loadId, rowsRead, rowsLoaded, rowsRejected, rejects.length ? JSON.stringify(rejects) : null, message.slice(0, 2000)]
        ).catch(() => undefined);
      if (runId != null)
        await pool.query(`UPDATE ingest_runs SET status='error', finished_at=NOW(), error_message=$2, firms_processed=$3 WHERE id=$1`, [runId, message.slice(0, 2000), rowsRead]).catch(() => undefined);
    }
    log(`${dataset}: FAILED — ${message}`);
    return result("error", message);
  } finally {
    if (tmp && !opts.keepZip) rmSync(tmp, { recursive: true, force: true });
    if (pool) await pool.end();
  }
}

export async function loadDatasets(datasets: Dataset[], opts: LoadOptions & { zipDir?: string } = {}): Promise<LoadResult[]> {
  const out: LoadResult[] = [];
  for (const d of datasets) {
    const zipPath = opts.zipPath ?? (opts.zipDir ? join(opts.zipDir, `${d}.zip`) : undefined);
    out.push(await loadDataset(d, { ...opts, zipPath }));
  }
  return out;
}
