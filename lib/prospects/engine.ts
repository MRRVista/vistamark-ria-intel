/**
 * Prospect engine — the nightly "find N fully fleshed private-wealth leads
 * and draft them a note" pipeline.
 *
 *   select  → ranked untouched people in the target zip (home value, lead score)
 *   research→ one web-search-backed model call per candidate; returns who this
 *             person is professionally, wealth signals, personalization hooks,
 *             and — only if PUBLISHED on a page the model actually read — a
 *             professional email with the URL it came from
 *   gate    → no published professional email ⇒ mark and move on. Nothing is
 *             ever pattern-guessed and nothing is ever taken from a social
 *             network. This is the CAN-SPAM harvesting line and the
 *             don't-email-strangers-at-home line at the same time.
 *   draft   → second model call: persona + hooks → subject/body, checked
 *             against the banned-phrase list, footer appended
 *   deliver → Outlook Drafts via Microsoft Graph when the app credentials are
 *             set; otherwise queued (prospect_events, kind outreach_draft,
 *             meta.delivery = "pending") for the vistamark-m365 side to pull
 *             from GET /api/prospect-outreach. Nothing is ever SENT from here —
 *             a partner reads, edits, and sends from their own mailbox, which
 *             is also what puts the copy in the archived mail store.
 *
 * Every step writes a prospect_events row, so "why did the engine skip the
 * Hendersons" is a query, not a guess.
 *
 * Model calls use the Anthropic Messages API directly (same env pins as
 * /api/ask) with the hosted web_search tool for the research step.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, isDbReady, schema } from "../db";
import { PERSONA, personaFactsBlock } from "./persona";

const { prospects, prospectHouseholds, prospectEvents } = schema;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export const ENGINE_ACTOR = "prospect-engine";

// ── Types ──────────────────────────────────────────────────────────────────

export interface EngineOptions {
  zip5?: string;              // default: highest-priority active prospect_zip
  target?: number;            // drafts to produce; default 3
  maxCandidates?: number;     // hard cap on people examined per run; default 20
  budgetMs?: number;          // wall-clock budget; default 240_000
  dryRun?: boolean;           // research + draft, but do not create the Outlook draft or mutate lead status
  actor?: string;
}

export interface ResearchResult {
  confidence: "high" | "medium" | "low";
  identity_match: string;                 // why we believe this is the same person
  is_entity: boolean;                     // trust / LLC / estate — not a person
  summary: string;                        // 2–3 sentence professional bio
  employer: string | null;
  title: string | null;
  occupation: string | null;
  industry: string | null;
  is_business_owner: boolean | null;
  is_executive: boolean | null;
  wealth_signals: string[];
  personalization_hooks: string[];        // concrete, citable facts usable in a note
  email: string | null;
  email_source_url: string | null;
  email_kind: "professional" | "personal" | null;
  linkedin_url: string | null;
  sources: string[];
}

export interface DraftResult {
  subject: string;
  body: string;                           // plain text, footer NOT included
}

export interface EngineRunSummary {
  ok: boolean;
  zip5: string;
  target: number;
  examined: number;
  drafted: number;
  skipped: { reason: string; prospectId: number; name: string }[];
  drafts: { prospectId: number; name: string; email: string; subject: string; delivery: string; eventId: number }[];
  budgetExhausted: boolean;
  candidatesExhausted: boolean;
  elapsedMs: number;
  delivery: "graph" | "queue";
  warnings: string[];
}

// ── Anthropic client (minimal) ─────────────────────────────────────────────

type ContentBlock = { type: string; text?: string; [k: string]: unknown };

async function anthropic(body: Record<string, unknown>, timeoutMs: number): Promise<ContentBlock[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: MODEL, ...body }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { content?: ContentBlock[] };
    return json.content ?? [];
  } finally {
    clearTimeout(t);
  }
}

function finalText(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
}

/** Pull the JSON object out of a <result>…</result> envelope (or a bare fence). */
function extractJson<T>(text: string): T {
  const m = text.match(/<result>([\s\S]*?)<\/result>/i);
  let raw = (m ? m[1] : text).trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("model returned no JSON object");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

// ── Research ───────────────────────────────────────────────────────────────

const SOCIAL_HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com", "nextdoor.com", "zillow.com", "redfin.com", "realtor.com", "whitepages.com", "spokeo.com", "beenverified.com", "truepeoplesearch.com", "fastpeoplesearch.com", "peoplefinders.com", "radaris.com", "mylife.com"];

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function isSocialOrPeopleSearch(url: string | null): boolean {
  const h = hostOf(url);
  return !!h && SOCIAL_HOSTS.some((s) => h === s || h.endsWith("." + s));
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const FREE_MAIL = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "comcast.net", "att.net", "sbcglobal.net", "live.com", "msn.com", "protonmail.com"];

function isFreeMail(email: string): boolean {
  const d = email.split("@")[1]?.toLowerCase();
  return !!d && FREE_MAIL.includes(d);
}

export async function researchProspect(p: {
  fullName: string; firstName: string | null; lastName: string | null;
  addressLine1: string | null; city: string | null; state: string | null; zip5: string;
  employer?: string | null; title?: string | null; homeValue?: number | null;
}, timeoutMs: number): Promise<ResearchResult> {
  const known = [
    p.employer ? `Employer on file: ${p.employer}` : null,
    p.title ? `Title on file: ${p.title}` : null,
    p.homeValue ? `Home value on file: $${p.homeValue.toLocaleString("en-US")}` : null,
  ].filter(Boolean).join("\n");

  const system = `You are a research analyst for a Hinsdale, Illinois wealth-management firm. You identify the PROFESSIONAL public footprint of a named homeowner so a partner can write them a genuine, personal note.

Hard rules — these protect real people and the firm's registration:
- You may ONLY report an email address that is literally printed on a page you retrieved via web search (a firm bio, practice page, company "team" page, a professional directory the person controls, a conference/board listing). Report the exact URL it came from. NEVER construct, infer, or pattern-guess an email. If none is published, email is null.
- Never take contact details from social networks or people-search/data-broker sites (LinkedIn, Facebook, Whitepages, Spokeo, TruePeopleSearch, Zillow, etc.). You may cite LinkedIn only as a linkedin_url for the partner to look at; never as an email source.
- Prefer professional email; a personal address is only acceptable if the person themselves publishes it on their own professional page.
- Be honest about identity. Common names collide. Use the Hinsdale / west-suburban Chicago address as the anchor and say plainly how confident you are that the professional you found lives at that address. If you cannot connect them, say confidence "low" and leave employer/title null rather than guessing.
- If the "name" is a trust, LLC, estate, or otherwise not a natural person, set is_entity true.
- personalization_hooks must be concrete, verifiable, and appropriate to mention in a first email from a stranger: a role, a firm, a board seat, a published article, a civic role, a recent recognition. NEVER include health, family, religion, politics, litigation, divorce, home price, or anything a reasonable person would find creepy to have noticed.
- Do at most 6 searches. Stop early once you have a clear answer or a clear dead end.

Return your findings as a single JSON object inside <result></result> tags, matching exactly:
{"confidence":"high|medium|low","identity_match":"...","is_entity":false,"summary":"...","employer":null,"title":null,"occupation":null,"industry":null,"is_business_owner":null,"is_executive":null,"wealth_signals":[],"personalization_hooks":[],"email":null,"email_source_url":null,"email_kind":null,"linkedin_url":null,"sources":[]}`;

  const user = `Homeowner to research:
Name: ${p.fullName}
Address: ${[p.addressLine1, p.city, p.state, p.zip5].filter(Boolean).join(", ")}
${known}

Find this person's professional footprint and any PUBLISHED professional email, following the rules exactly.`;

  const blocks = await anthropic({
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
  }, timeoutMs);

  const r = extractJson<ResearchResult>(finalText(blocks));

  // Defensive normalisation — the gate below must never trust raw model output.
  r.email = typeof r.email === "string" && EMAIL_RE.test(r.email.trim()) ? r.email.trim().toLowerCase() : null;
  r.email_source_url = typeof r.email_source_url === "string" ? r.email_source_url.trim() : null;
  r.personalization_hooks = Array.isArray(r.personalization_hooks) ? r.personalization_hooks.filter((x) => typeof x === "string").slice(0, 6) : [];
  r.wealth_signals = Array.isArray(r.wealth_signals) ? r.wealth_signals.filter((x) => typeof x === "string").slice(0, 8) : [];
  r.sources = Array.isArray(r.sources) ? r.sources.filter((x) => typeof x === "string").slice(0, 10) : [];
  if (!["high", "medium", "low"].includes(r.confidence)) r.confidence = "low";
  return r;
}

/** Why a researched prospect cannot be drafted tonight, or null if it can. */
export function gateReason(r: ResearchResult): string | null {
  if (r.is_entity) return "entity_not_person";
  if (!r.email) return "no_published_email";
  if (!r.email_source_url) return "email_without_source";
  if (isSocialOrPeopleSearch(r.email_source_url)) return "email_from_social_or_broker";
  if (r.email_kind === "personal" && isFreeMail(r.email)) return "personal_freemail";
  if (r.confidence === "low") return "identity_low_confidence";
  if (r.personalization_hooks.length === 0) return "no_personalization_hooks";
  return null;
}

// ── Draft ──────────────────────────────────────────────────────────────────

export async function draftEmail(p: { firstName: string | null; fullName: string }, r: ResearchResult, timeoutMs: number): Promise<DraftResult> {
  const system = `You write short, warm, specific first emails from ${PERSONA.senderName}, ${PERSONA.senderTitle} of ${PERSONA.firm}, to a fellow Hinsdale resident. The sender is a neighbor with an unusual background, not a salesperson.

About the sender — you may use these facts and ONLY these facts about the sender or the firm:
${personaFactsBlock()}

Thesis to orbit (do not quote it): ${PERSONA.thesis}
Only permitted ask: ${PERSONA.callToAction}

Rules:
- 110 to 170 words in the body. Plain text. No bullet points, no bold, no subject-line clichés.
- Open with something specific about the RECIPIENT drawn from the hooks provided — their role, firm, board, or work — in one or two sentences. Make it clear a person noticed, not a mail merge. Do not mention their home, its value, or that they live at a particular address.
- Then at most TWO sender facts, chosen because they connect to the recipient (an executive gets the CIO/institutional fact; a nonprofit board member gets the family-office/institution fact; anyone gets the Hinsdale/Robbins Park/Central fact). Weave them in; do not list.
- Close with the permitted ask, phrased as an easy no.
- No performance claims, no promises, no numbers about returns. The $260 billion figure describes assets the prior firm oversaw, and must be framed that way if used.
- Never use any of these words or phrases: ${PERSONA.banned.join("; ")}.
- Sign off with the sender's first name only. Do not add a footer or disclaimer; that is appended separately.
- Subject line: 3–7 words, specific, lowercase-friendly, no exclamation marks, no "quick question".

Return a single JSON object inside <result></result> tags: {"subject":"...","body":"..."}`;

  const user = `Recipient: ${p.fullName} (first name: ${p.firstName ?? "unknown — use a neutral greeting"})
Professional summary: ${r.summary}
Employer / title: ${[r.employer, r.title].filter(Boolean).join(" — ") || "n/a"}
Hooks you may use:
${r.personalization_hooks.map((h) => `- ${h}`).join("\n")}

Write the email.`;

  const blocks = await anthropic({ max_tokens: 900, system, messages: [{ role: "user", content: user }] }, timeoutMs);
  const d = extractJson<DraftResult>(finalText(blocks));
  if (typeof d.subject !== "string" || typeof d.body !== "string") throw new Error("draft missing subject/body");
  d.subject = d.subject.trim().replace(/\s+/g, " ").slice(0, 120);
  d.body = d.body.trim();

  const lower = d.body.toLowerCase() + " " + d.subject.toLowerCase();
  const hit = PERSONA.banned.find((b) => lower.includes(b.toLowerCase()));
  if (hit) throw new Error(`draft used banned phrase: "${hit}"`);
  const words = d.body.split(/\s+/).length;
  if (words < 80 || words > 220) throw new Error(`draft length out of range (${words} words)`);
  return d;
}

export function finalBody(d: DraftResult): string {
  return `${d.body}\n\n${PERSONA.senderName}\n${PERSONA.senderTitle}, ${PERSONA.firm}\n${PERSONA.office}\n\n—\n${PERSONA.footer}`;
}

// ── Delivery: Microsoft Graph draft ────────────────────────────────────────

function graphConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TENANT_ID && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET && process.env.OUTREACH_MAILBOX);
}

async function graphToken(): Promise<string> {
  const tenant = process.env.MS_GRAPH_TENANT_ID!;
  const body = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID!,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`graph token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

/** Create (not send) a draft in the outreach mailbox. Returns the Graph message id + webLink. */
export async function createOutlookDraft(to: string, toName: string, subject: string, body: string): Promise<{ id: string; webLink: string | null }> {
  const token = await graphToken();
  const mailbox = process.env.OUTREACH_MAILBOX!;
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to, name: toName } }],
      internetMessageHeaders: [{ name: "X-Vistamark-Source", value: ENGINE_ACTOR }],
    }),
  });
  if (!res.ok) throw new Error(`graph draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { id: string; webLink?: string };
  return { id: j.id, webLink: j.webLink ?? null };
}

// ── Persistence helpers ────────────────────────────────────────────────────

async function logEvent(prospectId: number, kind: string, detail: string, meta: Record<string, unknown>, actor: string): Promise<number> {
  const [row] = await db.insert(prospectEvents).values({ prospectId, kind, detail, meta, actor }).returning({ id: prospectEvents.id });
  return row.id;
}

async function resolveZip(zip5?: string): Promise<string> {
  if (zip5) return zip5;
  const [z] = await db.select({ zip5: schema.prospectZips.zip5 }).from(schema.prospectZips)
    .where(eq(schema.prospectZips.active, true))
    .orderBy(asc(schema.prospectZips.priority), asc(schema.prospectZips.zip5)).limit(1);
  return z?.zip5 ?? "60521";
}

/**
 * Ranked, untouched people: lead_status 'new', not opted out, no email yet
 * (if a vendor already supplied one, the engine's research step isn't the
 * bottleneck — those go through the normal CRM path). Highest home value
 * first; ties by lead_score then id.
 */
async function selectCandidates(zip5: string, limit: number) {
  return db
    .select({
      id: prospects.id,
      fullName: prospects.fullName,
      firstName: prospects.firstName,
      lastName: prospects.lastName,
      addressLine1: prospects.addressLine1,
      city: prospects.city,
      state: prospects.state,
      zip5: prospects.zip5,
      employer: prospects.employer,
      title: prospects.title,
      homeValue: prospectHouseholds.homeValue,
    })
    .from(prospects)
    .leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id))
    .where(and(
      eq(prospects.zip5, zip5),
      eq(prospects.leadStatus, "new"),
      eq(prospects.doNotContact, false),
      eq(prospects.doNotEmail, false),
      sql`${prospects.email} IS NULL`,
    ))
    .orderBy(sql`${prospectHouseholds.homeValue} DESC NULLS LAST`, desc(prospects.leadScore), asc(prospects.id))
    .limit(limit);
}

// ── Orchestration ──────────────────────────────────────────────────────────

export async function runProspectEngine(opts: EngineOptions = {}): Promise<EngineRunSummary> {
  const started = Date.now();
  const target = Math.max(1, Math.min(opts.target ?? 3, 10));
  const maxCandidates = Math.max(target, Math.min(opts.maxCandidates ?? 20, 60));
  const budgetMs = Math.max(30_000, Math.min(opts.budgetMs ?? 240_000, 780_000));
  const actor = opts.actor ?? ENGINE_ACTOR;
  const delivery: "graph" | "queue" = graphConfigured() ? "graph" : "queue";
  const warnings: string[] = [];

  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const zip5 = await resolveZip(opts.zip5);

  const summary: EngineRunSummary = {
    ok: true, zip5, target, examined: 0, drafted: 0, skipped: [], drafts: [],
    budgetExhausted: false, candidatesExhausted: false, elapsedMs: 0, delivery, warnings,
  };
  if (delivery === "queue") warnings.push("MS_GRAPH_* / OUTREACH_MAILBOX not set — drafts queued in prospect_events for the m365 side to pull from GET /api/prospect-outreach");

  const candidates = await selectCandidates(zip5, maxCandidates);
  if (candidates.length === 0) {
    warnings.push(`no untouched prospects in ${zip5} — load an assessor/vendor list via POST /api/prospects first`);
    summary.candidatesExhausted = true;
    summary.elapsedMs = Date.now() - started;
    return summary;
  }

  const remaining = () => budgetMs - (Date.now() - started);

  for (const c of candidates) {
    if (summary.drafted >= target) break;
    // A research call can run ~60s with six searches; don't start one we can't finish.
    if (remaining() < 75_000) { summary.budgetExhausted = true; break; }
    summary.examined += 1;

    if (!opts.dryRun) await db.update(prospects).set({ leadStatus: "researching", updatedAt: new Date() }).where(eq(prospects.id, c.id));

    let research: ResearchResult;
    try {
      research = await researchProspect(c, Math.min(90_000, remaining() - 5_000));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logEvent(c.id, "note", `engine research failed: ${msg}`, { stage: "research", error: msg }, actor);
      if (!opts.dryRun) await db.update(prospects).set({ leadStatus: "new", updatedAt: new Date() }).where(eq(prospects.id, c.id));
      summary.skipped.push({ reason: "research_error", prospectId: c.id, name: c.fullName });
      continue;
    }

    await logEvent(c.id, "note", `engine research (${research.confidence}): ${research.summary}`.slice(0, 2000), { stage: "research", research }, actor);

    // Persist what we learned regardless of the gate — the CRM benefits either way.
    if (!opts.dryRun) {
      await db.update(prospects).set({
        employer: research.employer ?? c.employer ?? null,
        title: research.title ?? c.title ?? null,
        occupation: research.occupation ?? undefined,
        industry: research.industry ?? undefined,
        isBusinessOwner: research.is_business_owner ?? undefined,
        isExecutive: research.is_executive ?? undefined,
        linkedinUrl: research.linkedin_url ?? undefined,
        wealthSignals: sql`${prospects.wealthSignals} || ${JSON.stringify({ engine: research.wealth_signals, engineConfidence: research.confidence, engineAt: new Date().toISOString() })}::jsonb`,
        updatedAt: new Date(),
      }).where(eq(prospects.id, c.id));
    }

    const reason = gateReason(research);
    if (reason) {
      if (!opts.dryRun) {
        await db.update(prospects).set({
          leadStatus: reason === "entity_not_person" ? "disqualified" : "new",
          tags: sql`array_append(coalesce(${prospects.tags}, '{}'), ${"engine:" + reason})`,
          updatedAt: new Date(),
        }).where(eq(prospects.id, c.id));
      }
      await logEvent(c.id, "status_change", `engine skipped: ${reason}`, { stage: "gate", reason }, actor);
      summary.skipped.push({ reason, prospectId: c.id, name: c.fullName });
      continue;
    }

    let draft: DraftResult;
    try {
      draft = await draftEmail(c, research, 60_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logEvent(c.id, "note", `engine draft failed: ${msg}`, { stage: "draft", error: msg }, actor);
      if (!opts.dryRun) await db.update(prospects).set({ leadStatus: "new", updatedAt: new Date() }).where(eq(prospects.id, c.id));
      summary.skipped.push({ reason: "draft_error", prospectId: c.id, name: c.fullName });
      continue;
    }

    const body = finalBody(draft);
    const email = research.email!;
    let deliveryState = "pending";
    let graph: { id: string; webLink: string | null } | null = null;

    if (!opts.dryRun && delivery === "graph") {
      try {
        graph = await createOutlookDraft(email, c.fullName, draft.subject, body);
        deliveryState = "outlook_draft";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`graph draft failed for prospect ${c.id}: ${msg} — left in queue`);
        deliveryState = "pending";
      }
    } else if (opts.dryRun) {
      deliveryState = "dry_run";
    }

    const eventId = await logEvent(c.id, "outreach_draft", `engine draft → ${email}: ${draft.subject}`, {
      stage: "deliver",
      delivery: deliveryState,
      to: email,
      toName: c.fullName,
      subject: draft.subject,
      body,
      emailSourceUrl: research.email_source_url,
      emailKind: research.email_kind,
      hooks: research.personalization_hooks,
      graphMessageId: graph?.id ?? null,
      graphWebLink: graph?.webLink ?? null,
      model: MODEL,
    }, actor);

    if (!opts.dryRun) {
      await db.update(prospects).set({
        email,
        emailNormalized: email,
        emailStatus: "unverified",
        leadStatus: "qualified",
        tags: sql`array_append(coalesce(${prospects.tags}, '{}'), ${"engine:drafted"})`,
        updatedAt: new Date(),
      }).where(eq(prospects.id, c.id));
    }

    summary.drafted += 1;
    summary.drafts.push({ prospectId: c.id, name: c.fullName, email, subject: draft.subject, delivery: deliveryState, eventId });
  }

  if (summary.drafted < target && !summary.budgetExhausted && summary.examined >= candidates.length) summary.candidatesExhausted = true;
  summary.elapsedMs = Date.now() - started;
  return summary;
}
