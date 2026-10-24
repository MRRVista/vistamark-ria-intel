/**
 * Vercel cron: DOL Form 5500 Schedule H / I refresh (plan financials + asset
 * mix, migration 0010). Runs daily at 05:40 UTC but is freshness-guarded: a
 * schedule is skipped when ingest_runs already shows an ok load for the same
 * filing year within the last 6 days, so the download only happens once a week
 * (right after the Thursday 05:00 UTC F_5500 cron) — the same daily-check
 * pattern the IPEDS cron uses. Each schedule runs as its own call budget-wise:
 * ?schedule=H or ?schedule=I restricts to one; default does H then I.
 *
 * Vercel cron header or Bearer CRON_SECRET (requireCron). Also a safe manual
 * trigger: POST/GET /api/cron/refresh-dol-sch-h?force=1 ignores the guard.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { requireCron } from "../../lib/auth";
import { db } from "../../lib/db";
import { defaultIngestYear } from "../../lib/dol-5500/ingest";
import { ingestSchedule, schHTableExists } from "../../lib/dol-5500/schedule-h";

const FRESH_DAYS = 6;

async function freshOk(year: number, schedule: "H" | "I"): Promise<boolean> {
  if (!db) return false;
  const rows = (await db.execute(sql`
    SELECT 1 FROM ingest_runs
    WHERE source = ${`dol-sch-h/${schedule}/${year}`} AND status = 'ok'
      AND finished_at > NOW() - make_interval(days => ${FRESH_DAYS})
    LIMIT 1
  `)) as unknown as { rows?: unknown[] } | unknown[];
  const arr = Array.isArray(rows) ? rows : rows.rows ?? [];
  return arr.length > 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  const yearRaw = Number(req.query.year);
  const year = Number.isFinite(yearRaw) && yearRaw > 2000 ? yearRaw : Number(process.env.DOL_5500_YEAR) || defaultIngestYear();
  const only = String(req.query.schedule ?? "").toUpperCase();
  const schedules = (only === "H" || only === "I" ? [only] : ["H", "I"]) as Array<"H" | "I">;
  const force = req.query.force === "1" || req.query.force === "true";

  if (!(await schHTableExists())) {
    res.status(200).json({ ok: true, skipped: true, reason: "dol_sch_h_i missing — apply migration 0010 (POST /api/admin/migrate)" });
    return;
  }

  const results: Record<string, unknown> = {};
  let anyError = false;
  for (const s of schedules) {
    if (!force && (await freshOk(year, s))) {
      results[s] = { skipped: true, reason: `ok load within ${FRESH_DAYS} days` };
      continue;
    }
    try {
      results[s] = await ingestSchedule(year, s);
    } catch (err) {
      anyError = true;
      results[s] = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  res.status(anyError ? 500 : 200).json({ ok: !anyError, year, results });
}
