import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { requireAccess } from "../lib/auth";
import { db, isDbReady } from "../lib/db";

/**
 * GET /api/np-status -- v0.30.0 (2026-10-19). What the nonprofit outreach
 * engine has actually done, per program, for the program panels on the
 * VistaRandall directive cards. Read-only.
 *
 * Auth: ACCESS_TOKEN (Bearer or ACCESS_TOKEN header) -- the credential
 * VistaRandall already holds as RIA_INTEL_MCP_TOKEN.
 *
 *   { ok, at, global: { engineEnabled, lastEventAt },
 *     programs: { matt|ryan: { totals, lastActivityAt, days[], recentLeads[], notices[] } } }
 *
 * notices = program-level np_events (lead_id NULL): "paused" and
 * "config_unreachable" (the run was skipped because VistaRandall could not
 * be read).
 */

function rows<T = any>(r: any): T[] { return (r?.rows ?? r ?? []) as T[]; }
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as any).toISOString());

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = requireAccess(req);
  if (!auth.ok) { res.status(401).json({ ok: false, error: auth.reason }); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, error: "GET only" }); return; }
  if (!isDbReady()) { res.status(500).json({ ok: false, error: "DATABASE_URL not configured" }); return; }
  res.setHeader("Cache-Control", "no-store");

  try {
    const reg = rows(await db.execute(sql`SELECT to_regclass('public.np_leads') AS t`));
    const global = { engineEnabled: process.env.NONPROFIT_ENGINE_ENABLED !== "0", lastEventAt: null as string | null };
    const empty = () => ({ totals: { leads: 0, drafted: 0, skipped: 0 }, lastActivityAt: null as string | null, days: [] as any[], recentLeads: [] as any[], notices: [] as any[] });
    const programs: Record<string, ReturnType<typeof empty>> = { matt: empty(), ryan: empty() };
    if (!reg[0]?.t) { res.status(200).json({ ok: true, at: new Date().toISOString(), global, programs, note: "np tables not created yet: the engine has never run" }); return; }

    const totals = rows(await db.execute(sql`
      SELECT program, COUNT(*)::int AS leads,
             COUNT(*) FILTER (WHERE draft_subject IS NOT NULL)::int AS drafted,
             COUNT(*) FILTER (WHERE status LIKE 'skipped%')::int AS skipped,
             MAX(updated_at) AS last
      FROM np_leads GROUP BY program`));
    const days = rows(await db.execute(sql`
      SELECT program, to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS d,
             COUNT(*)::int AS examined,
             COUNT(*) FILTER (WHERE draft_subject IS NOT NULL)::int AS drafted,
             COUNT(*) FILTER (WHERE status LIKE 'skipped%')::int AS skipped
      FROM np_leads GROUP BY 1, 2 ORDER BY 2 DESC LIMIT 60`));
    const leads = rows(await db.execute(sql`
      SELECT id, program, org_name, org_city, org_state, person_name, person_title, status, draft_subject, crm_contact_id, created_at
      FROM np_leads ORDER BY id DESC LIMIT 60`));
    const notices = rows(await db.execute(sql`
      SELECT kind, detail, meta->>'program' AS program, created_at
      FROM np_events WHERE lead_id IS NULL ORDER BY id DESC LIMIT 30`));
    const last = rows(await db.execute(sql`SELECT MAX(created_at) AS at FROM np_events`));
    global.lastEventAt = iso(last[0]?.at);

    for (const t of totals) {
      const p = programs[t.program]; if (!p) continue;
      p.totals = { leads: t.leads, drafted: t.drafted, skipped: t.skipped };
      p.lastActivityAt = iso(t.last);
    }
    for (const d of days) {
      const p = programs[d.program]; if (!p || p.days.length >= 14) continue;
      p.days.push({ date: d.d, examined: d.examined, drafted: d.drafted, skipped: d.skipped });
    }
    for (const l of leads) {
      const p = programs[l.program]; if (!p || p.recentLeads.length >= 15) continue;
      p.recentLeads.push({
        id: Number(l.id), org: l.org_name, city: l.org_city, state: l.org_state, person: l.person_name, title: l.person_title,
        status: l.status, subject: l.draft_subject, crm: l.crm_contact_id, createdAt: iso(l.created_at),
      });
    }
    for (const n of notices) {
      const at = iso(n.created_at);
      for (const k of Object.keys(programs)) {
        if (n.program && n.program !== "all" && n.program !== k) continue;
        if (programs[k].notices.length < 10) programs[k].notices.push({ at, kind: n.kind, detail: n.detail });
        if (!programs[k].lastActivityAt || (at && at > programs[k].lastActivityAt!)) programs[k].lastActivityAt = at;
      }
    }
    res.status(200).json({ ok: true, at: new Date().toISOString(), global, programs });
  } catch (err) {
    console.error("[np-status] failed:", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
