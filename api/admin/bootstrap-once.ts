import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runMigrations, v04TablesExist } from "../../lib/migrate";
import { ingestNacuboBenchmarks } from "../../lib/nacubo/ingest";
import {
  ingestDirectory,
  ingestFinance,
  pickNextFinance,
  isDirectoryNeeded,
  DEFAULT_DIRECTORY_YEAR,
} from "../../lib/ipeds/ingest";

/**
 * One-shot bootstrap + backfill driver, accessible via Vercel-SSO-authenticated GET.
 *
 * Stages (all idempotent):
 *   1. Apply migration 0003 (if v0.4.0 tables don't yet exist)
 *   2. Seed NACUBO public-aggregate benchmarks (6 rows, FY2020-FY2025)
 *   3. Ingest the IPEDS HD2023 institution directory (~6,400 rows)
 *   4. Walk the IPEDS finance backfill (21 years x F2 + F1A) until either
 *      all files are ingested or the function's time budget is exhausted.
 *      Caller should re-invoke until the response reports allDone=true.
 *
 * Necessary because the OLD production deployment (which is what serves the
 * */15-min cron under Rolling Releases) has a BOM-handling bug in its
 * header parser and would silently mark every finance file as "ok" with
 * zero rows inserted. Hitting this endpoint on the new (BOM-fixed) canary
 * deployment via web_fetch_vercel_url bypasses that.
 *
 * Auth: relies on Vercel SSO (this is a preview/canary deployment URL).
 */

const FINANCE_TIME_BUDGET_MS = 250_000; // function maxDuration is 300s; leave headroom

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  const stages: any[] = [];

  try {
    // ----- Stage 1: migration -----
    if (!(await v04TablesExist())) {
      const mig = await runMigrations();
      if (!mig.ok) {
        res.status(500).json({
          ok: false,
          totalDurationMs: Date.now() - start,
          failedStage: "migration",
          stages,
          migration: mig,
        });
        return;
      }
      stages.push({ stage: "migration", ok: true, dir: mig.dir, applied: mig.applied });
    } else {
      stages.push({ stage: "migration", ok: true, skipped: "tables already exist" });
    }

    // ----- Stage 2: NACUBO seed -----
    const nacubo = await ingestNacuboBenchmarks();
    stages.push({
      stage: "nacubo",
      ok: true,
      rowsUpserted: nacubo.rowsUpserted,
      durationMs: nacubo.durationMs,
    });

    // ----- Stage 3: IPEDS directory ingest -----
    if (await isDirectoryNeeded()) {
      const directory = await ingestDirectory(DEFAULT_DIRECTORY_YEAR);
      stages.push({ stage: "ipeds-directory", ok: true, ...directory });
    } else {
      stages.push({ stage: "ipeds-directory", ok: true, skipped: "already ingested with rows" });
    }

    // ----- Stage 4: IPEDS finance backfill loop -----
    const financeResults: any[] = [];
    const attempted = new Set<string>();
    let allDone = false;
    while (Date.now() - start < FINANCE_TIME_BUDGET_MS) {
      const next = await pickNextFinance();
      const key = `${next.fyear}/${next.fileType}`;
      if (attempted.has(key)) {
        // pickNextFinance keeps returning the same tuple -> we've caught up.
        allDone = true;
        break;
      }
      attempted.add(key);
      try {
        const result = await ingestFinance(next.fyear, next.fileType);
        financeResults.push({
          key,
          ok: true,
          source: result.source,
          rowsProcessed: result.rowsProcessed,
          rowsUpserted: result.rowsUpserted,
          rowsSkippedNoKey: result.rowsSkippedNoKey,
          durationMs: result.durationMs,
        });
      } catch (err) {
        financeResults.push({
          key,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue — missing/404 files are expected for some (year, file) tuples
        // (e.g. provisional FY24 F1A not yet published).
      }
    }
    stages.push({
      stage: "finance-backfill",
      filesAttempted: financeResults.length,
      filesSucceeded: financeResults.filter((r) => r.ok).length,
      filesFailed: financeResults.filter((r) => !r.ok).length,
      totalRowsUpserted: financeResults
        .filter((r) => r.ok)
        .reduce((sum, r) => sum + (r.rowsUpserted ?? 0), 0),
      allDone,
      results: financeResults,
    });

    res.status(200).json({
      ok: true,
      totalDurationMs: Date.now() - start,
      allDone,
      stages,
      nextSteps: allDone
        ? "Backfill complete. The annual cron will keep FY24/FY25 fresh going forward."
        : "Re-invoke this endpoint to continue the backfill from where it left off (it's idempotent).",
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      totalDurationMs: Date.now() - start,
      stages,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}
