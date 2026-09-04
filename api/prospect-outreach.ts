import type { VercelRequest, VercelResponse } from "@vercel/node";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireAccessOrSession } from "../lib/auth";
import { db, isDbReady, schema } from "../lib/db";

/**
 * Engine draft queue — the hand-off surface between the nightly prospect
 * engine and whoever puts the note in front of a partner.
 *
 *   GET  /api/prospect-outreach?status=pending|outlook_draft|delivered|all&limit=20
 *        → drafts (subject, body, recipient, hooks, source URL), newest first
 *   POST /api/prospect-outreach  { eventId, delivery: "delivered"|"outlook_draft"|"sent"|"discarded", ref?: string }
 *        → acks a queued draft (the m365 side calls this after creating the
 *          Outlook draft; a partner's send flow calls it with "sent")
 *
 * "sent" also flips the prospect to lead_status contacted and logs an email
 * event, so the CRM feed sees the touch without a second integration.
 *
 * Reads PII. Same auth posture as /api/prospects: Entra session or ACCESS_TOKEN.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAccessOrSession(req);
  if (!auth.ok) { res.status(401).json({ error: auth.reason }); return; }
  if (!isDbReady()) { res.status(500).json({ error: "DATABASE_URL not configured" }); return; }

  const { prospectEvents, prospects } = schema;

  try {
    if (req.method === "GET") {
      const q = req.query as Record<string, string | undefined>;
      const status = (q.status || "pending").toLowerCase();
      const limit = Math.max(1, Math.min(Number(q.limit) || 20, 100));
      const conds = [eq(prospectEvents.kind, "outreach_draft")];
      if (status !== "all") conds.push(sql`${prospectEvents.meta}->>'delivery' = ${status}`);

      const rows = await db
        .select({
          eventId: prospectEvents.id,
          at: prospectEvents.at,
          meta: prospectEvents.meta,
          prospectId: prospects.id,
          fullName: prospects.fullName,
          firstName: prospects.firstName,
          employer: prospects.employer,
          title: prospects.title,
          leadStatus: prospects.leadStatus,
        })
        .from(prospectEvents)
        .innerJoin(prospects, eq(prospectEvents.prospectId, prospects.id))
        .where(and(...conds))
        .orderBy(desc(prospectEvents.at))
        .limit(limit);

      res.status(200).json({
        status,
        count: rows.length,
        drafts: rows.map((r) => {
          const m = (r.meta ?? {}) as Record<string, unknown>;
          return {
            eventId: r.eventId,
            at: r.at,
            prospectId: r.prospectId,
            fullName: r.fullName,
            firstName: r.firstName,
            employer: r.employer,
            title: r.title,
            leadStatus: r.leadStatus,
            delivery: m.delivery,
            to: m.to,
            subject: m.subject,
            body: m.body,
            hooks: m.hooks,
            emailSourceUrl: m.emailSourceUrl,
            graphWebLink: m.graphWebLink ?? null,
          };
        }),
      });
      return;
    }

    if (req.method === "POST") {
      const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as { eventId?: number; delivery?: string; ref?: string };
      const eventId = Number(body.eventId);
      const delivery = String(body.delivery || "").toLowerCase();
      const allowed = ["delivered", "outlook_draft", "sent", "discarded"];
      if (!eventId || !allowed.includes(delivery)) {
        res.status(400).json({ error: `eventId and delivery (${allowed.join("|")}) required` });
        return;
      }
      const [ev] = await db.select().from(prospectEvents).where(and(eq(prospectEvents.id, eventId), eq(prospectEvents.kind, "outreach_draft"))).limit(1);
      if (!ev) { res.status(404).json({ error: "draft not found" }); return; }

      const meta = { ...(ev.meta ?? {}), delivery, ackedAt: new Date().toISOString(), ackRef: body.ref ?? null };
      await db.update(prospectEvents).set({ meta }).where(eq(prospectEvents.id, eventId));

      const actor = auth.via === "session" && auth.email ? auth.email : "token";

      if (delivery === "sent") {
        await db.update(prospects).set({ leadStatus: "contacted", updatedAt: new Date() }).where(eq(prospects.id, ev.prospectId));
        await db.insert(prospectEvents).values({ prospectId: ev.prospectId, kind: "email", detail: `sent: ${String((ev.meta as Record<string, unknown> | null)?.subject ?? "")}`, meta: { fromDraftEvent: eventId, ref: body.ref ?? null }, actor });
      } else if (delivery === "discarded") {
        await db.update(prospects).set({ leadStatus: "researching", updatedAt: new Date() }).where(eq(prospects.id, ev.prospectId));
        await db.insert(prospectEvents).values({ prospectId: ev.prospectId, kind: "status_change", detail: "engine draft discarded by reviewer", meta: { fromDraftEvent: eventId }, actor });
      }

      res.status(200).json({ ok: true, eventId, delivery });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
