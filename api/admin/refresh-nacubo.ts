import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ingestNacuboBenchmarks } from "../../lib/nacubo/ingest";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual NACUBO benchmark refresh. Seeds nacubo_benchmarks table with the
 * hardcoded public-aggregate data in lib/nacubo/data.ts. Idempotent —
 * re-running just re-upserts the same data with refreshed timestamps.
 *
 * Usage:
 *   POST /api/admin/refresh-nacubo   (Bearer CRON_SECRET)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-nacubo",
      description:
        "Seed/refresh nacubo_benchmarks from public NCSE/NTSE/NES aggregate data.",
      note: "Granular institution-specific NACUBO data is paywalled ($500/yr) and not ingested here.",
    });
    return;
  }

  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized — Bearer CRON_SECRET required" });
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
