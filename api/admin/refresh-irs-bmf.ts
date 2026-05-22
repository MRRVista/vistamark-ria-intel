import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ingestRegion, pickNextRegion } from "../../lib/irs-bmf/ingest";
import { BMF_REGIONS, REGION_DESCRIPTIONS } from "../../lib/irs-bmf/columns";
import type { BmfRegion } from "../../lib/irs-bmf/columns";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual BMF ingest trigger. Authenticated with Bearer CRON_SECRET.
 *
 * Usage:
 *   POST /api/admin/refresh-irs-bmf              → next region in rotation
 *   POST /api/admin/refresh-irs-bmf?region=eo1   → specific region
 *   GET  /api/admin/refresh-irs-bmf              → show status / valid regions
 *
 * Note: single region ingest typically runs 60–120s. Vercel maxDuration is
 * 300s; if a region times out, hit it again and the upsert will pick up
 * progress (records already inserted stay; remaining rows are added).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-irs-bmf",
      description:
        "Manual trigger for IRS EO Business Master File ingestion. " +
        "POST with Bearer CRON_SECRET to run. Optional ?region= param.",
      validRegions: BMF_REGIONS.map((r) => ({ code: r, covers: REGION_DESCRIPTIONS[r] })),
    });
    return;
  }

  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized — Bearer CRON_SECRET required" });
    return;
  }

  const requested = (req.query.region as string | undefined)?.toLowerCase();
  let region: BmfRegion;
  if (requested) {
    if (!(BMF_REGIONS as readonly string[]).includes(requested)) {
      res.status(400).json({
        error: `Invalid region: ${requested}`,
        validRegions: BMF_REGIONS,
      });
      return;
    }
    region = requested as BmfRegion;
  } else {
    region = await pickNextRegion();
  }

  try {
    const result = await ingestRegion(region);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      region,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
