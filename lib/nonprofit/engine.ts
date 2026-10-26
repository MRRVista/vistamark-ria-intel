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
 *              footer; real availability dates computed from the
 *              principal's calendar horizon. v0.31.0 (2026-10-24): the
 *              "[FOR MATT: …]" briefing is no longer in the body -- it is an
 *              internal note on the draft via VistaRandall (postInternalNote),
 *              visible in the Outlook add-in, never to the recipient.
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
import { PROGRAMS, NonprofitProgram, personaFactsBlock } from "./programs";
import { loadEffectivePrograms } from "./remote-config"; // v0.30.0: live settings = the VistaRandall directive cards
import { nonprofitDraftCategories } from "./draft-categories"; // v0.34.1: Outlook categories on every draft
import { normalizeDirectOpening } from "../outreach/opening"; // v0.37.0: "Name," then straight into the reason
import { dashRule, stripDashes, hasForbiddenDash } from "../outreach/dashes"; // v0.37.0: no em/en dashes, no "--"

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

export interface OrgCandidate {
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

export interface ApolloPick {
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

export interface ResearchOut {
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
  skipped: { reason: string; ein: string; org: string; person?: string; error?: string }[];
  drafts: { leadId: number; org: string; person: string; email: string; emailStatus: string | null; subject: string; delivery: string; crm: string }[];
  budgetExhausted: boolean;
  candidatesExhausted: boolean;
  warnings: string[];
  paused?: boolean;                 // v0.30.0: paused on its VistaRandall card; not run
  directiveDnum?: number | null;    // v0.30.0: the card that governs it
}

export interface NpRunSummary {
  ok: boolean;
  has990: boolean;
  model: string;
  elapsedMs: number;
  programs: NpProgramSummary[];
  error?: string;                                       // v0.30.0: why the run did not happen
  config?: { source: string; fetchedAt: string } | null; // v0.30.0: where the settings came from
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

Your FINAL message must be exactly one JSON object inside <result></result> tags and nothing else — no prose before or after:
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

  const first = await anthropic({
    max_tokens: 3000,
    system,
    messages: [{ role: "user", content: user }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
  }, timeoutMs);
  let r: ResearchOut;
  try {
    r = extractJson<ResearchOut>(finalText(first));
  } catch {
    // Long web-search turns sometimes end before the JSON envelope. One
    // tool-free nudge finishes the job from what was already found.
    const retry = await anthropic({
      max_tokens: 1500,
      system,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: finalText(first).slice(-3000) || "(research notes gathered)" },
        { role: "user", content: "Return ONLY the <result></result> JSON object now, based on what you found. No other text." },
      ],
    }, Math.min(45_000, timeoutMs));
    r = extractJson<ResearchOut>(finalText(retry));
  }
  r.personalization_hooks = Array.isArray(r.personalization_hooks) ? r.personalization_hooks.filter((x) => typeof x === "string").slice(0, 6) : [];
  r.sources = Array.isArray(r.sources) ? r.sources.filter((x) => typeof x === "string").slice(0, 8) : [];
  if (!["high", "medium", "low"].includes(r.confidence)) r.confidence = "low";
  if (typeof r.org_angle !== "string") r.org_angle = "";
  if (typeof r.affinity !== "string") r.affinity = null;
  return r;
}

// ── Draft ──────────────────────────────────────────────────────────────────

/** v0.37.0 (2026-10-26, M. Rice + R. Walter): shorter, two paragraphs, get
 *  to the ask sooner, no em dashes.
 *    "Name,"
 *    P1 (personal): straight into why we're writing to THIS person/org.
 *    P2 (the chase): what Vistamark does and what the sender brings, then the
 *        fixed ask (NP_ASK).
 *    "Best," / sender's first name.
 *  The model returns the two paragraphs; the greeting, the ask and the
 *  sign-off are assembled here so they can't drift. One repair round when a
 *  check fails; a draft that still fails is skipped (draft_error). */
export const NP_ASK = "Would you be open to a coffee or a 20-minute call in the next few weeks?";
const NP_CAREER_IN_P2 = /\b(?:your (?:career|background|experience|tenure|résumé|resume|time at|work at|years at|role as|leadership at)|you(?:'|\u2019)ve (?:spent|led|built|served|worked|held|overseen)|you have (?:spent|led|built|served|worked|held|overseen))\b/i;
const NP_PLEASANTRY = /^(?:i\s+)?(?:hope|trust)\b|^i wanted to\b|^my name is\b|^allow me\b|^let me introduce\b/i;

function senderFirstName(p: NonprofitProgram): string {
  return p.persona.senderName.split(/[\s,]+/)[0] || p.persona.senderName;
}

function npWords(t: string): number { return t.split(/\s+/).filter(Boolean).length; }

export function assembleNpBody(firstName: string | null | undefined, p1: string, p2: string, p: NonprofitProgram): string {
  const clean = (t: string) => stripDashes(t.replace(/\s*\n+\s*/g, " ").trim());
  let a = clean(p1).replace(/^(?:hi|hello|hey|dear)\b[^,]*,\s*/i, "");
  let b = clean(p2);
  // The ask is fixed: drop any question/ask the model wrote at the end of P2, then add ours.
  b = b.replace(/\s*(?:[^.!?]*\b(?:coffee|call|chat|conversation|meet|connect)\b[^.!?]*\?)\s*$/i, "").trim();
  if (b && !/[.!?]$/.test(b)) b += ".";
  b = b ? `${b} ${NP_ASK}` : NP_ASK;
  return normalizeDirectOpening(`${a}\n\n${b}\n\nBest,\n${senderFirstName(p)}`, firstName);
}

export function checkNpDraft(subject: string, body: string, p: NonprofitProgram): string[] {
  const problems: string[] = [];
  const paras = body.split(/\n\s*\n/);
  const p1 = paras[1] ?? "";
  const p2 = paras[2] ?? "";
  const words = npWords(p1) + npWords(p2);
  if (hasForbiddenDash(subject) || hasForbiddenDash(body)) problems.push("contains an em dash, en dash or \"--\"");
  const lower = `${body.toLowerCase()} ${subject.toLowerCase()}`;
  const hit = p.persona.banned.find((b) => lower.includes(b.toLowerCase()));
  if (hit) problems.push(`uses the banned phrase "${hit}"`);
  if (NP_PLEASANTRY.test(p1.trim())) problems.push("paragraph 1 opens with a pleasantry or introduction instead of the reason for writing");
  if (NP_CAREER_IN_P2.test(p2)) problems.push("paragraph 2 talks about the recipient's career or background; paragraph 2 is only about Vistamark and the sender");
  if (words < 45) problems.push(`too short (${words} words; aim for 60 to 90)`);
  if (words > 105) problems.push(`too long (${words} words; aim for 60 to 90)`);
  if (npWords(subject) > 7) problems.push("subject line longer than 6 words");
  return problems;
}

export async function draftEmail(org: OrgCandidate, pick: ApolloPick, role: string, r: ResearchOut, p: NonprofitProgram, timeoutMs: number): Promise<DraftOut> {
  const roleLine = role === "staff"
    ? "The reader runs the organization's finances day to day: cost, reporting and staff time matter most. Vistamark is an extension of their team, never a threat to it."
    : "The reader is a fiduciary (board/trustee/officer): governance support, manager oversight and better investment-committee meetings matter most.";
  const system = `You write very short first emails from ${p.persona.senderName}, ${p.persona.senderTitle} of ${p.persona.firm}, to leaders of mid-sized nonprofit institutions. Plain, direct, peer to peer. Not a salesperson.

About the sender and the firm. Use these facts and ONLY these facts about the sender, Vistamark or anyone at Vistamark:
${personaFactsBlock(p)}

Thesis to orbit (do not quote it): ${p.persona.thesis}
${roleLine}

You write exactly TWO paragraphs. The greeting, the closing question and the sign-off are added for you; do not write them.

Paragraph 1 (personal, 1 to 2 sentences, about 25 to 40 words):
- Begin immediately with the specific reason you are writing to THIS person at THIS organization (e.g. "I'm reaching out because ..."). No pleasantries, no "hope all is well", no self-introduction.
- Build it from the shared affinity when one is provided, otherwise from something specific about the organization: its mission, the org angle provided, a local tie, recent news.
- An affinity is the RECIPIENT's tie. Call it shared ("fellow ...", "as a fellow alum") only when the sender's side of it is stated in the facts above, and then only at the level stated (e.g. "Northwestern", never a school, program or degree within it that the facts don't name). Otherwise mention the recipient's tie without claiming one for the sender.
- Do NOT recap the recipient's career or résumé.
- Never quote their own fee or dollar figures back at them.

Paragraph 2 (cut to the chase, 1 to 2 sentences, about 25 to 40 words):
- What Vistamark does and what the sender brings, using at most TWO of the facts above.
- Nothing about the recipient's career, background or experience. Paragraph 2 is only about Vistamark and the sender.
- Do not end with a question or an ask; the ask is appended for you.

Rules:
- About 60 to 90 words across both paragraphs. Plain text. No bullet points, no bold.
${dashRule()}
- No performance claims, no promises, no return numbers. The $260 billion figure describes assets the prior firm oversaw and must be framed that way if used.
- Never use any of these words or phrases: ${p.persona.banned.join("; ")}.
- Subject line: 3 to 6 words, specific, no exclamation marks.

Return one JSON object in <result></result>: {"subject":"...","p1":"...","p2":"..."}`;

  const user = `Recipient: ${pick.name} (first name: ${pick.firstName ?? "unknown"}), ${pick.title ?? role}, ${org.name} (${org.city ?? ""}, ${org.state ?? ""})
Shared affinity (lead paragraph 1 with it if present): ${r.affinity ?? "none"}
Hooks you may draw on for paragraph 1 (not a career recap):
${(r.personalization_hooks.length ? r.personalization_hooks : [r.summary]).map((h) => `- ${h}`).join("\n")}
Org angle: ${r.org_angle || `${org.name} oversees roughly ${usd(org.poolValue)} in investable assets.`}

Write the two paragraphs.`;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: user }];
  let last: { subject: string; body: string; problems: string[] } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const blocks = await anthropic({ max_tokens: 700, system, messages }, timeoutMs);
    const raw = finalText(blocks);
    const j = extractJson<{ subject?: unknown; p1?: unknown; p2?: unknown }>(raw);
    if (typeof j.subject !== "string" || typeof j.p1 !== "string" || typeof j.p2 !== "string") throw new Error("draft missing subject/p1/p2");
    const subject = stripDashes(j.subject.trim().replace(/\s+/g, " ")).replace(/[.!]+$/, "").slice(0, 120);
    const body = assembleNpBody(pick.firstName, j.p1, j.p2, p);
    const problems = checkNpDraft(subject, body, p);
    last = { subject, body, problems };
    if (!problems.length) return { subject, body };
    messages.push({ role: "assistant", content: raw.slice(-4000) });
    messages.push({ role: "user", content: `Fix these problems and return the corrected JSON only: ${problems.join("; ")}.` });
  }
  // Length alone is not worth losing a lead over (Matt: volume over perfection).
  const hard = last!.problems.filter((x) => !/^too (?:short|long)|^subject line longer/.test(x));
  if (hard.length) throw new Error(`draft failed checks: ${hard.join("; ")}`);
  return { subject: last!.subject, body: last!.body };
}

/** v0.31.0 (2026-10-24, Matt: "If this is sent, Susie will see note
 *  right?"): the briefing is NO LONGER in the body. It is an internal note
 *  on the draft, written through VistaRandall (POST /api/internal/email-notes,
 *  lib/email-notes there): shown in the Outlook add-in's Internal notes pane
 *  as "Randall", stamped on the partner's own copy, logged to VistaCRM when
 *  the email goes out, and never part of what the recipient receives. */
function forNote(_p: NonprofitProgram, org: OrgCandidate, pick: ApolloPick, role: string, r: ResearchOut, emailStatus: string | null): string {
  return [
    `${org.name} (${org.city ?? ""}, ${org.state ?? ""}) — pool ${usd(org.poolValue)}`,
    `${pick.name}${pick.title ? `, ${pick.title}` : ""} (${role})`,
    r.affinity ? `Affinity: ${r.affinity}` : null,
    org.investMgmtFees ? `Pays outside managers (${usd(org.investMgmtFees)}/yr)` : null,
    `Email ${emailStatus ?? "unknown"} via Apollo${emailStatus === "guessed" ? " — VERIFY BEFORE SENDING" : ""}`,
  ].filter(Boolean).join("\n");
}

/** The drafted body, nothing else. The draft already signs off with the
 *  sender's first name; the full signature comes from Sigsync at send time,
 *  so no signature block or footer is appended here (M. Rice, 2026-10-16).
 *  stripLegacySig removes the block from drafts produced before that change;
 *  the pre-v0.31.0 "[FOR X: …]" line is no longer produced at all. */
function finalBody(_p: NonprofitProgram, d: DraftOut): string {
  return d.body;
}

/** v0.31.0: write Randall's briefing as an internal note on the Graph draft.
 *  Best-effort: a failed note never costs a draft. Same secret the
 *  remote-config read uses. */
export async function postInternalNote(mailbox: string, draftId: string, text: string, label: string): Promise<{ ok: boolean; error?: string }> {
  const secret = process.env.VISTACRM_BRIDGE_SECRET;
  if (!secret) return { ok: false, error: "VISTACRM_BRIDGE_SECRET not set" };
  const base = (process.env.VISTARANDALL_BASE_URL || "https://vistarandall.app").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/internal/email-notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ mailbox, draft_id: draftId, text, label }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) return { ok: false, error: `${res.status} ${String(j?.error || "").slice(0, 160)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 160) };
  }
}

export function stripLegacySig(p: NonprofitProgram, body: string): string {
  const marker = `\n\n${p.persona.senderName}\n${p.persona.senderTitle}`;
  const i = body.indexOf(marker);
  return i >= 0 ? body.slice(0, i).trimEnd() : body;
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

/** v0.34.1: `categories` are the Outlook categories stamped on the draft at
 *  creation (lib/nonprofit/draft-categories.ts). Graph accepts them on the
 *  POST, so the chips are on the draft the moment it exists. */
export async function createDraft(mailbox: string, to: string, toName: string, subject: string, body: string, categories: string[] = nonprofitDraftCategories(null, "Nonprofit Outreach")): Promise<{ id: string; webLink: string | null }> {
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to, name: toName } }],
      categories,
      internetMessageHeaders: [{ name: "X-Vistamark-Source", value: ENGINE_ACTOR }],
    }),
  });
  if (!res.ok) throw new Error(`graph draft ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { id: string; webLink?: string };
  return { id: j.id, webLink: j.webLink ?? null };
}

/** v0.36.1: read one message (body as stored, and whether it is still a
 *  draft). null when it no longer exists (sent drafts get a new id, deleted). */
export async function getMessageBody(mailbox: string, messageId: string): Promise<{ isDraft: boolean; contentType: string; content: string; subject: string } | null> {
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=isDraft,body,subject`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`graph get ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  return { isDraft: !!j.isDraft, contentType: String(j.body?.contentType || "text"), content: String(j.body?.content ?? ""), subject: String(j.subject ?? "") };
}

/** v0.36.1: replace a draft's body keeping its content type (HTML once Outlook
 *  has re-saved it). */
export async function patchDraftBodyAs(mailbox: string, messageId: string, contentType: string, content: string): Promise<void> {
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: { contentType: /html/i.test(contentType) ? "HTML" : "Text", content } }),
  });
  if (!res.ok) throw new Error(`graph patch ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** v0.37.0: replace a draft's subject AND body (reformat of existing drafts). */
export async function patchDraft(mailbox: string, messageId: string, subject: string, contentType: string, content: string): Promise<void> {
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ subject, body: { contentType: /html/i.test(contentType) ? "HTML" : "Text", content } }),
  });
  if (!res.ok) throw new Error(`graph patch ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Replace the body of an existing (unsent) draft in a mailbox. */
export async function updateDraftBody(mailbox: string, messageId: string, body: string): Promise<void> {
  const token = await graphToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: { contentType: "Text", content: body } }),
  });
  if (!res.ok) throw new Error(`graph patch ${res.status}: ${(await res.text()).slice(0, 300)}`);
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

async function runProgram(p: NonprofitProgram, has990: boolean, opts: Required<Pick<NpEngineOptions, "target" | "maxCandidates" | "dryRun">> & { actor: string; deadline: number; card?: { directiveDnum: number | null; label: string } }): Promise<NpProgramSummary> {
  const s: NpProgramSummary = {
    program: p.key, target: opts.target, examined: 0, drafted: 0,
    skipped: [], drafts: [], budgetExhausted: false, candidatesExhausted: false, warnings: [],
  };
  if (!graphConfigured()) s.warnings.push("MS_GRAPH_* not set — Outlook drafts cannot be created");
  if (!crmConfigured()) s.warnings.push("VISTACRM_BRIDGE_SECRET not set — CRM lead creation queued as np_events kind crm_pending; copy the secret from the vistarandall Vercel project");

  const candidates = await selectOrgs(p, has990, opts.maxCandidates);
  if (!candidates.length) {
    s.candidatesExhausted = true;
    s.warnings.push(`no untouched orgs match the ${p.key} band/geo — widen the band on its VistaRandall directive card or clear np_leads rows`);
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
      if (meta.error) console.error(`[nonprofit-engine] ${org.name}: ${reason}: ${String(meta.error).slice(0, 400)}`);
      s.skipped.push({ reason, ein: org.ein, org: org.name, person, ...(meta.error ? { error: String(meta.error).slice(0, 200) } : {}) });
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
        if (person.name && person.name.split(" ").length > pick.name.split(" ").length) pick.name = person.name;
        pick.title = pick.title ?? person.title ?? null;
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
    const body = finalBody(p, d);
    const cardLabel = opts.card?.label || `${p.key} Nonprofit Outreach`;

    let delivery = "pending";
    let graph: { id: string; webLink: string | null } | null = null;
    let noteState = "skipped";
    if (opts.dryRun) { delivery = "dry_run"; noteState = "dry_run"; }
    else if (graphConfigured()) {
      try { graph = await createDraft(p.mailbox, email, pick.name, d.subject, body, nonprofitDraftCategories(opts.card?.directiveDnum ?? null, cardLabel)); delivery = "outlook_draft"; }
      catch (err) { s.warnings.push(`graph draft failed for ${pick.name} (${p.mailbox}): ${String(err).slice(0, 180)} — queued`); }
      // v0.31.0: the briefing rides the draft as an internal note, not body text.
      if (graph?.id) {
        const n = await postInternalNote(p.mailbox, graph.id, note, `${cardLabel} briefing`);
        noteState = n.ok ? "internal_note" : "note_failed";
        if (!n.ok) s.warnings.push(`internal note not written for ${pick.name} (draft IS placed; briefing is in np_events): ${n.error}`);
      }
    }
    if (!opts.dryRun && leadId != null) {
      await logEvent(leadId, "deliver", `draft → ${email}: ${d.subject}`, {
        delivery, to: email, toName: pick.name, mailbox: p.mailbox, subject: d.subject, body,
        briefing: note, briefingDelivery: noteState,
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
  const budgetMs = Math.max(60_000, Math.min(opts.budgetMs ?? 280_000, 780_000));
  const actor = opts.actor ?? ENGINE_ACTOR;
  const deadline = started + budgetMs;
  const has990 = await has990Tables();

  // v0.30.0 (2026-10-19, M. Rice): each program's settings live on its
  // VistaRandall directive card. If they cannot be read, the run is SKIPPED
  // and that is recorded loudly -- never a silent run on the file defaults.
  const cfg = await loadEffectivePrograms();
  if (!cfg.ok) {
    const msg = `nonprofit engine run SKIPPED: program settings could not be read from VistaRandall (${cfg.url}): ${cfg.error}. No drafts were made; lib/nonprofit/programs.ts defaults were NOT used.`;
    console.error(`[nonprofit-engine] ${msg}`);
    try { await logEvent(null, "config_unreachable", msg, { error: cfg.error, url: cfg.url, program: opts.program ?? "all" }, actor); }
    catch (e) { console.error("[nonprofit-engine] could not record config_unreachable in np_events:", e); }
    return { ok: false, has990, model: MODEL, elapsedMs: Date.now() - started, programs: [], error: msg, config: null };
  }

  const keys: Array<"matt" | "ryan"> = opts.program ? [opts.program] : ["matt", "ryan"];
  const programs: NpProgramSummary[] = [];
  for (const k of keys) {
    const eff = cfg.programs[k];
    const card = eff.directiveDnum ? `D-${String(eff.directiveDnum).padStart(3, "0")}` : "(no card bound)";
    if (!eff.enabled) {
      const msg = `${k} program is paused on its VistaRandall card ${card}; not run`;
      console.log(`[nonprofit-engine] ${msg}`);
      if (!opts.dryRun) await logEvent(null, "paused", msg, { program: k, directiveDnum: eff.directiveDnum }, actor);
      programs.push({ program: k, target: 0, examined: 0, drafted: 0, skipped: [], drafts: [], budgetExhausted: false, candidatesExhausted: false, warnings: [msg], paused: true, directiveDnum: eff.directiveDnum });
      continue;
    }
    // The card's target governs scheduled runs; a manual ?target= still overrides.
    const target = Math.max(1, Math.min(opts.target ?? eff.target, 10));
    const maxCandidates = Math.max(target, Math.min(opts.maxCandidates ?? 12, 40));
    const s = await runProgram(eff.program, has990, { target, maxCandidates, dryRun: !!opts.dryRun, actor, deadline, card: { directiveDnum: eff.directiveDnum, label: eff.label } });
    s.directiveDnum = eff.directiveDnum;
    programs.push(s);
  }
  return { ok: true, has990, model: MODEL, elapsedMs: Date.now() - started, programs, config: { source: cfg.url, fetchedAt: cfg.fetchedAt } };
}
