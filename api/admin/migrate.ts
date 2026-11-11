import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runMigrations } from "../../lib/migrate";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST/GET /api/admin/migrate (Bearer CRON_SECRET) — apply any migrations/*.sql
 * file not yet recorded in schema_migrations. Thin wrapper: the runner, the
 * statement splitter and the ledger all live in lib/migrate.ts, so this
 * endpoint, the cron bootstraps and scripts/migrate.ts cannot drift apart
 * (this file used to carry its own copy of the runner).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only callable with CRON_SECRET to prevent random schema rewrites
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized — set CRON_SECRET env var and pass it as Bearer token" });
    return;
  }
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: "DATABASE_URL not configured" });
    return;
  }

  const r = await runMigrations();
  if (!r.ok) {
    res.status(500).json({ error: r.error, statement: r.statement, dir: r.dir });
    return;
  }
  res.status(200).json({
    ok: true,
    dir: r.dir,
    ran: r.applied.filter((f) => !f.alreadyApplied).map((f) => f.file),
    applied: r.applied,
  });
}
