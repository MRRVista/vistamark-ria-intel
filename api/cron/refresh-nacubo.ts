import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { ingestNacuboBenchmarks } from "../../lib/nacubo/ingest";

/**
 * Annual cron: re-seed NACUBO benchmarks. The actual update of the seed
 * data in lib/nacubo/data.ts happens by code commit each February when
 * NACUBO releases the new NCSE study — this cron just ensures the DB stays
 * in sync if anything has shifted.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  try {
    const result = await ingestNacuboBenchmarks();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
