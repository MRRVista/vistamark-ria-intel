import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { requireCron } from "../../lib/auth";
import { db, isDbReady } from "../../lib/db";
import { createDraft, updateDraftBody, stripLegacySig } from "../../lib/nonprofit/engine";
import { PROGRAMS } from "../../lib/nonprofit/programs";
import { nonprofitDraftCategories } from "../../lib/nonprofit/draft-categories"; // v0.34.1

/**
 * Nonprofit-engine draft queue — v0.29.3.
 *
 * When Graph delivery fails (expired client secret, throttling), the engine
 * still finishes the lead: the full draft (to/subject/body/mailbox) is in the
 * np_events `deliver` row with meta.delivery = "pending" and the VistaCRM
 * Lead already exists. This endpoint is the retry path once Graph is healthy.
 *
 *   GET  /api/admin/np-drafts            — list pending drafts
 *   POST /api/admin/np-drafts {action:"flush"}
 *        — re-attempt the Outlook draft for every pending row; on success the
 *          event flips to delivery "outlook_draft" and the lead row gets the
 *          graph message id. Partial failures are reported, not fatal.
 *
 * Auth: Bearer CRON_SECRET, same as every other admin endpoint.
 */

function rows<T = any>(r: any): T[] { return (r?.rows ?? r ?? []) as T[]; }

async function pending() {
  return rows(await db.execute(sql`
    SELECT e.id, e.lead_id AS "leadId", e.created_at AS "createdAt", e.meta,
           l.program, l.org_name AS "orgName", l.person_name AS "personName"
    FROM np_events e
    JOIN np_leads l ON l.id = e.lead_id
    WHERE e.kind = 'deliver' AND e.meta->>'delivery' = 'pending'
    ORDER BY e.id`));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) { res.status(401).json({ error: cron.reason }); return; }
  if (!isDbReady()) { res.status(500).json({ ok: false, error: "DATABASE_URL not configured" }); return; }

  const rowsPending = await pending();

  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      pending: rowsPending.map((r) => ({
        eventId: r.id, leadId: r.leadId, program: r.program, org: r.orgName,
        person: r.personName, to: r.meta?.to, mailbox: r.meta?.mailbox,
        subject: r.meta?.subject, queuedAt: r.createdAt,
      })),
      note: "POST {\"action\":\"flush\"} to re-attempt Outlook delivery for every row.",
    });
    return;
  }

  const body = (typeof req.body === "object" && req.body) || {};
  const action = (body as any).action;

  if (action === "strip_sig") {
    // One-time cleanup (v0.29.4): remove the appended signature block + footer
    // from drafts already delivered to Outlook — Sigsync owns signatures now.
    const delivered = rows(await db.execute(sql`
      SELECT e.id, e.meta, l.program
      FROM np_events e JOIN np_leads l ON l.id = e.lead_id
      WHERE e.kind = 'deliver' AND e.meta->>'graphMessageId' IS NOT NULL`));
    const patched: any[] = [];
    const failed: any[] = [];
    for (const r of delivered) {
      const m = r.meta ?? {};
      const prog = r.program === "ryan" ? PROGRAMS.ryan : PROGRAMS.matt;
      const cleaned = stripLegacySig(prog, String(m.body ?? ""));
      if (cleaned === m.body) continue;
      const mailbox = m.mailbox ?? prog.mailbox;
      try {
        await updateDraftBody(mailbox, m.graphMessageId, cleaned);
        await db.execute(sql`
          UPDATE np_events SET meta = meta || ${JSON.stringify({ body: cleaned, sigStrippedAt: new Date().toISOString() })}::jsonb
          WHERE id = ${r.id}`);
        patched.push({ eventId: r.id, subject: m.subject, mailbox });
      } catch (err) {
        failed.push({ eventId: r.id, subject: m.subject, error: String(err).slice(0, 200) });
      }
    }
    res.status(200).json({ ok: failed.length === 0, patched: patched.length, failed, drafts: patched });
    return;
  }

  if (action !== "flush") { res.status(400).json({ error: "POST body must be {\"action\":\"flush\"} or {\"action\":\"strip_sig\"}" }); return; }

  const delivered: any[] = [];
  const failed: any[] = [];
  for (const r of rowsPending) {
    const m = r.meta ?? {};
    const mailbox = m.mailbox
      ?? (r.program === "ryan" ? PROGRAMS.ryan.mailbox : PROGRAMS.matt.mailbox);
    try {
      const prog = r.program === "ryan" ? PROGRAMS.ryan : PROGRAMS.matt;
      // v0.34.1: flushed drafts carry the same categories a live run stamps. The
      // card's D-number is not known here (file defaults only), so the chip
      // names the program without it.
      const g = await createDraft(mailbox, m.to, m.toName ?? r.personName ?? "", m.subject ?? "", stripLegacySig(prog, String(m.body ?? "")), nonprofitDraftCategories(null, `${r.program === "ryan" ? "RYAN" : "MATT"} -- NONPROFIT OUTREACH`));
      await db.execute(sql`
        UPDATE np_events
        SET meta = meta || ${JSON.stringify({ delivery: "outlook_draft", graphMessageId: g.id, graphWebLink: g.webLink, flushedAt: new Date().toISOString() })}::jsonb
        WHERE id = ${r.id}`);
      await db.execute(sql`UPDATE np_leads SET graph_message_id = ${g.id}, updated_at = NOW() WHERE id = ${r.leadId}`);
      delivered.push({ eventId: r.id, leadId: r.leadId, org: r.orgName, person: r.personName, mailbox });
    } catch (err) {
      failed.push({ eventId: r.id, org: r.orgName, error: String(err).slice(0, 250) });
    }
  }
  res.status(200).json({ ok: failed.length === 0, delivered: delivered.length, failed, drafts: delivered });
}
