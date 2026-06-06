import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import {
  ingestDirectory,
  ingestFinance,
  pickNextFinance,
  isDirectoryNeeded,
  DEFAULT_DIRECTORY_YEAR,
} from "../../lib/ipeds/ingest";
import { runMigrations, v04TablesExist } from "../../lib/migrate";
import { ingestNacuboBenchmarks } from "../../lib/nacubo/ingest";

/**
 * Cron: walk through the IPEDS backfill, one (year, file) per tick.
 *
 * Auto-bootstrap: if the v0.4.0 tables don't exist yet (ipeds_institutions,
 * endowments, nacubo_benchmarks), run migrations first AND seed NACUBO
 * benchmarks before proceeding. This is the self-heal path so the v0.4.0
 * deploy doesn't require a manual /api/admin/migrate hit after every push.
 *
 * Schedule (vercel.json): every 15 minutes. Once fully backfilled, the cron
 * self-throttles by re-ingesting the most recent provisional year only.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  try {
    if (!(await v04TablesExist())) {
      console.log("[refresh-ipeds] Bootstrap: v0.4.0 tables missing; running migrations");
      const mig = await runMigrations();
      if (!mig.ok) {
        console.error("[refresh-ipeds] Bootstrap failed:", mig.error);
        res.status(500).json({ stage: "bootstrap", ...mig });
        return;
      }
      console.log(
        `[refresh-ipeds] Bootstrap: applied migrations from ${mig.dir}; seeding NACUBO`
      );
      const nacubo = await ingestNacuboBenchmarks();
      console.log(
        `[refresh-ipeds] Bootstrap: seeded ${nacubo.rowsUpserted} NACUBO rows in ${nacubo.durationMs}ms`
      );
      // Fall through to directory ingest on this same tick.
    }

    if (await isDirectoryNeeded()) {
      const result = await ingestDirectory(DEFAULT_DIRECTORY_YEAR);
      res.status(200).json({ ok: true, stage: "directory", ...result });
      return;
    }
    const next = await pickNextFinance();
    if (!next) {
      res.status(200).json({
        ok: true,
        stage: "finance",
        skipped: "backfill complete; nothing to ingest this tick",
      });
      return;
    }
    const result = await ingestFinance(next.fyear, next.fileType);
    res.status(200).json({ ok: true, stage: "finance", ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
