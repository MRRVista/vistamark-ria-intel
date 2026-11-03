import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { requireAccess } from "../lib/auth";
import { db, isDbReady } from "../lib/db";
import { runLawyerEngine } from "../lib/lawyer/engine";
import { loadEffectiveLawyerProgram } from "../lib/lawyer/remote-config";
import { isCategory } from "../lib/lawyer/programs";

/**
 * POST /api/lawyer-draft-now -- v0.39.0. Ad hoc lawyer COI drafts on top of
 * the nightly 8:00 PM CT run; called by VistaRandall (the card's "Draft now"
 * button and Randall's lawyer_draft_now tool). Same contract as
 * api/np-draft-now.ts: body { count: 1-15, category?, requestedBy, channel }
 * -> 202 { ok, requestId, count, chunks, mailbox, label, note }. Work runs
 * after the response (waitUntil) in chunks of <= 3 drafts with a 250 s budget
 * each. Auth: ACCESS_TOKEN (VistaRandall's RIA_INTEL_MCP_TOKEN).
 */

const CHUNK = 3;
const MAX_COUNT = 15;
const CHUNK_BUDGET_MS = 250_000;

function rows<T = any>(r: any): T[] { return (r?.rows ?? r ?? []) as T[]; }

async function logEvent(kind: string, detail: string, meta: Record<string, unknown>, actor: string): Promise<number> {
  const r = rows(await db.execute(sql`
    INSERT INTO lawyer_events (lead_id, kind, detail, meta, actor)
    VALUES (NULL, ${kind}, ${detail.slice(0, 2000)}, ${JSON.stringify(meta)}::jsonb, ${actor})
    RETURNING id`));
  return r[0]?.id ?? 0;
}

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
  const count = Number(b.count ?? CHUNK);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) { res.status(400).json({ ok: false, error: `count must be a whole number 1-${MAX_COUNT}` }); return; }
  const category = isCategory(b.category) ? b.category : undefined;
  const requestedBy = String(b.requestedBy || "unknown").trim().toLowerCase().slice(0, 120);
  const channel = String(b.channel || "api").trim().slice(0, 20);
  const actor = `lawyer-engine:adhoc:${requestedBy}`;

  try {
    const reg = rows(await db.execute(sql`SELECT to_regclass('public.lawyer_events') AS t`));
    if (!reg[0]?.t) { res.status(500).json({ ok: false, error: "lawyer tables do not exist yet; the engine has never run" }); return; }

    const cfg = await loadEffectiveLawyerProgram();
    if (!cfg.ok) {
      const msg = `ad hoc request refused: program settings could not be read from VistaRandall (${cfg.url}): ${cfg.error}`;
      await logEvent("config_unreachable", msg, { requestedBy, channel, adhoc: true }, actor);
      res.status(503).json({ ok: false, error: msg }); return;
    }
    const eff = cfg.program;
    if (!eff.enabled) { res.status(409).json({ ok: false, error: `${eff.label} is paused on its directive card; turn it on first.` }); return; }

    const open = rows(await db.execute(sql`
      SELECT r.id, r.created_at FROM lawyer_events r
      WHERE r.lead_id IS NULL AND r.kind = 'adhoc_request' AND r.created_at > NOW() - interval '6 minutes'
        AND NOT EXISTS (SELECT 1 FROM lawyer_events d WHERE d.kind = 'adhoc_done' AND d.meta->>'requestId' = r.id::text)
      ORDER BY r.id DESC LIMIT 1`));
    if (open[0]) { res.status(409).json({ ok: false, error: `an ad hoc lawyer request started ${new Date(open[0].created_at).toISOString()} is still running; try again in a few minutes.` }); return; }

    const chunks: number[] = [];
    for (let left = count; left > 0; left -= CHUNK) chunks.push(Math.min(CHUNK, left));
    const requestId = await logEvent("adhoc_request",
      `ad hoc: ${count} lawyer draft(s)${category ? ` (${category})` : ""} requested by ${requestedBy} via ${channel} into ${eff.program.mailbox}`,
      { count, category: category ?? null, chunks, requestedBy, channel, mailbox: eff.program.mailbox }, actor);

    const started = Date.now();
    // Chunks run sequentially: the discovery step hits slow directories and the
    // person-level dedupe is only safe when one run claims at a time.
    const work = (async () => {
      let drafted = 0; let skipped = 0; const errors: string[] = []; const warnings: string[] = []; const drafts: any[] = []; let exhausted = false;
      for (const target of chunks) {
        if (Date.now() - started > 280_000 - CHUNK_BUDGET_MS / 3) break;
        try {
          const r = await runLawyerEngine({ target, category, maxCandidates: 40, budgetMs: Math.min(CHUNK_BUDGET_MS, 290_000 - (Date.now() - started)), actor });
          if (!r.ok) { errors.push(String(r.error || "run failed").slice(0, 300)); continue; }
          drafted += r.drafted; skipped += r.skipped.filter((x) => x.reason !== "already_claimed").length;
          if (r.candidatesExhausted) exhausted = true;
          warnings.push(...r.warnings);
          for (const d of r.drafts) drafts.push({ person: d.person, firm: d.firm, lane: d.lane, subject: d.subject, delivery: d.delivery });
          if (exhausted) break;
        } catch (e: any) { errors.push(String(e?.message || e).slice(0, 300)); }
      }
      const short = drafted < count;
      const why = errors.length ? `; errors: ${errors.join(" | ")}` : exhausted ? "; no more untouched attorneys in the card's lanes/bands" : short ? "; time ran out" : "";
      const detail = `ad hoc done: ${drafted} of ${count} drafted into ${eff.program.mailbox}, ${skipped} skipped${why}`;
      if (errors.length || (short && drafted === 0)) console.error(`[lawyer-draft-now] ${detail}`);
      await logEvent("adhoc_done", detail, { requestId: String(requestId), count, category: category ?? null, drafted, skipped, errors, warnings: Array.from(new Set(warnings)).slice(0, 10), drafts, requestedBy, channel, elapsedMs: Date.now() - started }, actor);
    })().catch((e) => console.error("[lawyer-draft-now] could not record adhoc_done:", e));

    const note = `Drafting ${count} now into ${eff.program.mailbox} (Outlook Drafts; never sent). Expect them over the next ~4 minutes; the result is recorded as an adhoc_done notice.`;
    const bg = backgroundWaitUntil();
    if (!bg) { await work; res.status(200).json({ ok: true, requestId, count, chunks, mailbox: eff.program.mailbox, label: eff.label, note, ranInline: true }); return; }
    bg(work);
    res.status(202).json({ ok: true, requestId, count, chunks, mailbox: eff.program.mailbox, label: eff.label, note });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
