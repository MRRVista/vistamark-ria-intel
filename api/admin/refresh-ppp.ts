import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ingestPpp } from "../../lib/sba-ppp/ingest";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual SBA PPP ingest trigger. Bearer CRON_SECRET required.
 *
 * The SBA does not provide a single stable "latest" URL; Matt supplies the
 * current FOIA CSV URL from https://data.sba.gov/dataset/ppp-foia. We point
 * the ingester at one file per call (the >=$150k national file, or a smaller
 * per-state <$150k file). For the giant national file, pass maxRows to stay
 * within the function time budget.
 *
 * Usage:
 *   POST /api/admin/refresh-ppp?url=https://.../public_150k_plus_XXXXXX.csv
 *   POST /api/admin/refresh-ppp?url=...&maxRows=200000
 *   GET  /api/admin/refresh-ppp   -> usage
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-ppp",
      description: "SBA PPP FOIA loan-level ingest. Source: data.sba.gov/dataset/ppp-foia.",
      usage:
        "POST with Bearer CRON_SECRET and ?url=<SBA CSV url>. Optional ?maxRows=N to cap " +
        "rows ingested this call (use for the large >=$150k national file).",
      note: "PPP program is closed; data is historical. No cron — invoke manually.",
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized -- Bearer CRON_SECRET required" });
    return;
  }

  const url = req.query.url as string | undefined;
  if (!url || !/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: "Missing or invalid ?url= (must be http(s) CSV URL)" });
    return;
  }
  const maxRowsStr = req.query.maxRows as string | undefined;
  const maxRows = maxRowsStr ? Number(maxRowsStr) : undefined;
  if (maxRows != null && (!Number.isFinite(maxRows) || maxRows <= 0)) {
    res.status(400).json({ error: `Invalid maxRows: ${maxRowsStr}` });
    return;
  }

  try {
    const result = await ingestPpp(url, maxRows);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
