import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { runFullIngest } from "../../lib/adv/ingest";
import { isDbReady } from "../../lib/db";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }

  if (!isDbReady()) {
    res.status(503).json({
      error: "DATABASE_URL not configured — connect Postgres in the Vercel dashboard",
    });
    return;
  }

  try {
    const result = await runFullIngest();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
}
