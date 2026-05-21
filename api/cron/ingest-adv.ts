import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { runFullIngest } from "../../lib/adv/ingest";
import { isDbReady } from "../../lib/db";

/**
 * Trigger SEC IAPD bulk feed ingest.
 *
 * Auth options:
 *   - Vercel cron header (scheduled invocations, automatic)
 *   - Authorization: Bearer CRON_SECRET (manual POST via curl)
 *   - ?token=CRON_SECRET query parameter (GET-callable, for bootstrap from MCP agents)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  const tokenOk = queryToken && process.env.CRON_SECRET && queryToken === process.env.CRON_SECRET;

  if (!cron.ok && !tokenOk) {
    res.status(401).json({ error: cron.reason });
    return;
  }

  if (!isDbReady()) {
    res.status(503).json({
      error: "DATABASE_URL not configured \u2014 connect Postgres in the Vercel dashboard",
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
