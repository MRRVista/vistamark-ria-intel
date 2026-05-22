import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { ingestRegion, pickNextRegion } from "../../lib/irs-bmf/ingest";

/**
 * Weekly cron: refresh IRS EO Business Master File.
 *
 * Each tick picks one region (oldest-run-wins rotation) and ingests it.
 * Six regions total → at weekly cadence, every region is refreshed about
 * every 6 weeks. The IRS itself republishes the BMF monthly; this is good
 * enough for prospecting and registration changes.
 *
 * For faster initial backfill, hit /api/admin/refresh-irs-bmf?region=eo1
 * manually with a Bearer CRON_SECRET token.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  try {
    const region = await pickNextRegion();
    const result = await ingestRegion(region);
    res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
