import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { runMigrations } from "../../lib/migrate";
import { db, isDbReady, schema } from "../../lib/db";
import { runProspectEngine } from "../../lib/prospects/engine";

/**
 * Nightly prospect engine — 7:00 PM Hinsdale time, three drafts.
 *
 * Vercel crons are UTC and can't express a local time across DST, so
 * vercel.json fires this at BOTH 00:00 and 01:00 UTC and the handler runs only
 * when it is actually 19:00 in America/Chicago (00:00Z during CDT, 01:00Z
 * during CST). The other firing is a no-op that returns skipped:true.
 *
 * Manual runs (CRON_SECRET header) bypass the clock check and accept
 * ?target= ?maxCandidates= ?budgetMs= ?zip= ?dryRun=1 for testing.
 */
const LOCAL_HOUR = Number(process.env.PROSPECT_ENGINE_LOCAL_HOUR || 19);
const TZ = "America/Chicago";

function chicagoHour(d = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(d);
  return Number(h) % 24;
}

async function prospectTablesExist(): Promise<boolean> {
  try {
    await db.select({ zip5: schema.prospectZips.zip5 }).from(schema.prospectZips).limit(1);
    return true;
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) { res.status(401).json({ error: cron.reason }); return; }

  const isVercelCron = !!req.headers["x-vercel-cron"];
  const q = req.query as Record<string, string | undefined>;
  const force = q.force === "1" || !isVercelCron;

  if (!force && chicagoHour() !== LOCAL_HOUR) {
    res.status(200).json({ ok: true, skipped: true, reason: `not ${LOCAL_HOUR}:00 in ${TZ}`, chicagoHour: chicagoHour() });
    return;
  }

  try {
    if (!isDbReady()) { res.status(500).json({ ok: false, error: "DATABASE_URL not configured" }); return; }
    if (!(await prospectTablesExist())) {
      console.log("[prospect-engine] prospect tables missing; running migrations");
      const mig = await runMigrations();
      if (!mig.ok) { res.status(500).json({ stage: "bootstrap", ...mig }); return; }
    }

    const summary = await runProspectEngine({
      zip5: q.zip,
      target: q.target ? Number(q.target) : undefined,
      maxCandidates: q.maxCandidates ? Number(q.maxCandidates) : undefined,
      budgetMs: q.budgetMs ? Number(q.budgetMs) : undefined,
      dryRun: q.dryRun === "1",
      actor: isVercelCron ? "prospect-engine:cron" : "prospect-engine:manual",
    });
    res.status(200).json(summary);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
