import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron, isVercelCronRequest } from "../../lib/auth";
import { runMigrations } from "../../lib/migrate";
import { db, isDbReady } from "../../lib/db";
import { sql } from "drizzle-orm";
import { runNonprofitEngine, type NpProgramSummary } from "../../lib/nonprofit/engine";
import { loadEffectivePrograms } from "../../lib/nonprofit/remote-config";

/**
 * Nightly nonprofit outreach engine — 7:00 PM Chicago, two programs
 * (matt + ryan), v0.29.0. Drafts per run come from each program's VistaRandall
 * card (1-10); above 3 the run fans out in parallel chunks (v0.40.1).
 *
 * Vercel crons are UTC and can't express a local time across DST, so
 * vercel.json fires each program at BOTH 00:xx and 01:xx UTC and the handler
 * runs only when it is actually 19:00 in America/Chicago. The programs are
 * staggered (:05 matt, :25 ryan) so each invocation only carries one
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

// v0.40.1: a card target above FANOUT_CHUNK runs as parallel chunks (see handler).
const FANOUT_CHUNK = 3;
const FANOUT_BUDGET_MS = 250_000;
const FANOUT_MAX_CANDIDATES = 80;

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
  const isVercelCron = isVercelCronRequest(req);
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
    const actor = isVercelCron ? "nonprofit-engine:cron" : "nonprofit-engine:manual";

    // v0.40.1 (2026-11-10, M. Rice: "Increase Matt's daily Nonprofit outreach to 10"): one
    // sequential pass makes about 3 drafts inside the 300 s function limit, so a card target
    // above 3 runs as parallel chunks of <= 3, each with its own 250 s budget (the np-draft-now
    // pattern). The np_leads EIN claim keeps the chunks off each other's orgs. A manual
    // ?target= or ?dryRun=1 keeps the single pass. If the card cannot be read here, fall
    // through: the single pass records config_unreachable and answers 503.
    if (program && !q.target && q.dryRun !== "1") {
      const cfg = await loadEffectivePrograms();
      const eff = cfg.ok ? cfg.programs[program] : null;
      const cardTarget = eff && eff.enabled ? Math.max(1, Math.min(eff.target, 10)) : 0;
      if (eff && cardTarget > FANOUT_CHUNK) {
        const started = Date.now();
        const chunks: number[] = [];
        for (let left = cardTarget; left > 0; left -= FANOUT_CHUNK) chunks.push(Math.min(FANOUT_CHUNK, left));
        const results = await Promise.allSettled(chunks.map((target) => runNonprofitEngine({
          program, target, maxCandidates: FANOUT_MAX_CANDIDATES, budgetMs: FANOUT_BUDGET_MS, actor,
        })));
        const merged: NpProgramSummary = {
          program, target: cardTarget, examined: 0, drafted: 0, skipped: [], drafts: [],
          budgetExhausted: false, candidatesExhausted: false, warnings: [], directiveDnum: eff.directiveDnum,
        };
        const errors: string[] = [];
        let has990 = false; let model = ""; let config: { source: string; fetchedAt: string } | null = null;
        for (const r of results) {
          if (r.status === "rejected") { errors.push(String((r.reason as any)?.message || r.reason).slice(0, 300)); continue; }
          if (!r.value.ok) { errors.push(String(r.value.error || "run failed").slice(0, 300)); continue; }
          has990 = r.value.has990; model = r.value.model; config = r.value.config ?? config;
          for (const p of r.value.programs) {
            merged.examined += p.examined; merged.drafted += p.drafted;
            merged.skipped.push(...p.skipped.filter((x) => x.reason !== "ein_already_claimed")); // chunks race for the same orgs; a lost claim is not a skip
            merged.drafts.push(...p.drafts);
            if (p.budgetExhausted) merged.budgetExhausted = true;
            if (p.candidatesExhausted) merged.candidatesExhausted = true;
            for (const w of p.warnings) if (!merged.warnings.includes(w)) merged.warnings.push(w);
          }
        }
        const ok = errors.length < results.length;
        if (errors.length) console.error(`[nonprofit-engine] ${program} fan-out: ${errors.length} of ${results.length} chunk(s) failed: ${errors.join(" | ")}`);
        if (merged.drafted < cardTarget) console.warn(`[nonprofit-engine] ${program} fan-out came back short: ${merged.drafted} of ${cardTarget} drafted${merged.candidatesExhausted ? " (no more untouched orgs in the card's band/geo)" : merged.budgetExhausted ? " (time ran out)" : ""}`);
        res.status(ok ? 200 : 503).json({
          ok, has990, model, elapsedMs: Date.now() - started, programs: [merged], chunks, config,
          ...(errors.length ? { error: errors.join(" | ") } : {}),
        });
        return;
      }
    }

    const summary = await runNonprofitEngine({
      program,
      target: q.target ? Number(q.target) : undefined,
      maxCandidates: q.maxCandidates ? Number(q.maxCandidates) : undefined,
      budgetMs: q.budgetMs ? Number(q.budgetMs) : undefined,
      dryRun: q.dryRun === "1",
      actor,
    });
    // v0.30.0: a run skipped because VistaRandall could not be read is a failure, not a 200.
    if (!summary.ok) console.error(`[nonprofit-engine] ${summary.error}`);
    res.status(summary.ok ? 200 : 503).json(summary);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
