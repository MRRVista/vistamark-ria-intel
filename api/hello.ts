import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";

/**
 * Diagnostic + status endpoint — no auth required.
 * Returns env-var presence, Node version, plus DB stats if DATABASE_URL is wired.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const base = {
    ok: true,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    hasDbUrl: Boolean(process.env.DATABASE_URL),
    hasAccessToken: Boolean(process.env.ACCESS_TOKEN),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
  };

  if (!process.env.DATABASE_URL) {
    res.status(200).json(base);
    return;
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const [firmsRes, runsRes] = await Promise.all([
      sql("SELECT count(*)::int as count FROM firms"),
      sql(
        "SELECT id, status, firms_processed, firms_inserted, firms_updated, feed_date, error_message, started_at, finished_at FROM ingest_runs ORDER BY id DESC LIMIT 1"
      ),
    ]);
    res.status(200).json({
      ...base,
      firmCount: firmsRes[0]?.count ?? 0,
      lastIngest: runsRes[0] ?? null,
    });
  } catch (err) {
    res.status(200).json({
      ...base,
      dbError: err instanceof Error ? err.message : String(err),
    });
  }
}
