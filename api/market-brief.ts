/**
 * GET /api/market-brief — the pre-market composite, served for cron
 * consumption (vistamark-m365 morning brief).
 *
 * Deliberately unauthenticated, same posture as /api/selftest: GET only,
 * no arguments, aggregated PUBLIC macro data only (FRED, Treasury DTS,
 * OFR) — no client, prospect, or database-backed data. Gate or remove
 * alongside /api/selftest if desired.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { morningMarketBrief } from "../lib/brief/market";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }
  try {
    const brief = await morningMarketBrief();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(brief);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
