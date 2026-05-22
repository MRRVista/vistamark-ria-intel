import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { defaultIngestYear, ingestYear } from "../../lib/dol-5500/ingest";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  try {
    const year = defaultIngestYear();
    const result = await ingestYear(year);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
