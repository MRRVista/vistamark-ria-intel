import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runMigrations } from "../../lib/migrate";
import { ingestNacuboBenchmarks } from "../../lib/nacubo/ingest";
import {
  ingestDirectory,
  ingestFinance,
  pickNextFinance,
  isDirectoryNeeded,
  DEFAULT_DIRECTORY_YEAR,
} from "../../lib/ipeds/ingest";

/**
 * One-shot bootstrap + backfill driver. See commit history for context.
 * Idempotent across invocations. Caller re-invokes until allDone === true.
 */

const FINANCE_TIME_BUDGET_MS = 250_000;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  const stages: any[] = [];

  try {
    // Stage 1: migration. Always run — runMigrations() is idempotent
    // (already-exists/duplicate statements are skipped, and the v0.5.0
    // column rename is guarded by a DO $$ ... IF EXISTS $$ block). The old
    // `if (!v04TablesExist())` guard meant new migrations (e.g. 0004) were
    // never applied once the v0.4.x base tables existed.
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

    // Stage 2: NACUBO seed
    const nacubo = await ingestNacuboBenchmarks();
    stages.push({
      stage: "nacubo",
      ok: true,
      rowsUpserted: nacubo.rowsUpserted,
      durationMs: nacubo.durationMs,
    });

    // Stage 3: IPEDS directory ingest
    if (await isDirectoryNeeded()) {
      const directory = await ingestDirectory(DEFAULT_DIRECTORY_YEAR);
      stages.push({ stage: "ipeds-directory", ok: true, ...directory });
    } else {
      stages.push({ stage: "ipeds-directory", ok: true, skipped: "already ingested with rows" });
    }

    // Stage 4: IPEDS finance backfill loop
    const financeResults: any[] = [];
    const attemptedThisRun = new Set<string>();
    let allDone = false;
    while (Date.now() - start < FINANCE_TIME_BUDGET_MS) {
      const next = await pickNextFinance(attemptedThisRun);
      if (!next) {
        allDone = true;
        break;
      }
      const sourceKey = `ipeds/${next.fileType.toLowerCase()}/${next.fyear}`;
      attemptedThisRun.add(sourceKey);
      try {
        const result = await ingestFinance(next.fyear, next.fileType);
        financeResults.push({
          source: result.source,
          ok: true,
          rowsProcessed: result.rowsProcessed,
          rowsUpserted: result.rowsUpserted,
          rowsSkippedNoKey: result.rowsSkippedNoKey,
          durationMs: result.durationMs,
        });
      } catch (err) {
        financeResults.push({
          source: sourceKey,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
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
        : "Re-invoke this endpoint to continue the backfill from where it left off (idempotent).",
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
