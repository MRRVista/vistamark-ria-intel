import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import {
  ingestDirectory,
  ingestFinance,
  pickNextFinance,
  isDirectoryNeeded,
  DEFAULT_DIRECTORY_YEAR,
} from "../../lib/ipeds/ingest";

/**
 * Cron: walk through the IPEDS backfill, one (year, file) per tick.
 *
 * Schedule (vercel.json): every 15 minutes initially for fast backfill.
 * Once fully backfilled, the cron self-throttles by re-ingesting the most
 * recent provisional year only (which is cheap and picks up revisions).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  try {
    if (await isDirectoryNeeded()) {
      const result = await ingestDirectory(DEFAULT_DIRECTORY_YEAR);
      res.status(200).json({ ok: true, stage: "directory", ...result });
      return;
    }
    const next = await pickNextFinance();
    const result = await ingestFinance(next.fyear, next.fileType);
    res.status(200).json({ ok: true, stage: "finance", ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
