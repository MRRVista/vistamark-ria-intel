import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { requireAccess } from "../lib/auth";
import { db, isDbReady } from "../lib/db";

/**
 * GET /api/lawyer-status -- v0.39.0. What the lawyer COI outreach engine has
 * actually done, for the program panel on the VistaRandall directive card and
 * Randall's lawyer_status tool. Read-only. Auth: ACCESS_TOKEN (VistaRandall
 * holds it as RIA_INTEL_MCP_TOKEN). Shape mirrors /api/np-status with one
 * program ("matt") plus a byLane breakdown.
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
    const reg = rows(await db.execute(sql`SELECT to_regclass('public.lawyer_leads') AS t`));
    const global = { engineEnabled: process.env.LAWYER_ENGINE_ENABLED !== "0", lastEventAt: null as string | null };
    const p = { totals: { leads: 0, drafted: 0, skipped: 0 }, byLane: {} as Record<string, number>, lastActivityAt: null as string | null, days: [] as any[], recentLeads: [] as any[], notices: [] as any[] };
    if (!reg[0]?.t) { res.status(200).json({ ok: true, at: new Date().toISOString(), global, programs: { matt: p }, note: "lawyer tables not created yet: the engine has never run" }); return; }

    const t = rows(await db.execute(sql`
      SELECT COUNT(*)::int AS leads, COUNT(*) FILTER (WHERE draft_subject IS NOT NULL)::int AS drafted,
             COUNT(*) FILTER (WHERE status LIKE 'skipped%')::int AS skipped, MAX(updated_at) AS last FROM lawyer_leads`));
    const lanes = rows(await db.execute(sql`SELECT category, COUNT(*) FILTER (WHERE draft_subject IS NOT NULL)::int AS n FROM lawyer_leads GROUP BY 1`));
    const days = rows(await db.execute(sql`
      SELECT to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD') AS d,
             COUNT(*)::int AS examined, COUNT(*) FILTER (WHERE draft_subject IS NOT NULL)::int AS drafted,
             COUNT(*) FILTER (WHERE status LIKE 'skipped%')::int AS skipped
      FROM lawyer_leads GROUP BY 1 ORDER BY 1 DESC LIMIT 14`));
    const leads = rows(await db.execute(sql`
      SELECT id, category, person_name, firm, city, geo_band, email_status, status, draft_subject, crm_contact_id, created_at
      FROM lawyer_leads ORDER BY id DESC LIMIT 15`));
    // v0.41.0: follow-up columns exist once the engine has run on this version.
    const fcol = rows(await db.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'lawyer_leads' AND column_name = 'followup_state'`));
    const fu = fcol.length ? rows(await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE followup_state = 'drafted')::int AS drafted, COUNT(*) FILTER (WHERE followup_state = 'replied')::int AS replied,
             COUNT(*) FILTER (WHERE status LIKE 'skipped:already_in_crm')::int AS in_crm FROM lawyer_leads`)) : [];
    const notices = rows(await db.execute(sql`SELECT kind, detail, created_at FROM lawyer_events WHERE lead_id IS NULL ORDER BY id DESC LIMIT 10`));
    const last = rows(await db.execute(sql`SELECT MAX(created_at) AS at FROM lawyer_events`));
    global.lastEventAt = iso(last[0]?.at);
    if (t[0]) { p.totals = { leads: t[0].leads, drafted: t[0].drafted, skipped: t[0].skipped }; p.lastActivityAt = iso(t[0].last); }
    for (const l of lanes) p.byLane[l.category] = l.n;
    (p as any).followUps = { drafted: fu[0]?.drafted ?? 0, replied: fu[0]?.replied ?? 0 };
    (p as any).alreadyInCrm = fu[0]?.in_crm ?? 0;
    p.days = days.map((d) => ({ date: d.d, examined: d.examined, drafted: d.drafted, skipped: d.skipped }));
    p.recentLeads = leads.map((l) => ({ id: Number(l.id), lane: l.category, person: l.person_name, firm: l.firm, city: l.city, band: l.geo_band, emailStatus: l.email_status, status: l.status, subject: l.draft_subject, crm: l.crm_contact_id, createdAt: iso(l.created_at) }));
    p.notices = notices.map((n) => ({ at: iso(n.created_at), kind: n.kind, detail: n.detail }));
    for (const n of p.notices) if (!p.lastActivityAt || (n.at && n.at > p.lastActivityAt)) p.lastActivityAt = n.at;
    res.status(200).json({ ok: true, at: new Date().toISOString(), global, programs: { matt: p } });
  } catch (err) {
    console.error("[lawyer-status] failed:", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
