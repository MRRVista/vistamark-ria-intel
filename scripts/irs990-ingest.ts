/**
 * IRS Form 990 e-file loader — CLI entry point (runs in GitHub Actions).
 *
 *   npx tsx scripts/irs990-ingest.ts                         # load every un-loaded batch, 2024→current
 *   npx tsx scripts/irs990-ingest.ts --years 2025,2026       # restrict index years
 *   npx tsx scripts/irs990-ingest.ts --batch 2025_TEOS_XML_10A   # one batch (re-load if already ok)
 *   npx tsx scripts/irs990-ingest.ts --list                  # show index batches vs ledger, load nothing
 *   npx tsx scripts/irs990-ingest.ts --batch ... --max-entries 500 --dry-run   # parse only, no DB writes
 *   npx tsx scripts/irs990-ingest.ts --parse-file path/to/return.xml           # print one parsed return
 *   npx tsx scripts/irs990-ingest.ts --refresh-latest                       # recompute is_latest for the whole table (migration 0012 backfill)
 *
 * Needs DATABASE_URL (a Neon *direct* or pooled Postgres URL works; `pg` driver).
 * GitHub Actions passes it from the IRS990_DATABASE_URL repository secret.
 */

import { readFileSync } from "fs";
import { Pool } from "pg";
import {
  DEFAULT_INDEX_YEARS,
  batchUrl,
  findNewBatches,
  listIndexBatches,
  loadBatch,
  loadNewBatches,
  refreshLatestAll,
} from "../lib/irs990/ingest";
import type { IndexBatch } from "../lib/irs990/ingest";
import { parseReturnXml } from "../lib/irs990/parse";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const parseFile = arg("parse-file");
  if (parseFile) {
    const r = parseReturnXml(readFileSync(parseFile, "utf8"));
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (has("refresh-latest")) {
    const started = Date.now();
    const r = await refreshLatestAll();
    console.log(JSON.stringify({ ...r, seconds: Math.round((Date.now() - started) / 1000) }));
    return;
  }

  const years = (arg("years") ?? DEFAULT_INDEX_YEARS.join(","))
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 2011);
  const maxEntries = arg("max-entries") ? Number(arg("max-entries")) : undefined;
  const maxBatches = arg("max-batches") ? Number(arg("max-batches")) : undefined;

  if (has("list")) {
    const todo = await findNewBatches(years);
    for (const y of years) {
      const all = await listIndexBatches(y);
      for (const b of all) {
        const pending = todo.some((t) => t.batchId === b.batchId);
        console.log(`${pending ? "TODO" : "ok  "} ${b.batchId}  ${b.indexedFilings} filings  ${JSON.stringify(b.byType)}`);
      }
    }
    return;
  }

  const batchId = arg("batch");
  if (batchId) {
    const year = Number(batchId.slice(0, 4));
    const all = await listIndexBatches(year);
    const fromIndex = all.find((b) => b.batchId === batchId);
    const batch: IndexBatch = fromIndex ?? { batchId, indexYear: year, url: batchUrl(year, batchId), indexedFilings: 0, byType: {} };
    if (has("dry-run")) {
      // Parse-only pass against a throwaway in-memory ledger is not possible
      // without a DB; dry-run instead loads into DATABASE_URL but caps entries.
      console.log(`dry run: loading at most ${maxEntries ?? 200} entries of ${batchId} into DATABASE_URL`);
      const r = await loadBatch(batch, { maxEntries: maxEntries ?? 200, keepZip: has("keep-zip") });
      console.log(JSON.stringify(r, null, 2));
      process.exitCode = r.status === "ok" ? 0 : 1;
      return;
    }
    const r = await loadBatch(batch, { maxEntries, keepZip: has("keep-zip") });
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.status === "ok" ? 0 : 1;
    return;
  }

  const results = await loadNewBatches(years, { maxBatches, maxEntries });
  const failed = results.filter((r) => r.status !== "ok");
  console.log(JSON.stringify({ loaded: results.length, failed: failed.length, results }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("fs");
    const lines = [
      `## IRS 990 ingest — ${results.length} batch(es), ${failed.length} failed`,
      "",
      "| batch | status | filings | people | skipped (990-T) | parse errors | minutes |",
      "|---|---|---:|---:|---:|---:|---:|",
      ...results.map((r) => `| ${r.batchId} | ${r.status} | ${r.filingsLoaded} | ${r.personsLoaded} | ${r.filingsSkipped} | ${r.parseErrors} | ${(r.durationMs / 60000).toFixed(1)} |`),
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
  // Summary row counts for the log.
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const c = await pool.query(`SELECT (SELECT count(*) FROM irs990_filings) AS filings, (SELECT count(*) FROM irs990_persons) AS persons, (SELECT count(*) FROM irs990_batches WHERE status='ok') AS batches_ok`);
      console.log(`totals: ${JSON.stringify(c.rows[0])}`);
    } finally {
      await pool.end();
    }
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
