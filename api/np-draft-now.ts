import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { requireAccess } from "../lib/auth";
import { db, isDbReady } from "../lib/db";
import { runNonprofitEngine } from "../lib/nonprofit/engine";
import { loadEffectivePrograms } from "../lib/nonprofit/remote-config";

/**
 * POST /api/np-draft-now -- v0.31.0 (2026-10-19, M. Rice: "I want a button
 * where I can adhoc add more emails to my draft box right now or better yet
 * ask Randall to add them.")
 *
 * Ad hoc nonprofit drafts on top of the nightly 7:00 PM CT run. Called by
 * VistaRandall: the "Draft now" button on the program's directive card
 * (D-097 Matt / D-098 Ryan) and Randall's nonprofit_draft_now tool.
 *
 *   body { program: "matt"|"ryan", count: 1-15, requestedBy, channel }
 *   -> 202 { ok, requestId, program, count, chunks, mailbox }
 *
 * Same engine, same card settings, same gates, same org-level dedupe
 * (np_leads EIN claim) as the nightly run. Drafts only, never sends. The work
 * runs after the response (waitUntil) in parallel chunks of <= 3 drafts, each
 * with a 250 s budget so all finish inside the 300 s function limit; a request
 * for 15 can therefore come back short and says so in its adhoc_done notice.
 *
 * Refused up front (no work started): card settings unreadable (503),
 * program paused on its card (409), another ad hoc request for the same
 * program still running (409, 6-minute window).
 *
 * Audit: np_events program-level rows adhoc_request and adhoc_done (shown as
 * engine notices on the card via /api/np-status). Leads carry actor
 * nonprofit-engine:adhoc:<requestedBy>.
 *
 * Auth: ACCESS_TOKEN (VistaRandall holds it as RIA_INTEL_MCP_TOKEN).
 */

const CHUNK = 3;
const MAX_COUNT = 15;
const CHUNK_BUDGET_MS = 250_000;

function rows<T = any>(r: any): T[] { return (r?.rows ?? r ?? []) as T[]; }

/** Program-level np_events row (lead_id NULL), same shape the engine writes. */
async function logEvent(leadId: number | null, kind: string, detail: string, meta: Record<string, unknown>, actor: string): Promise<number> {
  const r = rows(await db.execute(sql`
    INSERT INTO np_events (lead_id, kind, detail, meta, actor)
    VALUES (${leadId}, ${kind}, ${detail.slice(0, 2000)}, ${JSON.stringify(meta)}::jsonb, ${actor})
    RETURNING id`));
  return r[0]?.id ?? 0;
}

/** Vercel's request context (what @vercel/functions' waitUntil wraps): keeps the
 *  function alive after the 202 until the promise settles, up to maxDuration. */
function backgroundWaitUntil(): ((p: Promise<unknown>) => void) | null {
  const ctx = (globalThis as any)[Symbol.for("@vercel/request-context")]?.get?.();
  return typeof ctx?.waitUntil === "function" ? (p) => ctx.waitUntil(p) : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = requireAccess(req);
  if (!auth.ok) { res.status(401).json({ ok: false, error: auth.reason }); return; }
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only" }); return; }
  if (!isDbReady()) { res.status(500).json({ ok: false, error: "DATABASE_URL not configured" }); return; }
  res.setHeader("Cache-Control", "no-store");

  const b: Record<string, any> = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const program = b.program === "matt" || b.program === "ryan" ? (b.program as "matt" | "ryan") : null;
  if (!program) { res.status(400).json({ ok: false, error: "program must be matt or ryan" }); return; }
  const count = Number(b.count ?? CHUNK);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) { res.status(400).json({ ok: false, error: `count must be a whole number 1-${MAX_COUNT}` }); return; }
  const requestedBy = String(b.requestedBy || "unknown").trim().toLowerCase().slice(0, 120);
  const channel = String(b.channel || "api").trim().slice(0, 20);
  const actor = `nonprofit-engine:adhoc:${requestedBy}`;

  try {
    const reg = rows(await db.execute(sql`SELECT to_regclass('public.np_events') AS t`));
    if (!reg[0]?.t) { res.status(500).json({ ok: false, error: "np tables do not exist yet; the engine has never run" }); return; }

    const cfg = await loadEffectivePrograms();
    if (!cfg.ok) {
      const msg = `ad hoc request refused: program settings could not be read from VistaRandall (${cfg.url}): ${cfg.error}`;
      await logEvent(null, "config_unreachable", msg, { program, requestedBy, channel, adhoc: true }, actor);
      res.status(503).json({ ok: false, error: msg }); return;
    }
    const eff = cfg.programs[program];
    if (!eff.enabled) { res.status(409).json({ ok: false, error: `${eff.label} is paused on its directive card; turn it on first.` }); return; }

    const open = rows(await db.execute(sql`
      SELECT r.id, r.created_at FROM np_events r
      WHERE r.lead_id IS NULL AND r.kind = 'adhoc_request' AND r.meta->>'program' = ${program}
        AND r.created_at > NOW() - interval '6 minutes'
        AND NOT EXISTS (SELECT 1 FROM np_events d WHERE d.kind = 'adhoc_done' AND d.meta->>'requestId' = r.id::text)
      ORDER BY r.id DESC LIMIT 1`));
    if (open[0]) {
      res.status(409).json({ ok: false, error: `an ad hoc request for ${program} started ${new Date(open[0].created_at).toISOString()} is still running; try again in a few minutes.` });
      return;
    }

    const chunks: number[] = [];
    for (let left = count; left > 0; left -= CHUNK) chunks.push(Math.min(CHUNK, left));
    const requestId = await logEvent(null, "adhoc_request",
      `ad hoc: ${count} draft(s) requested by ${requestedBy} via ${channel} into ${eff.program.mailbox}`,
      { program, count, chunks, requestedBy, channel, mailbox: eff.program.mailbox }, actor);

    const started = Date.now();
    const work = Promise.allSettled(chunks.map((target) => runNonprofitEngine({
      program, target, maxCandidates: 40, budgetMs: CHUNK_BUDGET_MS, actor,
    }))).then(async (results) => {
      let drafted = 0; let skipped = 0;
      const errors: string[] = []; const warnings: string[] = [];
      const drafts: Array<{ org: string; person: string; subject: string; delivery: string }> = [];
      let candidatesExhausted = false;
      for (const r of results) {
        if (r.status === "rejected") { errors.push(String((r.reason as any)?.message || r.reason).slice(0, 300)); continue; }
        if (!r.value.ok) { errors.push(String(r.value.error || "run failed").slice(0, 300)); continue; }
        for (const p of r.value.programs) {
          drafted += p.drafted; skipped += p.skipped.filter((x) => x.reason !== "ein_already_claimed").length; // parallel chunks race for the same orgs; a lost claim is not a skip
          if (p.candidatesExhausted) candidatesExhausted = true;
          warnings.push(...p.warnings);
          for (const d of p.drafts) drafts.push({ org: d.org, person: d.person, subject: d.subject, delivery: d.delivery });
        }
      }
      const short = drafted < count;
      const why = errors.length ? `; errors: ${errors.join(" | ")}` : candidatesExhausted ? "; no more untouched orgs match the card's band/geo" : short ? "; time ran out (each chunk has 250 s)" : "";
      const detail = `ad hoc done: ${drafted} of ${count} drafted into ${eff.program.mailbox}, ${skipped} skipped${why}`;
      if (errors.length || (short && drafted === 0)) console.error(`[np-draft-now] ${detail}`);
      await logEvent(null, "adhoc_done", detail, {
        program, requestId: String(requestId), count, drafted, skipped, errors, warnings: Array.from(new Set(warnings)).slice(0, 10),
        drafts, requestedBy, channel, elapsedMs: Date.now() - started,
      }, actor);
    }).catch((e) => console.error("[np-draft-now] could not record adhoc_done:", e));
    const note = `Drafting ${count} now into ${eff.program.mailbox} (Outlook Drafts; never sent). Expect them over the next ~4 minutes; the result is recorded as an adhoc_done notice.`;
    const bg = backgroundWaitUntil();
    if (!bg) {
      // No background context (local dev): do the work before answering.
      await work;
      res.status(200).json({ ok: true, requestId, program, count, chunks, mailbox: eff.program.mailbox, label: eff.label, note, ranInline: true });
      return;
    }
    bg(work);

    res.status(202).json({
      ok: true, requestId, program, count, chunks, mailbox: eff.program.mailbox, label: eff.label,
      note,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
