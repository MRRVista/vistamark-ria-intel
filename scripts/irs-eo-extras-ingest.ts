/**
 * IRS EO extras loader — Pub 78 / Auto-Revocation / 990-N e-Postcard (GitHub Actions entry point).
 *
 *   npx tsx scripts/irs-eo-extras-ingest.ts                                  # full refresh of all three
 *   npx tsx scripts/irs-eo-extras-ingest.ts --datasets pub78,revocation      # subset
 *   npx tsx scripts/irs-eo-extras-ingest.ts --datasets 990n --dry            # download + parse + count, no DB
 *   npx tsx scripts/irs-eo-extras-ingest.ts --datasets 990n --max-rows 50000 # partial load (keeps the swap)
 *   npx tsx scripts/irs-eo-extras-ingest.ts --zip-dir /path/with/{pub78,revocation,990n}.zip   # skip download
 *   npx tsx scripts/irs-eo-extras-ingest.ts --force-swap                     # bypass the <80%-of-live guard
 *
 * Each dataset is a full refresh: rows load into <table>_new, indexes are
 * built there, then the live table is swapped in one transaction. Needs
 * DATABASE_URL (Neon direct/pooled or any Postgres; `pg` driver). GitHub
 * Actions passes it from IRS990_DATABASE_URL (falls back to DATABASE_URL).
 */

import { Pool } from "pg";
import { DATASETS, DATASET_TABLES, loadDatasets } from "../lib/irs-eo-extras/ingest";
import type { Dataset } from "../lib/irs-eo-extras/ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const datasets = (arg("datasets") ?? DATASETS.join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^990-?n$/, "990n").replace(/^revocations?$/, "revocation").replace(/^pub-?78$/, "pub78"))
    .filter(Boolean) as Dataset[];
  const bad = datasets.filter((d) => !DATASETS.includes(d));
  if (bad.length) {
    console.error(`unknown dataset(s): ${bad.join(", ")} — choose from ${DATASETS.join(", ")}`);
    process.exit(2);
  }
  const dry = has("dry") || has("dry-run");
  const maxRows = arg("max-rows") ? Number(arg("max-rows")) : undefined;
  if (!dry && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (use --dry to parse without a database)");
    process.exit(1);
  }

  const results = await loadDatasets(datasets, {
    dry,
    maxRows,
    zipDir: arg("zip-dir"),
    keepZip: has("keep-zip"),
    forceSwap: has("force-swap"),
  });
  const failed = results.filter((r) => r.status === "error");
  console.log(JSON.stringify({ loaded: results.length, failed: failed.length, results: results.map((r) => ({ ...r, rejectSample: r.rejectSample.slice(0, 5) })) }, null, 2));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("fs");
    const lines = [
      `## IRS EO extras ingest — ${results.length} dataset(s), ${failed.length} failed${dry ? " (dry run)" : ""}`,
      "",
      "| dataset | table | status | rows read | loaded | rejected | zip MB | download s | load s | index s |",
      "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
      ...results.map((r) => `| ${r.dataset} | ${r.table} | ${r.status} | ${r.rowsRead} | ${r.rowsLoaded} | ${r.rowsRejected} | ${(r.bytes / 1e6).toFixed(0)} | ${((r.phases.downloadMs ?? 0) / 1000).toFixed(0)} | ${((r.phases.loadMs ?? 0) / 1000).toFixed(0)} | ${((r.phases.indexMs ?? 0) / 1000).toFixed(0)} |`),
      ...failed.map((r) => `\n**${r.dataset} failed:** ${r.error}`),
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }

  if (!dry && process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    const pool = new Pool({ connectionString: url, ssl: /neon\.tech|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
    try {
      const parts = DATASETS.map((d) => `(SELECT count(*)::int FROM ${DATASET_TABLES[d]}) AS "${d}"`);
      const c = await pool.query(`SELECT ${parts.join(", ")}`);
      console.log(`totals: ${JSON.stringify(c.rows[0])}`);
    } catch (err) {
      console.log(`totals unavailable: ${err instanceof Error ? err.message : String(err)}`);
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
