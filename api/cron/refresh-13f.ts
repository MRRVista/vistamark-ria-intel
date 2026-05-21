import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";

/**
 * Quarterly 13F holdings refresh.
 * v0: not yet implemented. The endpoint exists so Vercel cron registers without error.
 * v1 will parse SEC EDGAR 13F filings (form 13F-HR) and populate a `holdings` table.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  res.status(200).json({
    ok: true,
    note: "13F refresh stub — implementation pending (parses SEC EDGAR 13F-HR filings quarterly)",
    timestamp: new Date().toISOString(),
  });
}
