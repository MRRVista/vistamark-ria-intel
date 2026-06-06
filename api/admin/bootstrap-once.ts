import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runMigrations, v04TablesExist } from "../../lib/migrate";
import { ingestNacuboBenchmarks } from "../../lib/nacubo/ingest";
import {
  ingestDirectory,
  DEFAULT_DIRECTORY_YEAR,
} from "../../lib/ipeds/ingest";

/**
 * One-shot bootstrap endpoint accessible via Vercel-SSO-authenticated GET.
 *
 * Runs in three stages, all idempotent:
 *   1. Apply migration 0003 (if v0.4.0 tables don't yet exist)
 *   2. Seed NACUBO public-aggregate benchmarks (6 rows, FY2020-FY2025)
 *   3. Ingest the IPEDS HD2023 institution directory (~6,400 rows)
 *
 * After this completes, the production cron (every 15 minutes) will pick
 * up the IPEDS finance backfill automatically; no further admin action
 * needed.
 *
 * Auth: relies on Vercel SSO (this is a preview/canary deployment URL).
 * Accepts GET so it can be invoked from a browser or Vercel MCP fetch.
 */
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
    const directory = await ingestDirectory(DEFAULT_DIRECTORY_YEAR);
    stages.push({ stage: "ipeds-directory", ok: true, ...directory });

    res.status(200).json({
      ok: true,
      totalDurationMs: Date.now() - start,
      stages,
      nextSteps:
        "The 15-min /api/cron/refresh-ipeds will now walk the finance backfill on the OLD production deployment automatically (the schema is shared in Neon, so v0.4.0 cron code suffices once tables exist).",
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
