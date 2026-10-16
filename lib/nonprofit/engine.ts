/**
 * Nonprofit outreach engine — the nightly "find N institutional nonprofit
 * leads for a principal, draft them a note, and put the Lead in VistaCRM"
 * pipeline. v0.29.0.
 *
 *   universe → IRS BMF (`nonprofits`, 1.7M orgs with asset bands) LEFT JOIN
 *              the 990 e-file family when loaded, filtered to the program's
 *              states/zips and investable-pool band, ranked by geography,
 *              then investment-management fees paid (990 Part IX 11f — the
 *              single best "already pays an outside manager" signal), then
 *              pool size. Orgs already in np_leads (either program) are out:
 *              Matt and Ryan never touch the same institution.
 *   people   → the 990 Part VII board/officer roster when loaded, cross-
 *              matched against Apollo people search — Apollo's results carry
 *              the LinkedIn-derived profile (headline, employment history,
 *              linkedin_url), which is exactly the data the affinity pass
 *              needs. No 990 yet → Apollo supplies the people outright
 *              (CFO/CIO/ED/Treasurer-class titles, c_suite seniorities).
 *   email    → apollo_person_enrich (1 credit when an email comes back).
 *              emailStatus is carried everywhere: 'verified' is deliverable,
 *              'guessed' is Apollo's pattern inference — flagged in the
 *              [FOR …] note and the CRM note so the partner verifies before
 *              sending. Nothing is ever pattern-guessed BY US and personal
 *              emails / phones are never revealed.
 *   research → one web-search-backed model call per candidate: shared-
 *              affinity hunt (program.affinities), identity check, concrete
 *              personalization hooks. Other board seats come free from the
 *              local 990 people index when loaded.
 *   draft    → persona-driven model call; banned-phrase check; CAN-SPAM
 *              footer; a plain-text "[FOR MATT: …]" / "[FOR RYAN: …]"
 *              bracket line at the very top (no boxes, no styled fonts —
 *              2026-10-16 decision), real availability dates computed from
 *              the principal's calendar horizon.
 *   deliver  → Outlook Drafts in the PRINCIPAL'S mailbox via Graph. Nothing
 *              is ever sent from here.
 *   crm      → once (and only once) the draft exists, the person is created
 *              in VistaCRM as a Lead, coordinator = the principal, with the
 *              full enrichment in `background` + a timeline note. 409
 *              duplicate → the note lands on the existing contact instead.
 *
 * Every step writes an np_events row.
 */

import { sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { apolloPeopleSearch, apolloPersonEnrich } from "../apollo/tools";
import { irs990BoardsOfPerson } from "../irs990/queries";
import { PROGRAMS, NonprofitProgram, personaFactsBlock, availabilityDates } from "./programs";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = process.env.NONPROFIT_ENGINE_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export const ENGINE_ACTOR = "nonprofit-engine";

// ── Types ──────────────────────────────────────────────────────────────────

export interface NpEngineOptions {
  program?: "matt" | "ryan";    // omit = both, sequentially
  target?: number;              // drafts per program; default 3
  maxCandidates?: number;       // orgs examined per program; default 12
  budgetMs?: number;            // wall clock for the whole invocation
  dryRun?: boolean;             // research + draft, but no Outlook draft, no CRM write, no lead burn
  actor?: string;
}

interface OrgCandidate {
  ein: string;
  name: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  ntee: string | null;
  bmfAssets: number | null;
  poolValue: number;
  poolSource: string;
  investMgmtFees: number | null;
  endowmentEoy: number | null;
  netAssetsEoy: number | null;
  totalRevenue: number | null;
  mission: string | null;
  website: string | null;
  objectId: string | null;      // latest 990 object_id, when loaded
  geoScore: number;
}

interface BoardPerson { name: string; title: string | null; isOfficer: boolean; isTrustee: boolean }

interface ApolloPick {
  apolloId: string | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  headline: string | null;
  linkedinUrl: string | null;
  employmentHistory: Array<{ organization: string | null; title: string | null; current: boolean | null }>;
  location: string | null;
}

interface ResearchOut {
  confidence: "high" | "medium" | "low";
  identity_match: string;
  summary: string;
  affinity: string | null;
  affinity_kind: "school" | "city" | "board" | "career" | null;
  personalization_hooks: string[];
  org_angle: string;
  sources: string[];
}

interface DraftOut { subject: string; body: string }

export interface NpProgramSummary {
  program: string;
  target: number;
  examined: number;
  drafted: number;
  skipped: { reason: string; ein: string; org: string; person?: string }[];
  drafts: { leadId: number; org: string; person: string; email: string; emailStatus: string | null; subject: string; delivery: string; crm: string }[];
  budgetExhausted: boolean;
  candidatesExhausted: boolean;
  warnings: string[];
}

export interface NpRunSummary {
  ok: boolean;
  has990: boolean;
  model: string;
  elapsedMs: number;
  programs: NpProgramSummary[];
}

// ── Anthropic (same minimal client as the prospect engine) ─────────────────

type ContentBlock = { type: string; text?: string; [k: string]: unknown };

async function anthropic(body: Record<string, unknown>, timeoutMs: number): Promise<ContentBlock[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not configured");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model: MODEL, ...body }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const json = (await res.json()) as { content?: ContentBlock[] };
    return json.content ?? [];
  } finally {
    clearTimeout(t);
  }
}

function finalText(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
}

function extractJson<T>(text: string): T {
  const m = text.match(/<result>([\s\S]*?)<\/result>/i);
  let raw = (m ? m[1] : text).trim();
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("model returned no JSON object");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

function rows<T = any>(r: any): T[] { return (r?.rows ?? r ?? []) as T[]; }
const usd = (n: number | null | undefined) => (n == null ? "n/a" : `$${Math.round(n / 1e6)}M`);

// ── Universe ───────────────────────────────────────────────────────────────

export async function has990Tables(): Promise<boolean> {
  try {
    const r = rows(await db.execute(sql`SELECT to_regclass('irs990_latest_filings') IS NOT NULL AS ok`));
    return !!r[0]?.ok;
  } catch { return false; }
}

/** Geo WHERE + CASE score from the program's geo rules. A state listed both
 *  with and without zip prefixes (IL for Matt) is admitted by the whole-state
 *  rule; the prefixed rule then only contributes ranking weight. */
function geoSql(p: NonprofitProgram) {
  const statesWithBare = new Set(p.geo.filter((g) => !g.zipPrefixes).map((g) => g.state));
  const restricted = p.geo.filter((g) => g.zipPrefixes && !statesWithBare.has(g.state));
  const whereClauses = [
    ...[...statesWithBare].map((s) => sql`n.state = ${s}`),
    ...restricted.map((g) => sql`(n.state = ${g.state} AND left(n.zip, 3) IN (${sql.join(g.zipPrefixes!.map((z) => sql`${z}`), sql`, `)}))`),
  ];
  const where = sql`(${sql.join(whereClauses, sql` OR `)})`;
  const scoreCases = p.geo
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((g) => g.zipPrefixes
      ? sql`WHEN n.state = ${g.state} AND left(n.zip, 3) IN (${sql.join(g.zipPrefixes.map((z) => sql`${z}`), sql`, `)}) THEN ${g.weight}`
      : sql`WHEN n.state = ${g.state} THEN ${g.weight}`);
  const cityBoost = p.boostCities.length
    ? sql` + CASE WHEN upper(coalesce(n.city,'')) IN (${sql.join(p.boostCities.map((c) => sql`${c}`), sql`, `)}) THEN 1 ELSE 0 END`
    : sql``;
  const score = sql`(CASE ${sql.join(scoreCases, sql` `)} ELSE 0 END${cityBoost})`;
  return { where, score };
}

export async function selectOrgs(p: NonprofitProgram, has990: boolean, limit: number): Promise<OrgCandidate[]> {
  const { where, score } = geoSql(p);
  const base990 = has990
    ? sql`LEFT JOIN irs990_latest_filings f ON f.ein = n.ein`
    : sql``;
  const pool = has990
    ? sql`GREATEST(
        COALESCE(f.endowment_eoy, 0),
        COALESCE(f.investments_public, 0) + COALESCE(f.investments_other, 0) + COALESCE(f.investments_program, 0),
        COALESCE(n.asset_amt, 0))`
    : sql`COALESCE(n.asset_amt, 0)`;
  const poolSource = has990
    ? sql`CASE
        WHEN COALESCE(f.endowment_eoy,0) >= GREATEST(COALESCE(f.investments_public,0)+COALESCE(f.investments_other,0)+COALESCE(f.investments_program,0), COALESCE(n.asset_amt,0)) AND COALESCE(f.endowment_eoy,0) > 0 THEN '990_endowment'
        WHEN COALESCE(f.investments_public,0)+COALESCE(f.investments_other,0)+COALESCE(f.investments_program,0) >= COALESCE(n.asset_amt,0)
             AND COALESCE(f.investments_public,0)+COALESCE(f.investments_other,0)+COALESCE(f.investments_program,0) > 0 THEN '990_investments'
        ELSE 'bmf_assets' END`
    : sql`'bmf_assets'`;
  const extra = has990
    ? sql`f.invest_mgmt_fees::float8 AS "investMgmtFees", f.endowment_eoy::float8 AS "endowmentEoy",
          f.net_assets_eoy::float8 AS "netAssetsEoy", f.total_revenue::float8 AS "totalRevenue",
          f.mission AS mission, f.website AS website, f.object_id AS "objectId",`
    : sql`NULL::float8 AS "investMgmtFees", NULL::float8 AS "endowmentEoy",
          NULL::float8 AS "netAssetsEoy", NULL::float8 AS "totalRevenue",
          NULL AS mission, NULL AS website, NULL AS "objectId",`;
  const orderFees = has990 ? sql`f.invest_mgmt_fees DESC NULLS LAST,` : sql``;
  const q = sql`
    SELECT n.ein, n.name, n.city, n.state, n.zip, n.ntee_code AS ntee,
           n.asset_amt::float8 AS "bmfAssets",
           ${pool}::float8 AS "poolValue",
           ${poolSource} AS "poolSource",
           ${extra}
           ${score} AS "geoScore"
    FROM nonprofits n
    ${base990}
    WHERE n.subsection = 3
      AND COALESCE(n.foundation, 0) <> 10                       -- churches out
      AND ${where}
      AND ${pool} BETWEEN ${p.minPool} AND ${p.maxPool}
      AND NOT EXISTS (SELECT 1 FROM np_leads l WHERE l.ein = n.ein)
    ORDER BY ${score} DESC, ${orderFees} ${pool} DESC
    LIMIT ${limit}`;
  return rows<OrgCandidate>(await db.execute(q)).map((r) => ({ ...r, poolValue: Number(r.poolValue) }));
}

// ── People ─────────────────────────────────────────────────────────────────

const TITLE_RANK: Array<[RegExp, number]> = [
  [/CHIEF FINANCIAL|CFO/i, 10], [/CHIEF INVESTMENT|CIO/i, 10], [/TREASURER/i, 9],
  [/EXECUTIVE DIR|CEO|CHIEF EXEC|PRESIDENT/i, 8], [/FINANCE/i, 7], [/CONTROLLER/i, 7],
  [/CHAIR/i, 6], [/VICE PRES/i, 5], [/TRUSTEE|DIRECTOR/i, 4],
];
function titleScore(t: string | null | undefined): number {
  if (!t) return 0;
  for (const [re, s] of TITLE_RANK) if (re.test(t)) return s;
  return 1;
}

async function board990(objectId: string): Promise<BoardPerson[]> {
  const people = rows(await db.execute(sql`
    SELECT p.name_raw AS name, p.title, p.is_officer AS "isOfficer",
           (p.is_individual_trustee OR p.is_institutional_trustee) AS "isTrustee"
    FROM irs990_persons p
    WHERE p.object_id = ${objectId}
      AND p.is_former = FALSE AND p.is_business = FALSE
      AND NOT (p.is_highest_comp AND NOT p.is_officer AND NOT p.is_key_employee
               AND NOT p.is_individual_trustee AND NOT p.is_institutional_trustee)
    ORDER BY p.seq`));
  return (people as BoardPerson[]).sort((a, b) => titleScore(b.title) - titleScore(a.title)).slice(0, 15);
}

const normName = (s: string) => s.toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
function sameName(a: string, b: string): boolean {
  const ta = normName(a).split(" "), tb = normName(b).split(" ");
  if (!ta.length || !tb.length) return false;
  return ta[ta.length - 1] === tb[tb.length - 1] && ta[0][0] === tb[0][0];
}

function shapePick(p: any): ApolloPick {
  return {
    apolloId: p?.apolloId ?? null,
    name: p?.name ?? [p?.firstName, p?.lastName].filter(Boolean).join(" "),
    firstName: p?.firstName ?? null,
    lastName: p?.lastName ?? null,
    title: p?.title ?? null,
    headline: p?.headline ?? null,
    linkedinUrl: p?.linkedinUrl ?? null,
    employmentHistory: (p?.employmentHistory ?? []).map((e: any) => ({ organization: e.organization, title: e.title, current: e.current })),
    location: p?.location ?? null,
  };
}

/** Pick the person for an org: board/officer from the 990 confirmed in Apollo
 *  when possible (LinkedIn-backed profile), otherwise Apollo's best finance /
 *  exec hit at the org. Returns the pick + their governance role. */
async function pickPerson(org: OrgCandidate, p: NonprofitProgram): Promise<{ pick: ApolloPick; role: string; title990: string | null } | null> {
  const board = org.objectId ? await board990(org.objectId) : [];
  const search = await apolloPeopleSearch({
    organizationNames: org.name,
    organizationLocations: org.city && org.state ? [`${org.city}, ${org.state}`] : org.state ? [org.state] : undefined,
    titles: p.titles,
    seniorities: ["c_suite", "owner", "founder", "partner", "vp", "head", "director"],
    perPage: 10,
  }).catch(() => ({ people: [] as any[] }));
  const apolloPeople: any[] = (search as any).people?.filter(Boolean) ?? [];

  // 1. Apollo hit that IS a current board/officer on the 990.
  for (const b of board) {
    const hit = apolloPeople.find((a) => a?.name && sameName(a.name, b.name));
    if (hit) return { pick: shapePick(hit), role: b.isTrustee && !b.isOfficer ? "board" : "officer", title990: b.title ?? null };
  }
  // 2. Best Apollo finance/exec person at the org (staff targets: CFO/CIO/ED).
  const ranked = apolloPeople.slice().sort((a, b) => titleScore(b?.title) - titleScore(a?.title));
  if (ranked[0] && titleScore(ranked[0].title) >= 4) return { pick: shapePick(ranked[0]), role: "staff", title990: null };
  // 3. Name-search Apollo for the top 990 board names (LinkedIn footprint).
  for (const b of board.slice(0, 3)) {
    const byName = await apolloPeopleSearch({ personName: b.name, organizationNames: org.name, perPage: 3 }).catch(() => ({ people: [] as any[] }));
    const hit = ((byName as any).people ?? []).find((a: any) => a?.name && sameName(a.name, b.name));
    if (hit) return { pick: shapePick(hit), role: b.isTrustee && !b.isOfficer ? "board" : "officer", title990: b.title ?? null };
  }
  if (ranked[0]) return { pick: shapePick(ranked[0]), role: "staff", title990: null };
  return null;
}

// ── Research ───────────────────────────────────────────────────────────────

async function planFacts(ein: string): Promise<string[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT plan_name, plan_year, tot_assets_eoy_amt::float8 AS assets, tot_active_partcp_cnt AS participants
      FROM plans WHERE spons_dfe_ein = ${ein} ORDER BY plan_year DESC, tot_assets_eoy_amt DESC NULLS LAST LIMIT 3`));
    return r.map((x: any) => `${x.plan_name ?? "Retirement plan"} (${x.plan_year}): ${usd(x.assets)} assets, ${x.participants ?? "n/a"} active participants`);
  } catch { return []; }
}

async function researchPerson(org: OrgCandidate, pick: ApolloPick, role: string, p: NonprofitProgram, extraSeats: string[], planLines: string[], timeoutMs: number): Promise<ResearchOut> {
  const system = `You are a research analyst for Vistamark Investments, a Hinsdale, Illinois institutional investment firm. A partner is about to write a first email to a nonprofit's ${role === "staff" ? "finance executive" : "board member / officer"}. Your job: verify identity and find GENUINE, citable personalization — especially any SHARED AFFINITY from this list:
${p.affinities.map((a) => `- ${a}`).join("\n")}

Hard rules:
- Use web search (at most 4 searches). Anchor identity on the person's connection to the ORGANIZATION; say plainly how confident you are.
- personalization_hooks must be concrete, verifiable, and appropriate in a first professional email: their role, career, other board seats, published work, civic recognition, alma mater. NEVER health, family, religion, politics, litigation, home, or anything creepy to have noticed.
- affinity: the single strongest shared-affinity fact you actually verified (e.g. "Northwestern Kellogg MBA", "20 years in Cleveland"), else null. Do not stretch.
- org_angle: ONE sentence a partner could say about the ORGANIZATION's investment program drawn from the facts given (pool size, endowment, fees paid to outside managers, retirement plan) — factual, not flattering.
- Do not invent anything about Vistamark.

Return one JSON object in <result></result>:
{"confidence":"high|medium|low","identity_match":"...","summary":"2-3 sentence professional bio","affinity":null,"affinity_kind":null,"personalization_hooks":[],"org_angle":"...","sources":[]}
affinity_kind is "school" | "city" | "board" | "career" | null.`;

  const user = `Organization: ${org.name} — ${org.city ?? ""}, ${org.state ?? ""} (EIN ${org.ein})
Investable pool: ${usd(org.poolValue)} (${org.poolSource})${org.endowmentEoy ? `; endowment ${usd(org.endowmentEoy)}` : ""}${org.investMgmtFees ? `; paid ${usd(org.investMgmtFees)} in investment-management fees (990 Part IX 11f)` : ""}
${planLines.length ? `Retirement plans (Form 5500):\n${planLines.map((l) => `- ${l}`).join("\n")}` : ""}
${org.mission ? `Mission: ${org.mission.slice(0, 300)}` : ""}

Person: ${pick.name}${pick.title ? ` — ${pick.title}` : ""}${role !== "staff" ? ` (listed on the organization's Form 990 Part VII)` : ""}
${pick.headline ? `LinkedIn headline: ${pick.headline}` : ""}
${pick.employmentHistory.length ? `Employment history (LinkedIn via Apollo):\n${pick.employmentHistory.slice(0, 5).map((e) => `- ${[e.title, e.organization].filter(Boolean).join(", ")}${e.current ? " (current)" : ""}`).join("\n")}` : ""}
${pick.location ? `Location: ${pick.location}` : ""}
${extraSeats.length ? `Other nonprofit board seats on file (IRS 990 index):\n${extraSeats.map((s) => `- ${s}`).join("\n")}` : ""}

Verify and research this person, following the rules exactly.`;

  const blocks = await anthropic({
    max_tokens: 1600,
    system,
    messages: [{ role: "user", content: user }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
  }, timeoutMs);
  const r = extractJson<ResearchOut>(finalText(blocks));
  r.personalization_hooks = Array.isArray(r.personalization_hooks) ? r.personalization_hooks.filter((x) => typeof x === "string").slice(0, 6) : [];
  r.sources = Array.isArray(r.sources) ? r.sources.filter((x) => typeof x === "string").slice(0, 8) : [];
  if (!["high", "medium", "low"].includes(r.confidence)) r.confidence = "low";
  if (typeof r.org_angle !== "string") r.org_angle = "";
  if (typeof r.affinity !== "string") r.affinity = null;
  return r;
}

// ── Draft ──────────────────────────────────────────────────────────────────

async function draftEmail(org: OrgCandidate, pick: ApolloPick, role: string, r: ResearchOut, p: NonprofitProgram, timeoutMs: number): Promise<DraftOut> {
  const [d1, d2] = availabilityDates();
  const roleLine = role === "staff"
    ? "The reader runs the organization's finances day to day: the cost, reporting, and staff-time angle matters most. Frame Vistamark as an extension of their team, never a threat to it."
    : "The reader is a fiduciary (board/trustee/officer): governance support, manager oversight, and making the investment-committee meeting better matter most.";
  const system = `You write short, specific first emails from ${p.persona.senderName}, ${p.persona.senderTitle} of ${p.persona.firm}, to leaders of mid-sized nonprofit institutions. The sender is an institutional investor with decades of experience, not a salesperson.

About the sender — you may use these facts and ONLY these facts about the sender or the firm:
${personaFactsBlock(p)}

Thesis to orbit (do not quote it): ${p.persona.thesis}
${roleLine}

Rules:
- 110 to 180 words in the body. Plain text. No bullet points, no bold.
- Open with something specific about the RECIPIENT — at most ONE personal hook (the shared affinity when provided, else their role/career). One or two sentences; a person noticed, not a mail merge.
- Then ONE sentence about the ORGANIZATION drawn from the org angle provided — specific to them. Never quote their own fee or dollar figures back at them; size the problem, don't recite their filing.
- Then at most TWO sender facts, chosen to connect to the recipient. Weave them in; do not list.
- Close by requesting a brief phone call and offer exactly these two slots: ${d1} or ${d2}, with a line that you'll work around their (or the committee's) calendar.
- No performance claims, no promises, no return numbers. The $260 billion figure describes assets the prior firm oversaw and must be framed that way if used.
- Never use any of these words or phrases: ${p.persona.banned.join("; ")}.
- Sign off with the sender's first name only. No footer; it is appended separately.
- Subject line: 3–8 words, specific, no exclamation marks.

Return one JSON object in <result></result>: {"subject":"...","body":"..."}`;

  const user = `Recipient: ${pick.name} (first name: ${pick.firstName ?? "unknown — neutral greeting"}), ${pick.title ?? role}, ${org.name} (${org.city ?? ""}, ${org.state ?? ""})
Shared affinity (use it to open if present): ${r.affinity ?? "none"}
Hooks you may use:
${(r.personalization_hooks.length ? r.personalization_hooks : [r.summary]).map((h) => `- ${h}`).join("\n")}
Org angle: ${r.org_angle || `${org.name} oversees roughly ${usd(org.poolValue)} in investable assets.`}

Write the email.`;

  const blocks = await anthropic({ max_tokens: 900, system, messages: [{ role: "user", content: user }] }, timeoutMs);
  const d = extractJson<DraftOut>(finalText(blocks));
  if (typeof d.subject !== "string" || typeof d.body !== "string") throw new Error("draft missing subject/body");
  d.subject = d.subject.trim().replace(/\s+/g, " ").slice(0, 120);
  d.body = d.body.trim();
  const lower = `${d.body.toLowerCase()} ${d.subject.toLowerCase()}`;
  const hit = p.persona.banned.find((b) => lower.includes(b.toLowerCase()));
  if (hit) throw new Error(`draft used banned phrase: "${hit}"`);
  const words = d.body.split(/\s+/).length;
  if (words < 80 || words > 230) throw new Error(`draft length out of range (${words} words)`);
  return d;
}

function forNote(p: NonprofitProgram, org: OrgCandidate, pick: ApolloPick, role: string, r: ResearchOut, emailStatus: string | null): string {
  const bits = [
    `${org.name} (${org.city ?? ""}, ${org.state ?? ""}) — pool ${usd(org.poolValue)}`,
    `${pick.name}${pick.title ? `, ${pick.title}` : ""} (${role})`,
    r.affinity ? `affinity: ${r.affinity}` : null,
    org.investMgmtFees ? `pays outside mgrs (${usd(org.investMgmtFees)}/yr)` : null,
    `email ${emailStatus ?? "unknown"} via Apollo${emailStatus === "guessed" ? " — VERIFY BEFORE SENDING" : ""}`,
  ].filter(Boolean);
  // Plain text, body style, [brackets] only — no boxes, no colored or sized
  // fonts (2026-10-16 decision after the red box could not be deleted in Outlook).
  return `[FOR ${p.draftNoteName}: ${bits.join(" · ")}]`;
}

function finalBody(p: NonprofitProgram, note: string, d: DraftOut): string {
  return `${note}\n\n${d.body}\n\n${p.persona.senderName}\n${p.persona.senderTitle}, ${p.persona.firm}\n${p.persona.officeShort}\n\n—\n${p.persona.footer}`;
}

// ── Delivery: Graph draft into the PRINCIPAL'S mailbox ─────────────────────

function graphConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TENANT_ID && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET);
}

async function graphToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID!,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET!,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) throw new Error(`graph token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function createDraft(mailbox: string, to: string, toName: string, subject: string, body: string): Promise<{ id: string; webLink: string | null }> {
  const token = await graphToken();
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

// ── VistaCRM ───────────────────────────────────────────────────────────────

function crmConfigured(): boolean { return !!process.env.VISTACRM_BRIDGE_SECRET; }
const CRM_BASE = (process.env.VISTACRM_URL || "https://vistacrm.app").replace(/\/$/, "");

async function crmFetch(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${CRM_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.VISTACRM_BRIDGE_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Create the Lead (or land on the existing duplicate) and attach the
 *  enrichment note. Returns the crm_id or throws. */
async function crmCreateLead(p: NonprofitProgram, leadId: number, org: OrgCandidate, pick: ApolloPick, role: string, r: ResearchOut, email: string, emailStatus: string | null, d: DraftOut, planLines: string[]): Promise<{ crmId: string; created: boolean }> {
  const background = [
    `Nonprofit outreach lead (${p.principalName} program, VistaIntel nonprofit-engine).`,
    `Org: ${org.name}, ${org.city ?? ""} ${org.state ?? ""} — EIN ${org.ein}. Investable pool ${usd(org.poolValue)} (${org.poolSource}).`,
    org.investMgmtFees ? `Pays ${usd(org.investMgmtFees)}/yr in outside investment-management fees (990 Part IX 11f).` : null,
    `Role: ${pick.title ?? role} (${role}).`,
    r.affinity ? `Shared affinity: ${r.affinity}.` : null,
    r.summary,
  ].filter(Boolean).join(" ");
  const contact = {
    first_name: pick.firstName ?? pick.name.split(" ")[0],
    last_name: pick.lastName ?? (pick.name.split(" ").slice(1).join(" ") || null),
    roles: ["lead"],
    coordinator: p.principalEmail,
    source: "vistaintel:nonprofit-outreach",
    company_name: org.name,
    job_title: pick.title ?? (role === "staff" ? null : role),
    background: background.slice(0, 4000),
    tags: p.crmTags,
    emails: [{ address: email, kind: "work", is_primary: true }],
    addresses: org.city || org.state ? [{ city: org.city, state: org.state, postal: org.zip, kind: "work", is_primary: true }] : [],
    intel_ref: `vistaintel:npl:${leadId}`,
  };
  let res = await crmFetch("/api/contacts", { contact });
  let crmId: string | null = null;
  let created = false;
  if (res.status === 409 && Array.isArray(res.json?.duplicates) && res.json.duplicates.length) {
    crmId = res.json.duplicates[0].crm_id;
  } else if (res.json?.ok && res.json?.crm_id) {
    crmId = res.json.crm_id;
    created = true;
  } else {
    throw new Error(`crm create ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);
  }

  const note = [
    `Nonprofit outreach — ${p.principalName} program (draft created, awaiting review in ${p.mailbox} Drafts).`,
    ``,
    `Organization: ${org.name} (EIN ${org.ein}), ${org.city ?? ""}, ${org.state ?? ""} ${org.zip ?? ""}`,
    `Investable pool: ${usd(org.poolValue)} (${org.poolSource})${org.endowmentEoy ? `; endowment ${usd(org.endowmentEoy)}` : ""}${org.netAssetsEoy ? `; net assets ${usd(org.netAssetsEoy)}` : ""}`,
    org.investMgmtFees ? `Investment-mgmt fees paid (990 Part IX 11f): ${usd(org.investMgmtFees)}/yr` : null,
    planLines.length ? `Retirement plans (Form 5500):\n${planLines.map((l) => `  - ${l}`).join("\n")}` : null,
    ``,
    `Person: ${pick.name} — ${pick.title ?? role} (${role})`,
    pick.linkedinUrl ? `LinkedIn: ${pick.linkedinUrl}` : null,
    pick.headline ? `Headline: ${pick.headline}` : null,
    `Email: ${email} (Apollo ${emailStatus ?? "unknown"}${emailStatus === "guessed" ? " — verify before sending" : ""})`,
    r.affinity ? `Shared affinity: ${r.affinity} (${r.affinity_kind ?? ""})` : `Shared affinity: none found`,
    ``,
    `Research (${r.confidence} confidence): ${r.summary}`,
    r.personalization_hooks.length ? `Hooks:\n${r.personalization_hooks.map((h) => `  - ${h}`).join("\n")}` : null,
    r.sources.length ? `Sources:\n${r.sources.map((s) => `  - ${s}`).join("\n")}` : null,
    ``,
    `Draft subject: ${d.subject}`,
  ].filter((x) => x !== null).join("\n");
  const noteRes = await crmFetch(`/api/contacts/${crmId}/notes`, { body: note, author_email: "rstephens@vistamarkllc.com" });
  if (noteRes.status !== 200) throw new Error(`crm note ${noteRes.status}: ${JSON.stringify(noteRes.json).slice(0, 200)}`);
  return { crmId: crmId!, created };
}

// ── Persistence ────────────────────────────────────────────────────────────

async function insertLead(p: NonprofitProgram, org: OrgCandidate): Promise<number | null> {
  const r = rows(await db.execute(sql`
    INSERT INTO np_leads (program, ein, org_name, org_city, org_state, org_zip, ntee_code,
                          org_assets, pool_value, pool_source, invest_mgmt_fees, has_990, status)
    VALUES (${p.key}, ${org.ein}, ${org.name}, ${org.city}, ${org.state}, ${org.zip}, ${org.ntee},
            ${org.bmfAssets}, ${org.poolValue}, ${org.poolSource}, ${org.investMgmtFees}, ${!!org.objectId}, 'selected')
    ON CONFLICT (ein) DO NOTHING
    RETURNING id`));
  return r[0]?.id ?? null;
}

async function updateLead(id: number, fields: Record<string, unknown>): Promise<void> {
  const sets: any[] = [sql`updated_at = NOW()`];
  const map: Record<string, any> = {
    status: sql`status`, person_name: sql`person_name`, first_name: sql`first_name`, last_name: sql`last_name`,
    person_title: sql`person_title`, person_role: sql`person_role`, apollo_id: sql`apollo_id`,
    linkedin_url: sql`linkedin_url`, headline: sql`headline`, email: sql`email`, email_status: sql`email_status`,
    affinity: sql`affinity`, crm_contact_id: sql`crm_contact_id`, draft_subject: sql`draft_subject`,
    graph_message_id: sql`graph_message_id`, research: sql`research`,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in map)) continue;
    sets.push(k === "research" ? sql`${map[k]} = ${JSON.stringify(v)}::jsonb` : sql`${map[k]} = ${v as any}`);
  }
  await db.execute(sql`UPDATE np_leads SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
}

async function logEvent(leadId: number | null, kind: string, detail: string, meta: Record<string, unknown>, actor: string): Promise<number> {
  const r = rows(await db.execute(sql`
    INSERT INTO np_events (lead_id, kind, detail, meta, actor)
    VALUES (${leadId}, ${kind}, ${detail.slice(0, 2000)}, ${JSON.stringify(meta)}::jsonb, ${actor})
    RETURNING id`));
  return r[0]?.id ?? 0;
}

// ── Orchestration ──────────────────────────────────────────────────────────

const ACCEPT_GUESSED = process.env.NONPROFIT_ACCEPT_GUESSED !== "0"; // default on; status is flagged everywhere

async function runProgram(p: NonprofitProgram, has990: boolean, opts: Required<Pick<NpEngineOptions, "target" | "maxCandidates" | "dryRun">> & { actor: string; deadline: number }): Promise<NpProgramSummary> {
  const s: NpProgramSummary = {
    program: p.key, target: opts.target, examined: 0, drafted: 0,
    skipped: [], drafts: [], budgetExhausted: false, candidatesExhausted: false, warnings: [],
  };
  if (!graphConfigured()) s.warnings.push("MS_GRAPH_* not set — Outlook drafts cannot be created");
  if (!crmConfigured()) s.warnings.push("VISTACRM_BRIDGE_SECRET not set — CRM lead creation queued as np_events kind crm_pending; copy the secret from the vistarandall Vercel project");

  const candidates = await selectOrgs(p, has990, opts.maxCandidates);
  if (!candidates.length) {
    s.candidatesExhausted = true;
    s.warnings.push(`no untouched orgs match the ${p.key} band/geo — widen the band in lib/nonprofit/programs.ts or clear np_leads rows`);
    return s;
  }
  const remaining = () => opts.deadline - Date.now();

  for (const org of candidates) {
    if (s.drafted >= opts.target) break;
    if (remaining() < 85_000) { s.budgetExhausted = true; break; }
    s.examined += 1;

    const leadId = opts.dryRun ? null : await insertLead(p, org);
    if (!opts.dryRun && leadId == null) { s.skipped.push({ reason: "ein_already_claimed", ein: org.ein, org: org.name }); continue; }
    const lid = leadId ?? 0;

    const fail = async (reason: string, person?: string, meta: Record<string, unknown> = {}) => {
      s.skipped.push({ reason, ein: org.ein, org: org.name, person });
      if (!opts.dryRun && leadId != null) {
        await updateLead(leadId, { status: `skipped:${reason}` });
        await logEvent(leadId, "gate", `skipped: ${reason}`, meta, opts.actor);
      }
    };

    // people
    let chosen: Awaited<ReturnType<typeof pickPerson>>;
    try { chosen = await pickPerson(org, p); } catch (err) {
      await fail("people_search_error", undefined, { error: String(err) }); continue;
    }
    if (!chosen) { await fail("no_person_found"); continue; }
    const { pick, role, title990 } = chosen;
    if (!opts.dryRun && leadId != null) {
      await updateLead(leadId, {
        status: "researching", person_name: pick.name, first_name: pick.firstName, last_name: pick.lastName,
        person_title: pick.title ?? title990, person_role: role, apollo_id: pick.apolloId,
        linkedin_url: pick.linkedinUrl, headline: pick.headline,
      });
      await logEvent(leadId, "select", `person: ${pick.name} (${pick.title ?? title990 ?? role})`, { role, apolloId: pick.apolloId, linkedin: pick.linkedinUrl }, opts.actor);
    }

    // email reveal (the credit spend)
    let email: string | null = null;
    let emailStatus: string | null = null;
    try {
      const enr = pick.apolloId
        ? await apolloPersonEnrich({ apolloId: pick.apolloId })
        : await apolloPersonEnrich({ name: pick.name, organizationName: org.name });
      const person: any = (enr as any).person;
      email = person?.email ?? null;
      emailStatus = person?.emailStatus ?? null;
      if (person) {
        pick.linkedinUrl = pick.linkedinUrl ?? person.linkedinUrl ?? null;
        pick.headline = pick.headline ?? person.headline ?? null;
        pick.firstName = pick.firstName ?? person.firstName ?? null;
        pick.lastName = pick.lastName ?? person.lastName ?? null;
        if (Array.isArray(person.employmentHistory) && person.employmentHistory.length) {
          pick.employmentHistory = person.employmentHistory.map((e: any) => ({ organization: e.organization, title: e.title, current: e.current }));
        }
      }
    } catch (err) { await fail("apollo_enrich_error", pick.name, { error: String(err) }); continue; }
    if (!email) { await fail("no_apollo_email", pick.name); continue; }
    if (emailStatus === "guessed" && !ACCEPT_GUESSED) { await fail("apollo_email_guessed", pick.name); continue; }
    if (!opts.dryRun && leadId != null) await updateLead(leadId, { email, email_status: emailStatus });

    // local 990 cross-boards (free)
    let extraSeats: string[] = [];
    if (has990) {
      try {
        const seats: any = await irs990BoardsOfPerson({ name: pick.name, limit: 6 });
        extraSeats = (seats?.seats ?? [])
          .filter((x: any) => x.ein !== org.ein && x.nameNorm && x.score >= 0.9)
          .slice(0, 4)
          .map((x: any) => `${x.title ?? "Board"} — ${x.orgName} (${x.orgCity ?? ""}, ${x.orgState ?? ""})`);
      } catch { /* non-fatal */ }
    }

    // research
    const planLines = await planFacts(org.ein);
    let research: ResearchOut;
    try {
      research = await researchPerson(org, pick, role, p, extraSeats, planLines, Math.min(70_000, Math.max(30_000, remaining() - 50_000)));
    } catch (err) { await fail("research_error", pick.name, { error: String(err) }); continue; }
    if (!opts.dryRun && leadId != null) {
      await updateLead(leadId, { affinity: research.affinity, research });
      await logEvent(leadId, "research", `(${research.confidence}) ${research.summary}`.slice(0, 1800), { research, extraSeats, planLines }, opts.actor);
    }
    if (research.confidence === "low") { await fail("identity_low_confidence", pick.name); continue; }

    // draft
    let d: DraftOut;
    try { d = await draftEmail(org, pick, role, research, p, 45_000); } catch (err) {
      await fail("draft_error", pick.name, { error: String(err) }); continue;
    }
    const note = forNote(p, org, pick, role, research, emailStatus);
    const body = finalBody(p, note, d);

    let delivery = "pending";
    let graph: { id: string; webLink: string | null } | null = null;
    if (opts.dryRun) delivery = "dry_run";
    else if (graphConfigured()) {
      try { graph = await createDraft(p.mailbox, email, pick.name, d.subject, body); delivery = "outlook_draft"; }
      catch (err) { s.warnings.push(`graph draft failed for ${pick.name} (${p.mailbox}): ${String(err).slice(0, 180)} — queued`); }
    }
    if (!opts.dryRun && leadId != null) {
      await logEvent(leadId, "deliver", `draft → ${email}: ${d.subject}`, {
        delivery, to: email, toName: pick.name, mailbox: p.mailbox, subject: d.subject, body,
        emailStatus, graphMessageId: graph?.id ?? null, graphWebLink: graph?.webLink ?? null, model: MODEL,
      }, opts.actor);
      await updateLead(leadId, { status: "drafted", draft_subject: d.subject, graph_message_id: graph?.id ?? null });
    }

    // crm — only after the draft exists (program rule)
    let crmState = "skipped";
    if (!opts.dryRun) {
      if (crmConfigured()) {
        try {
          const { crmId, created } = await crmCreateLead(p, lid, org, pick, role, research, email, emailStatus, d, planLines);
          crmState = created ? `created:${crmId}` : `linked_existing:${crmId}`;
          if (leadId != null) {
            await updateLead(leadId, { crm_contact_id: crmId });
            await logEvent(leadId, "crm", `lead ${created ? "created" : "linked to existing"} ${crmId}, coordinator ${p.principalEmail}`, { crmId, created }, opts.actor);
          }
        } catch (err) {
          crmState = "error";
          s.warnings.push(`crm failed for ${pick.name}: ${String(err).slice(0, 180)}`);
          if (leadId != null) await logEvent(leadId, "crm", `crm error: ${String(err).slice(0, 300)}`, { error: String(err) }, opts.actor);
        }
      } else {
        crmState = "pending_secret";
        if (leadId != null) await logEvent(leadId, "crm_pending", "VISTACRM_BRIDGE_SECRET not set — lead not yet in VistaCRM", {}, opts.actor);
      }
    } else crmState = "dry_run";

    s.drafted += 1;
    s.drafts.push({ leadId: lid, org: org.name, person: pick.name, email, emailStatus, subject: d.subject, delivery, crm: crmState });
  }

  if (s.drafted < opts.target && !s.budgetExhausted && s.examined >= candidates.length) s.candidatesExhausted = true;
  return s;
}

export async function runNonprofitEngine(opts: NpEngineOptions = {}): Promise<NpRunSummary> {
  const started = Date.now();
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const target = Math.max(1, Math.min(opts.target ?? 3, 10));
  const maxCandidates = Math.max(target, Math.min(opts.maxCandidates ?? 12, 40));
  const budgetMs = Math.max(60_000, Math.min(opts.budgetMs ?? 280_000, 780_000));
  const actor = opts.actor ?? ENGINE_ACTOR;
  const deadline = started + budgetMs;
  const has990 = await has990Tables();

  const keys: Array<"matt" | "ryan"> = opts.program ? [opts.program] : ["matt", "ryan"];
  const programs: NpProgramSummary[] = [];
  for (const k of keys) {
    programs.push(await runProgram(PROGRAMS[k], has990, { target, maxCandidates, dryRun: !!opts.dryRun, actor, deadline }));
  }
  return { ok: true, has990, model: MODEL, elapsedMs: Date.now() - started, programs };
}
