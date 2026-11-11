import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron, isVercelCronRequest } from "../../lib/auth";
import { runMigrations } from "../../lib/migrate";
import { db, isDbReady } from "../../lib/db";
import { sql } from "drizzle-orm";
import { runLawyerEngine } from "../../lib/lawyer/engine";
import { isCategory } from "../../lib/lawyer/programs";

/**
 * Nightly lawyer COI outreach engine -- 8:00 PM Chicago (one hour after the
 * nonprofit engine), Matt's program, pace from the VistaRandall card. Built as
 * v0.39.0 on the lawyer-coi branch; merged to main as v0.40.0 (migration 0014).
 *
 * NOT SCHEDULED as of v0.40: vistarandall.app/api/lawyer-programs (the card
 * this engine reads its settings from) returned 404 on 2026-11-10, so a nightly
 * cron would only log a config_unreachable failure. Add the two cron entries
 * described below to vercel.json once that endpoint exists.
 *
 * Same clock-gate pattern as api/cron/nonprofit-engine.ts: vercel.json fires
 * at both 01:xx and 02:xx UTC and the handler runs only when it is 20:00 in
 * America/Chicago. LAWYER_ENGINE_ENABLED=0 pauses scheduled runs. The card
 * being paused also stops the run (recorded as a lawyer_events "paused" row).
 *
 * Manual runs (CRON_SECRET header) bypass the clock and accept
 * ?target= ?category=erisa|divorce|te|transaction|tax ?maxCandidates= ?budgetMs= ?dryRun=1.
 */
const LOCAL_HOUR = Number(process.env.LAWYER_ENGINE_LOCAL_HOUR || 20);
const TZ = "America/Chicago";

function chicagoHour(d = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(d);
  return Number(h) % 24;
}

async function tablesExist(): Promise<boolean> {
  try { await db.execute(sql`SELECT 1 FROM lawyer_leads LIMIT 1`); return true; } catch { return false; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) { res.status(401).json({ error: cron.reason }); return; }

  const isVercelCron = isVercelCronRequest(req);
  const q = req.query as Record<string, string | undefined>;
  const force = q.force === "1" || !isVercelCron;

  if (isVercelCron && process.env.LAWYER_ENGINE_ENABLED === "0") {
    res.status(200).json({ ok: true, skipped: true, reason: "LAWYER_ENGINE_ENABLED=0; scheduled runs paused" });
    return;
  }
  if (!force && chicagoHour() !== LOCAL_HOUR) {
    res.status(200).json({ ok: true, skipped: true, reason: `not ${LOCAL_HOUR}:00 in ${TZ}`, chicagoHour: chicagoHour() });
    return;
  }

  try {
    if (!isDbReady()) { res.status(500).json({ ok: false, error: "DATABASE_URL not configured" }); return; }
    if (!(await tablesExist())) {
      console.log("[lawyer-engine] lawyer tables missing; running migrations");
      const mig = await runMigrations();
      if (!mig.ok) { res.status(500).json({ stage: "bootstrap", ...mig }); return; }
    }
    const summary = await runLawyerEngine({
      target: q.target ? Number(q.target) : undefined,
      category: isCategory(q.category) ? q.category : undefined,
      maxCandidates: q.maxCandidates ? Number(q.maxCandidates) : undefined,
      budgetMs: q.budgetMs ? Number(q.budgetMs) : undefined,
      dryRun: q.dryRun === "1",
      actor: isVercelCron ? "lawyer-engine:cron" : "lawyer-engine:manual",
    });
    if (!summary.ok) console.error(`[lawyer-engine] ${summary.error}`);
    res.status(summary.ok ? 200 : 503).json(summary);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
