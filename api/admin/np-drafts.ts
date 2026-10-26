import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { requireCron } from "../../lib/auth";
import { db, isDbReady } from "../../lib/db";
import { createDraft, updateDraftBody, stripLegacySig, getMessageBody, patchDraftBodyAs, postInternalNote, draftEmail, patchDraft } from "../../lib/nonprofit/engine";
import type { OrgCandidate, ApolloPick, ResearchOut } from "../../lib/nonprofit/engine";
import { loadEffectivePrograms } from "../../lib/nonprofit/remote-config"; // v0.37.0
import { normalizeDirectOpening } from "../../lib/outreach/opening"; // v0.37.0
import { stripDashes } from "../../lib/outreach/dashes"; // v0.37.0
import { stripLegacyBriefingText, stripLegacyBriefingHtml, fixLegacyOpeningText, fixLegacyOpeningHtml } from "../../lib/nonprofit/legacy-note"; // v0.36.1
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

  // v0.36.2: the one-shot Vercel cron (vercel.json, CRON_SECRET bearer) can
  // only GET, so GET ?action=strip_note runs the cleanup for real.
  const getAction = req.method === "GET" ? String((req.query as any)?.action || "") : "";

  if (req.method === "GET" && getAction !== "strip_note" && getAction !== "reformat") {
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
  const action = getAction || (body as any).action;

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

  if (action === "strip_note") {
    // v0.36.1 (2026-10-26, Matt: "Still coming with verbiage." + the "Susie --"
    // opening, below): drafts made
    // before v0.31.0 still open with the "[FOR MATT: ...]" / "[FOR RYAN: ...]"
    // briefing. Take it out of every one that is STILL A DRAFT, reading the
    // live body from Outlook (so the partner's own edits survive), and move it
    // into the draft's internal note. Sent or deleted messages are left alone.
    // {"action":"strip_note","dryRun":true} reports without changing anything.
    const dryRun = (body as any).dryRun === true;
    const delivered = rows(await db.execute(sql`
      SELECT e.id, e.meta, l.program, l.first_name
      FROM np_events e JOIN np_leads l ON l.id = e.lead_id
      WHERE e.kind = 'deliver' AND e.meta->>'graphMessageId' IS NOT NULL
      ORDER BY e.id`));
    const patched: any[] = []; const failed: any[] = [];
    let gone = 0, sent = 0, clean = 0;
    for (const r of delivered) {
      const m = r.meta ?? {};
      const prog = r.program === "ryan" ? PROGRAMS.ryan : PROGRAMS.matt;
      const mailbox = m.mailbox ?? prog.mailbox;
      try {
        const msg = await getMessageBody(mailbox, m.graphMessageId);
        if (!msg) { gone += 1; continue; }
        if (!msg.isDraft) { sent += 1; continue; }
        const html = /html/i.test(msg.contentType);
        const out = html ? stripLegacyBriefingHtml(msg.content) : stripLegacyBriefingText(msg.content);
        // v0.36.1: and the pre-v0.36.0 "Susie -- your career..." opening becomes
        // the house "Susie, / Hope all is well. Your career..." (lib/outreach/opening).
        const first = r.first_name || (m.toName ? String(m.toName).split(/\s+/)[0] : null);
        const op = html ? fixLegacyOpeningHtml(out.body, first) : fixLegacyOpeningText(out.body, first);
        if (!out.briefing && !op.changed) { clean += 1; continue; }
        const newBody = op.body;
        if (!dryRun) {
          await patchDraftBodyAs(mailbox, m.graphMessageId, msg.contentType, newBody);
          const after = await getMessageBody(mailbox, m.graphMessageId);
          const still = after && (/\[(?:<[^>]*>|\s|&nbsp;)*FOR(?:<[^>]*>|\s|&nbsp;)+(?:MATT|RYAN):/.test(after.content));
          if (!after || still) throw new Error("patched, but the briefing still reads back in the draft");
          if (!out.briefing) {
            await db.execute(sql`UPDATE np_events SET meta = meta || ${JSON.stringify({ legacyOpeningFixedAt: new Date().toISOString() })}::jsonb WHERE id = ${r.id}`);
            patched.push({ eventId: r.id, mailbox, subject: msg.subject, fixed: "opening" });
            continue;
          }
          const label = `${r.program === "ryan" ? "RYAN" : "MATT"} -- NONPROFIT OUTREACH briefing`;
          const n = await postInternalNote(mailbox, m.graphMessageId, out.briefing.replace(/^FOR [A-Z]+:\s*/, ""), label);
          await db.execute(sql`
            UPDATE np_events SET meta = meta || ${JSON.stringify({ briefing: m.briefing ?? out.briefing, briefingDelivery: n.ok ? "internal_note" : "note_failed", legacyNoteStrippedAt: new Date().toISOString() })}::jsonb
            WHERE id = ${r.id}`);
          patched.push({ eventId: r.id, mailbox, subject: msg.subject, fixed: op.changed ? "briefing+opening" : "briefing", internalNote: n.ok ? "written" : `failed: ${n.error}` });
        } else {
          patched.push({ eventId: r.id, mailbox, subject: msg.subject, wouldStrip: out.briefing ? out.briefing.slice(0, 100) : null, wouldFixOpening: op.changed, newStart: (html ? newBody.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : newBody).slice(0, 90) });
        }
      } catch (err) {
        failed.push({ eventId: r.id, mailbox, subject: m.subject, error: String(err).slice(0, 220) });
      }
    }
    res.status(200).json({ ok: failed.length === 0, dryRun, checked: delivered.length, stripped: patched.length, alreadyClean: clean, sentOrNotDraft: sent, gone, failed, drafts: patched });
    return;
  }

  if (action === "reformat") {
    // v0.37.0 (2026-10-26, Matt + Ryan): bring nonprofit drafts still sitting
    // in Drafts up to the new format (two short paragraphs, "Name," then
    // straight into the reason, the fixed coffee/call ask, "Best," + first
    // name, no em dashes). Each one is RE-DRAFTED from the research already
    // stored on its lead, with the live card settings, then the draft's
    // subject and body are replaced in place (same message, so its internal
    // note stays). Sent/deleted messages are left alone, and so is any draft
    // the partner has already edited (live text no longer matches what the
    // engine wrote).
    const dryRun = (body as any).dryRun === true;
    const deadline = Date.now() + 270_000;
    const cfg = await loadEffectivePrograms();
    if (!cfg.ok) { res.status(503).json({ ok: false, error: `card settings unreachable: ${cfg.error}` }); return; }
    const delivered = rows(await db.execute(sql`
      SELECT e.id, e.meta, e.created_at AS "createdAt", l.id AS "leadId", l.program, l.ein, l.org_name, l.org_city, l.org_state, l.org_zip,
             l.pool_value, l.pool_source, l.invest_mgmt_fees, l.person_name, l.first_name, l.last_name, l.person_title,
             l.person_role, l.research
      FROM np_events e JOIN np_leads l ON l.id = e.lead_id
      WHERE e.kind = 'deliver' AND e.meta->>'graphMessageId' IS NOT NULL
        AND e.created_at > NOW() - INTERVAL '21 days'
      ORDER BY e.id DESC`));
    const done: any[] = []; const skipped: any[] = []; const failed: any[] = [];
    for (const r of delivered) {
      if (Date.now() > deadline) { skipped.push({ eventId: r.id, reason: "time budget" }); continue; }
      const m = r.meta ?? {};
      const key = r.program === "ryan" ? "ryan" : "matt";
      const prog = cfg.programs[key].program;
      const mailbox = m.mailbox ?? prog.mailbox;
      try {
        if (m.reformattedAt) { skipped.push({ eventId: r.id, reason: "already reformatted" }); continue; }
        const msg = await getMessageBody(mailbox, m.graphMessageId);
        if (!msg) { skipped.push({ eventId: r.id, reason: "gone" }); continue; }
        if (!msg.isDraft) { skipped.push({ eventId: r.id, reason: "sent" }); continue; }
        const live = textOf(msg.content, msg.contentType);
        const sim = overlap(live, String(m.body ?? ""));
        if (sim < 0.8) { skipped.push({ eventId: r.id, mailbox, subject: msg.subject, reason: `edited by partner (match ${sim.toFixed(2)})` }); continue; }
        const research = (r.research && typeof r.research === "object" ? r.research : {}) as ResearchOut;
        if (!research.personalization_hooks) research.personalization_hooks = [];
        const org = { ein: r.ein, name: r.org_name, city: r.org_city, state: r.org_state, zip: r.org_zip, poolValue: Number(r.pool_value ?? 0), poolSource: r.pool_source, investMgmtFees: r.invest_mgmt_fees } as unknown as OrgCandidate;
        const pick = { apolloId: null, name: r.person_name ?? m.toName ?? "", firstName: r.first_name ?? (m.toName ? String(m.toName).split(/\s+/)[0] : null), lastName: r.last_name, title: r.person_title, headline: null, linkedinUrl: null, employmentHistory: [], location: null } as ApolloPick;
        const d = await draftEmail(org, pick, r.person_role ?? "staff", research, prog, 45_000);
        const html = /html/i.test(msg.contentType);
        const content = html ? toHtml(d.body) : d.body;
        if (!dryRun) {
          await patchDraft(mailbox, m.graphMessageId, d.subject, msg.contentType, content);
          const after = await getMessageBody(mailbox, m.graphMessageId);
          if (!after || after.subject !== d.subject || overlap(textOf(after.content, after.contentType), d.body) < 0.9) throw new Error("patched, but the new text does not read back from the draft");
          await db.execute(sql`UPDATE np_events SET meta = meta || ${JSON.stringify({ subject: d.subject, body: d.body, previousSubject: m.subject, previousBody: m.body, reformattedAt: new Date().toISOString() })}::jsonb WHERE id = ${r.id}`);
          await db.execute(sql`UPDATE np_leads SET draft_subject = ${d.subject}, updated_at = NOW() WHERE id = ${r.leadId}`);
        }
        done.push({ eventId: r.id, mailbox, org: r.org_name, oldSubject: msg.subject, subject: d.subject, body: d.body });
      } catch (err) {
        failed.push({ eventId: r.id, mailbox, org: r.org_name, error: String(err).slice(0, 240) });
      }
    }
    console.log(`[np-drafts reformat] dryRun=${dryRun} reformatted=${done.length} skipped=${skipped.length} failed=${failed.length}`, JSON.stringify({ done: done.map((x) => ({ e: x.eventId, s: x.subject })), skipped, failed }).slice(0, 3500));
    res.status(200).json({ ok: failed.length === 0, dryRun, checked: delivered.length, reformatted: done.length, skipped, failed, drafts: done });
    return;
  }

  if (action !== "flush") { res.status(400).json({ error: "POST body must be {\"action\":\"flush\"}, {\"action\":\"strip_sig\"} or {\"action\":\"strip_note\"}" }); return; }

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
      const g = await createDraft(mailbox, m.to, m.toName ?? r.personName ?? "", m.subject ?? "", stripDashes(normalizeDirectOpening(stripLegacyBriefingText(stripLegacySig(prog, String(m.body ?? ""))).body, m.toName ? String(m.toName).split(/\s+/)[0] : r.personName ? String(r.personName).split(/\s+/)[0] : null)), nonprofitDraftCategories(null, `${r.program === "ryan" ? "RYAN" : "MATT"} -- NONPROFIT OUTREACH`));
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

// v0.37.0 helpers for reformat.
function textOf(content: string, contentType: string): string {
  const t = /html/i.test(contentType)
    ? content.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    : content;
  return t.replace(/\s+/g, " ").trim();
}

/** Share of the stored engine body's words still present in the live draft. */
function overlap(live: string, stored: string): number {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9$' ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const a = new Set(norm(live)); const b = norm(stored);
  if (!b.length) return 0;
  return b.filter((w) => a.has(w)).length / b.length;
}

function toHtml(text: string): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<html><body>${text.split(/\n\s*\n/).map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`).join("")}</body></html>`;
}

