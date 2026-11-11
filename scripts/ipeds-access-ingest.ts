/**
 * IPEDS finance loader for fiscal year 2023-24 onward (Access database path).
 *
 * The Vercel cron reads per-survey "complete data file" zips
 * (https://nces.ed.gov/ipeds/datacenter/data/F2223_F2.zip). As of 2026-11 no
 * such zip exists for FY2023-24 (F2324_F2.zip returns 404 under every naming
 * variant), although the data has been released: it is inside the
 * collection-year Access database.
 *
 * FINANCE LAGS THE COLLECTION BY ONE YEAR. Collection 2023-24 carries the
 * FY2022-23 finance tables (F2223_*); FY2023-24 finance (F2324_*) is in
 * collection 2024-25. Verified 2026-11-10 by opening IPEDS_2023-24_Final.zip:
 * its finance tables are F2223_F1A / F2223_F2 / F2223_F3. So for fyear Y
 * (the calendar year the fiscal year ends) this reads
 *
 *   https://nces.ed.gov/ipeds/tablefiles/zipfiles/IPEDS_<Y>-<Y+1>_Final.zip
 *   (or ..._Provisional.zip), tables F<Y-1><Y>_F2 and F<Y-1><Y>_F1A
 *
 * e.g. fyear 2024 -> IPEDS_2024-25_Provisional.zip -> F2324_F2, F2324_F1A.
 * The rows go through the same mapping + upsert the zip path uses
 * (lib/ipeds/ingest.ts ingestFinanceTable).
 *
 *   npx tsx scripts/ipeds-access-ingest.ts                 # every fiscal year from 2024 not yet loaded
 *   npx tsx scripts/ipeds-access-ingest.ts --year 2024     # FY2023-24
 *   npx tsx scripts/ipeds-access-ingest.ts --year 2024 --dry        # download + parse + count, no database
 *   npx tsx scripts/ipeds-access-ingest.ts --year 2024 --force      # reload (e.g. when Final replaces Provisional)
 *   npx tsx scripts/ipeds-access-ingest.ts --release Provisional    # skip the Final probe
 *
 * mdb-reader is not a dependency of the deployed app (it is only needed
 * here); the workflow installs it with `npm install --no-save mdb-reader`.
 * Runs in GitHub Actions (.github/workflows/ipeds-access-ingest.yml): the
 * database is about 1 GB unzipped, far past a Vercel function.
 */
import AdmZip from "adm-zip";
import { sql } from "drizzle-orm";
import { buildHeaderIndex, type IpedsFinanceFile } from "../lib/ipeds/columns";
import { financeRowToRecord } from "../lib/ipeds/parser";

const FIRST_ACCESS_YEAR = 2024;
const BASE = process.env.IPEDS_ACCESS_BASE_URL ?? "https://nces.ed.gov/ipeds/tablefiles/zipfiles";
const UA = process.env.VISTAMARK_USER_AGENT ?? "vistamark-ria-intel ipeds-access-ingest (mrice@vistamark.com)";
const FILES: IpedsFinanceFile[] = ["F2", "F1A"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const log = (m: string) => console.log(`[ipeds-access] ${m}`);

/**
 * fyear 2024 -> collection "2024-25" (the database to download) and table
 * prefix "2324" (the fiscal year inside it). Finance lags collection by a year.
 */
function yearParts(fyear: number) {
  const yy = (n: number) => String(n).slice(2);
  return { collection: `${fyear}-${yy(fyear + 1)}`, code: `${yy(fyear - 1)}${yy(fyear)}`, fiscal: `FY${fyear - 1}-${yy(fyear)}` };
}

async function download(fyear: number, only?: string): Promise<{ url: string; release: string; zip: Buffer } | null> {
  const { collection } = yearParts(fyear);
  for (const release of only ? [only] : ["Final", "Provisional"]) {
    const url = `${BASE}/IPEDS_${collection}_${release}.zip`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.status === 404) { log(`${url} -> 404`); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const zip = Buffer.from(await res.arrayBuffer());
    log(`${url} -> ${(zip.length / 1e6).toFixed(1)} MB`);
    return { url, release, zip };
  }
  return null;
}

/** mdb-reader hands back native values; the shared mapper wants CSV-style strings. */
function cell(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

async function alreadyLoaded(fyear: number, fileType: IpedsFinanceFile): Promise<boolean> {
  const { db } = await import("../lib/db");
  const r: any = await db.execute(sql`
    SELECT 1 FROM ingest_runs
    WHERE source = ${`ipeds/${fileType.toLowerCase()}/${fyear}`} AND status = 'ok' AND firms_inserted > 0 LIMIT 1`);
  return ((r?.rows ?? r ?? []) as unknown[]).length > 0;
}

async function loadYear(fyear: number, opts: { dry: boolean; force: boolean; release?: string }): Promise<boolean> {
  const { code, collection: coll, fiscal } = yearParts(fyear);
  const collection = `${fiscal} (collection ${coll})`;
  let todo = FILES;
  if (!opts.dry && !opts.force) {
    const pending: IpedsFinanceFile[] = [];
    for (const f of FILES) if (!(await alreadyLoaded(fyear, f))) pending.push(f);
    todo = pending;
    if (!todo.length) { log(`${collection}: F2 and F1A already loaded (use --force to reload)`); return true; }
  }

  const got = await download(fyear, opts.release);
  if (!got) { log(`${collection}: no Access database published yet`); return false; }

  const entry = new AdmZip(got.zip).getEntries().find((e) => /\.(accdb|mdb)$/i.test(e.entryName));
  if (!entry) throw new Error(`${got.url}: no .accdb inside the zip`);
  const dbBuf = entry.getData();
  log(`${entry.entryName}: ${(dbBuf.length / 1e6).toFixed(1)} MB (${got.release})`);

  const spec = "mdb-reader"; // not a package.json dependency; see the header
  const mod: any = await import(spec);
  const MDBReader = mod.default?.default ?? mod.default ?? mod;
  const reader = new MDBReader(dbBuf);
  const names: string[] = reader.getTableNames();

  let ok = true;
  for (const fileType of todo) {
    const want = `F${code}_${fileType}`.toUpperCase();
    const tableName = names.find((n) => n.toUpperCase() === want);
    if (!tableName) {
      ok = false;
      log(`${collection}: table ${want} not found. Finance-like tables present: ${names.filter((n) => /^F\d{4}/i.test(n)).join(", ") || "(none)"}`);
      continue;
    }
    const table = reader.getTable(tableName);
    const header: string[] = table.getColumnNames();
    const data: Array<Record<string, unknown>> = table.getData();
    const rows = data.map((r) => header.map((h) => cell(r[h])));

    if (opts.dry) {
      const idx = buildHeaderIndex(header);
      let mapped = 0, withEoy = 0;
      let sample: unknown = null;
      for (const row of rows) {
        const rec = financeRowToRecord(row, idx, fyear, fileType);
        if (!rec) continue;
        mapped++;
        if (rec.marketValueEoy != null && Number(rec.marketValueEoy) > 0) { withEoy++; sample = sample ?? rec; }
      }
      log(`DRY ${tableName}: ${rows.length} rows, ${header.length} columns, ${mapped} mapped, ${withEoy} with an end-of-year endowment value`);
      log(`DRY ${tableName} first columns: ${header.slice(0, 8).join(", ")}`);
      log(`DRY ${tableName} sample: ${JSON.stringify(sample)}`);
      if (!withEoy) ok = false;
      continue;
    }

    const { ingestFinanceTable } = await import("../lib/ipeds/ingest");
    const res = await ingestFinanceTable(fyear, fileType, `${got.url}#${tableName}`, header, rows);
    log(`${tableName}: ${res.rowsProcessed} rows read, ${res.rowsUpserted} upserted, ${res.rowsSkippedNoKey} without UNITID (${res.durationMs} ms)`);
    if (!res.rowsUpserted) ok = false;
  }
  return ok;
}

async function main() {
  const dry = flag("dry");
  const force = flag("force");
  const release = arg("release");
  if (!dry && !process.env.DATABASE_URL) { console.error("DATABASE_URL is not set (use --dry to parse without a database)"); process.exit(1); }
  const one = arg("year") ? Number(arg("year")) : null;
  if (one != null && (!Number.isInteger(one) || one < FIRST_ACCESS_YEAR)) {
    console.error(`--year must be ${FIRST_ACCESS_YEAR} or later (earlier years load from the per-survey zips via the Vercel cron)`);
    process.exit(1);
  }
  // FY ending in Y is in collection Y-(Y+1), first released during Y+2 at the
  // earliest, so the newest year worth probing is last calendar year.
  const last = new Date().getUTCFullYear() - 1;
  const years = one != null ? [one] : Array.from({ length: last - FIRST_ACCESS_YEAR + 1 }, (_, i) => FIRST_ACCESS_YEAR + i);

  let failed = false;
  for (const y of years) {
    const ok = await loadYear(y, { dry, force, release });
    // An explicitly requested year that is missing is a failure; a not-yet-published
    // newest year on the scheduled sweep is not.
    if (!ok && (one != null || y < last)) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
