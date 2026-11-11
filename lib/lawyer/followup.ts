/**
 * Lawyer COI outreach -- CRM pre-check and the one follow-up. v0.41.0.
 *
 * crmLookup: before an attorney is researched, ask VistaCRM whether the person
 * is already a contact (GET /api/contacts/lookup, same bridge secret the lead
 * create uses). Someone Matt already knows never gets a cold introduction.
 *
 * Follow-up: Graph helpers the engine's follow-up pass uses. A draft the
 * partner SENT that has had no answer after the card's followUpDays gets ONE
 * reply draft in the same thread (createReply, so Outlook threads it). Nothing
 * here sends mail.
 */

import { graphToken } from "../nonprofit/engine";

const CRM_BASE = (process.env.VISTACRM_URL || "https://vistacrm.app").replace(/\/$/, "");
const GRAPH = "https://graph.microsoft.com/v1.0";
const FIRM_DOMAINS = new Set(["vistamark.com", "vistamarkllc.com"]);

export interface CrmHit { crmId: string; name: string; company: string | null; roles: string[]; matchedBy: "email" | "name" }

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

async function crmGet(query: string): Promise<any[]> {
  const res = await fetch(`${CRM_BASE}/api/contacts/lookup?${query}`, {
    headers: { authorization: `Bearer ${process.env.VISTACRM_BRIDGE_SECRET}` },
    signal: AbortSignal.timeout(12_000),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !j?.ok) throw new Error(`crm lookup ${res.status}: ${String(j?.error ?? "no body").slice(0, 160)}`);
  return Array.isArray(j.results) ? j.results : [];
}

const toHit = (r: any, matchedBy: "email" | "name"): CrmHit => ({
  crmId: String(r.crm_id), name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(), company: r.company_name ?? null,
  roles: Array.isArray(r.roles) ? r.roles.map(String) : [], matchedBy,
});

/** The VistaCRM contact for this person, or null. Email is exact; a name match
 *  needs first AND last name to be equal (the lookup itself is a substring
 *  search). Throws when the CRM cannot be asked: the caller decides. */
export async function crmLookup(first: string | null, last: string | null, email: string | null): Promise<CrmHit | null> {
  if (!process.env.VISTACRM_BRIDGE_SECRET) return null;
  if (email) {
    const byEmail = await crmGet(`email=${encodeURIComponent(email)}`);
    if (byEmail.length) return toHit(byEmail[0], "email");
  }
  if (first && last) {
    const byName = await crmGet(`name=${encodeURIComponent(`${first} ${last}`)}&limit=25`);
    const hit = byName.find((r) => lc(r.first_name) === lc(first) && lc(r.last_name) === lc(last));
    if (hit) return toHit(hit, "name");
  }
  return null;
}

// -- Graph: conversation state and the reply draft --------------------------------------

const isMine = (addr: string, mailbox: string): boolean => {
  const [al, ad] = lc(addr).split("@");
  const [ml, md] = lc(mailbox).split("@");
  return !!al && al === ml && (ad === md || (FIRM_DOMAINS.has(ad) && FIRM_DOMAINS.has(md)));
};

async function graphJson(path: string, init: RequestInit = {}): Promise<any> {
  const token = await graphToken();
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`graph ${init.method || "GET"} ${res.status}: ${(await res.text()).slice(0, 240)}`);
  return res.status === 204 ? null : res.json();
}

/** conversationId of a message (read once, right after the draft is created). */
export async function conversationIdOf(mailbox: string, messageId: string): Promise<string | null> {
  const j = await graphJson(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=conversationId`);
  return j?.conversationId ? String(j.conversationId) : null;
}

export interface ThreadState {
  /** The partner's own sent message in the thread (the outreach), if it was sent. */
  sent: { id: string; at: string; subject: string } | null;
  /** First message in the thread from anyone else. */
  reply: { at: string; from: string } | null;
  /** A draft still sits in the thread (the original, unsent, or a follow-up). */
  hasDraft: boolean;
  messages: number;
}

export async function threadState(mailbox: string, conversationId: string): Promise<ThreadState> {
  const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
  const j = await graphJson(`/users/${encodeURIComponent(mailbox)}/messages?$filter=${filter}&$select=id,isDraft,from,subject,sentDateTime,receivedDateTime&$top=50`);
  const items: any[] = Array.isArray(j?.value) ? j.value : [];
  const out: ThreadState = { sent: null, reply: null, hasDraft: false, messages: items.length };
  const when = (m: any) => String(m?.sentDateTime || m?.receivedDateTime || "");
  items.sort((a, b) => when(a).localeCompare(when(b)));
  for (const m of items) {
    if (m?.isDraft) { out.hasDraft = true; continue; }
    const from = lc(m?.from?.emailAddress?.address);
    if (isMine(from, mailbox)) { if (!out.sent) out.sent = { id: String(m.id), at: when(m), subject: String(m?.subject || "") }; }
    else if (from && !out.reply) out.reply = { at: when(m), from };
  }
  return out;
}

/** One reply draft in the thread of `sentMessageId`. Returns the new draft. */
export async function createFollowUpDraft(mailbox: string, sentMessageId: string, text: string, categories: string[]): Promise<{ id: string; webLink: string | null }> {
  const base = `/users/${encodeURIComponent(mailbox)}/messages`;
  const d = await graphJson(`${base}/${encodeURIComponent(sentMessageId)}/createReply`, { method: "POST", body: JSON.stringify({ comment: text }) });
  if (!d?.id) throw new Error("graph createReply returned no draft id");
  await graphJson(`${base}/${encodeURIComponent(d.id)}`, { method: "PATCH", body: JSON.stringify({ categories }) });
  return { id: String(d.id), webLink: d.webLink ?? null };
}

/** The follow-up note. Deterministic on purpose: nothing about Vistamark is
 *  claimed that the first note did not already say, and there are no dashes. */
export function followUpText(firstName: string | null, senderFirst: string): string {
  const hi = firstName ? `Hi ${firstName},` : "Hello,";
  return [
    hi,
    "",
    "I wrote a few weeks ago to introduce myself and Vistamark. I know how full a practice gets, so I will keep this short. I would still welcome 20 minutes to learn about your work and to tell you what we do here in Hinsdale.",
    "",
    "If the timing is not right, no reply is needed and I will not write again.",
    "",
    senderFirst,
  ].join("\n");
}
