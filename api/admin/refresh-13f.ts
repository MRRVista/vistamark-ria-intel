import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ingest13f } from "../../lib/sec-13f/ingest";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual SEC Form 13F ingest trigger. Bearer CRON_SECRET required.
 *
 * Matt supplies a quarterly data-set URL from
 *   https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets
 * e.g. https://www.sec.gov/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip
 *
 * The filings table (one row per accession: manager identity + totals) is
 * always loaded in full. Holdings ingestion is targeted:
 *   ?manager=harvard     only ingest positions for managers whose name contains "harvard"
 *   ?maxHoldings=50000   cap holdings rows this call (for the unfiltered case)
 * Omitting both pulls ALL holdings for the quarter (large; may time out — use a
 * manager filter for targeted prospecting instead).
 *
 * Usage:
 *   POST /api/admin/refresh-13f?url=...&manager=stepstone
 *   GET  /api/admin/refresh-13f   -> usage
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-13f",
      description:
        "SEC Form 13F institutional-holdings ingest. Source: SEC Form 13F Data Sets (quarterly TSV zips).",
      usage:
        "POST with Bearer CRON_SECRET and ?url=<quarterly zip url>. " +
        "Optional ?manager=<substring> to target one manager's holdings, " +
        "?maxHoldings=<N> to cap rows. Filings table always loaded in full.",
      sourcePage:
        "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets",
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
    res.status(400).json({ error: "Missing or invalid ?url= (must be http(s) zip URL)" });
    return;
  }
  const manager = (req.query.manager as string | undefined)?.trim() || undefined;
  const maxHoldingsStr = req.query.maxHoldings as string | undefined;
  const maxHoldings = maxHoldingsStr ? Number(maxHoldingsStr) : undefined;
  if (maxHoldings != null && (!Number.isFinite(maxHoldings) || maxHoldings <= 0)) {
    res.status(400).json({ error: `Invalid maxHoldings: ${maxHoldingsStr}` });
    return;
  }

  try {
    const result = await ingest13f(url, { managerFilter: manager, maxHoldings });
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
