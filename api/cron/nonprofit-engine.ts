import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { runMigrations } from "../../lib/migrate";
import { db, isDbReady } from "../../lib/db";
import { sql } from "drizzle-orm";
import { runNonprofitEngine } from "../../lib/nonprofit/engine";

/**
 * Nightly nonprofit outreach engine — 7:00 PM Chicago, two programs
 * (matt + ryan), 3 drafts each, v0.29.0.
 *
 * Vercel crons are UTC and can't express a local time across DST, so
 * vercel.json fires each program at BOTH 00:xx and 01:xx UTC and the handler
 * runs only when it is actually 19:00 in America/Chicago. The programs are
 * staggered (:00 matt, :20 ryan) so each invocation only carries one
 * program's three research+draft cycles.
 *
 * Scheduled runs are ON by default (M. Rice, 2026-10-16: "running every
 * evening at 7 pm"); set NONPROFIT_ENGINE_ENABLED=0 to pause. This engine
 * drafts into each PRINCIPAL'S OWN mailbox (never sends), so it does not
 * collide with the prospect-engine / D-061 single-mailbox concern.
 *
 * v0.30.0: every run (scheduled or manual) first reads each program's settings
 * from its VistaRandall directive card (lib/nonprofit/remote-config.ts). A
 * program paused on its card is skipped; VistaRandall unreachable => the whole
 * run is skipped, np_events kind config_unreachable, HTTP 503.
 *
 * Manual runs (CRON_SECRET header) bypass the clock and accept
 * ?program=matt|ryan ?target= ?maxCandidates= ?budgetMs= ?dryRun=1.
 */
const LOCAL_HOUR = Number(process.env.NONPROFIT_ENGINE_LOCAL_HOUR || 19);
const TZ = "America/Chicago";

function chicagoHour(d = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(d);
  return Number(h) % 24;
}

async function npTablesExist(): Promise<boolean> {
  try { await db.execute(sql`SELECT 1 FROM np_leads LIMIT 1`); return true; } catch { return false; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) { res.status(401).json({ error: cron.reason }); return; }

  // v0.30.1: Vercel's scheduler identifies itself by user-agent "vercel-cron/1.0" (plus the
  // CRON_SECRET bearer); it does not reliably send x-vercel-cron. Without this a scheduled call
  // reads as "manual": the 19:00 Chicago gate and NONPROFIT_ENGINE_ENABLED were bypassed and each
  // program ran at BOTH its 00:xx and 01:xx UTC slots (np_leads 10/16-10/18: two runs a night).
  const isVercelCron = !!req.headers["x-vercel-cron"] || /vercel-cron/i.test(String(req.headers["user-agent"] || ""));
  const q = req.query as Record<string, string | undefined>;
  const force = q.force === "1" || !isVercelCron;

  if (isVercelCron && process.env.NONPROFIT_ENGINE_ENABLED === "0") {
    res.status(200).json({ ok: true, skipped: true, reason: "NONPROFIT_ENGINE_ENABLED=0; scheduled runs paused" });
    return;
  }
  if (!force && chicagoHour() !== LOCAL_HOUR) {
    res.status(200).json({ ok: true, skipped: true, reason: `not ${LOCAL_HOUR}:00 in ${TZ}`, chicagoHour: chicagoHour() });
    return;
  }

  try {
    if (!isDbReady()) { res.status(500).json({ ok: false, error: "DATABASE_URL not configured" }); return; }
    if (!(await npTablesExist())) {
      console.log("[nonprofit-engine] np tables missing; running migrations");
      const mig = await runMigrations();
      if (!mig.ok) { res.status(500).json({ stage: "bootstrap", ...mig }); return; }
    }

    const program = q.program === "matt" || q.program === "ryan" ? q.program : undefined;
    const summary = await runNonprofitEngine({
      program,
      target: q.target ? Number(q.target) : undefined,
      maxCandidates: q.maxCandidates ? Number(q.maxCandidates) : undefined,
      budgetMs: q.budgetMs ? Number(q.budgetMs) : undefined,
      dryRun: q.dryRun === "1",
      actor: isVercelCron ? "nonprofit-engine:cron" : "nonprofit-engine:manual",
    });
    // v0.30.0: a run skipped because VistaRandall could not be read is a failure, not a 200.
    if (!summary.ok) console.error(`[nonprofit-engine] ${summary.error}`);
    res.status(summary.ok ? 200 : 503).json(summary);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
