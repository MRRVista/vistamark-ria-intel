import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { ingestNacuboBenchmarks } from "../../lib/nacubo/ingest";
import { runMigrations, v04TablesExist } from "../../lib/migrate";

/**
 * Annual cron: re-seed NACUBO benchmarks. Auto-bootstraps the v0.4.0 schema
 * if not present (safety net in case this is the first endpoint hit after
 * a fresh deploy).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  try {
    if (!(await v04TablesExist())) {
      console.log("[refresh-nacubo] Bootstrap: v0.4.0 tables missing; running migrations");
      const mig = await runMigrations();
      if (!mig.ok) {
        console.error("[refresh-nacubo] Bootstrap failed:", mig.error);
        res.status(500).json({ stage: "bootstrap", ...mig });
        return;
      }
    }
    const result = await ingestNacuboBenchmarks();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
