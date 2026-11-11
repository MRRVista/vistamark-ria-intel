/**
 * Lawyer COI outreach engine -- the nightly "find N Chicago-area attorneys in
 * the lanes Matt wants referral relationships with, draft each a short COI
 * note, put the Lead in VistaCRM" pipeline. v0.39.0 (2026-10-30).
 *
 *   universe -> the legal-pros directory family (lib/legal-pros): peer-elected
 *               specialty societies (ACTEC, AAML-IL, ACEBC, CDI, CEPC, NAELA)
 *               and Leading Lawyers by practice-area preset. No IRS universe,
 *               no EIN: the person IS the record. Discovery is per LANE
 *               (erisa | divorce | te | transaction | tax) and per GEO BAND
 *               (Hinsdale -> west suburbs -> Loop/River North -> metro); a
 *               later band is only worked when the earlier ones are exhausted
 *               for that lane. Attorneys already in lawyer_leads are out.
 *   verify   -> ardc_lawyer_lookup, run last per the family doctrine: licence
 *               must be active; the registered firm backfills the directory
 *               firm; public discipline is recorded, not a hard stop.
 *   email    -> the directory's published email when there is one (Leading
 *               Lawyers members, ACTEC), else apollo_person_enrich by name +
 *               firm (1 credit). emailStatus is carried everywhere.
 *   research -> one web-search model call: identity check against the firm,
 *               practice focus, shared affinity on the program's list, and
 *               (divorce lane) whether they handle high-asset cases so the
 *               expert-witness line is warranted.
 *   draft    -> two paragraphs, "Name," opening, fixed 20-minute intro ask,
 *               no em dashes, no pleasantries, sender facts only.
 *   deliver  -> Outlook Drafts in Matt's mailbox via Graph. Never sends.
 *   crm      -> once the draft exists, the person is created in VistaCRM as a
 *               Lead (coordinator Matt, tags lawyer outreach / coi) with the
 *               enrichment in `background` and a timeline note.
 *
 * Every step writes a lawyer_events row. Mirrors lib/nonprofit/engine.ts;
 * Graph, internal-note and dash/opening helpers are shared with it.
 */

import { sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { apolloPersonEnrich } from "../apollo/tools";
import { actecFellowSearch, aamlIlFellowSearch, collaborativeDivorceIlSearch, cepcMemberSearch, naelaIlSearch } from "../legal-pros/directories-estate-family";
import { acebcFellowSearch, leadingLawyersSearch, ardcLawyerLookup } from "../legal-pros/directories-erisa-general";
import { createDraft, postInternalNote, affinityOnList, sharedTieBacked } from "../nonprofit/engine";
import { PROGRAM, LawyerProgram, LawyerCategory, LaneConfig, GeoBand, personaFactsBlock, ALWAYS_TAG, LAWYER_CATEGORIES } from "./programs";
import { loadEffectiveLawyerProgram } from "./remote-config";
import { lawyerDraftCategories } from "./draft-categories";
import { crmLookup, conversationIdOf, threadState, createFollowUpDraft, followUpText } from "./followup";
import { normalizeDirectOpening } from "../outreach/opening";
import { dashRule, stripDashes, hasForbiddenDash } from "../outreach/dashes";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = process.env.LAWYER_ENGINE_MODEL || process.env.NONPROFIT_ENGINE_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export const ENGINE_ACTOR = "lawyer-engine";

// -- Types -------------------------------------------------------------------

export interface LawyerEngineOptions {
  target?: number;              // drafts this run; default = card
  category?: LawyerCategory;    // one lane only; default = card (null = cycle)
  maxCandidates?: number;       // attorneys examined; default 15
  budgetMs?: number;
  dryRun?: boolean;
  actor?: string;
  /** v0.41.0: run the follow-up pass first (default true; ad hoc chunks pass false). */
  followUps?: boolean;
}

export interface Candidate {
  name: string;
  firstName: string | null;
  lastName: string | null;
  firm: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  profileUrl: string | null;
  practiceAreas: string[];
  sources: string[];
  category: LawyerCategory;
  band: 1 | 2 | 3 | 4;
  score: number;
}

export interface ArdcOut {
  ardcId: string | null;
  authorized: boolean | null;
  status: string | null;
  firm: string | null;
  admitted: string | null;
  discipline: boolean | null;
  email: string | null;
  profileUrl: string | null;
}

export interface ResearchOut {
  confidence: "high" | "medium" | "low";
  identity_match: string;
  summary: string;
  practice_focus: string;
  affinity: string | null;
  affinity_kind: "school" | "city" | "board" | "career" | null;
  high_asset_work: boolean | null;
  personalization_hooks: string[];
  sources: string[];
}

interface DraftOut { subject: string; body: string }

export interface LawyerRunSummary {
  ok: boolean;
  model: string;
  elapsedMs: number;
  program: "matt";
  target: number;
  category: LawyerCategory | null;
  maxBand: number;
  examined: number;
  drafted: number;
  byLane: Partial<Record<LawyerCategory, number>>;
  skipped: Array<{ reason: string; person: string; firm?: string | null; lane: LawyerCategory; error?: string }>;
  drafts: Array<{ leadId: number; person: string; firm: string | null; lane: LawyerCategory; band: number; email: string; emailStatus: string | null; subject: string; delivery: string; crm: string }>;
  budgetExhausted: boolean;
  candidatesExhausted: boolean;
  warnings: string[];
  paused?: boolean;
  directiveDnum?: number | null;
  error?: string;
  config: { source: string; fetchedAt: string } | null;
  /** v0.41.0: the follow-up pass, when it ran. */
  followUps?: FollowUpSummary;
}

export interface FollowUpSummary { checked: number; drafted: number; replied: number; notSent: number; waiting: number; errors: string[] }

// -- Model plumbing ------------------------------------------------------------

type ContentBlock = { type: string; text?: string; [k: string]: unknown };

async function anthropic(body: Record<string, unknown>, timeoutMs: number): Promise<ContentBlock[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { content: ContentBlock[] };
  return j.content ?? [];
}

function finalText(blocks: ContentBlock[]): string {
  return blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
}

function extractJson<T>(text: string): T {
  const m = text.match(/<result>([\s\S]*?)<\/result>/i) ?? text.match(/<r>([\s\S]*?)<\/r>/i);
  const raw = (m ? m[1] : text).replace(/```json|```/g, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON object in model output");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

function rows<T = any>(r: any): T[] { return (r?.rows ?? r ?? []) as T[]; }

// -- Names / keys ----------------------------------------------------------------

const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv|esq\.?|j\.?d\.?|cpa|llm|ll\.m\.?)$/i;
export const normName = (s: string) => String(s || "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
export const normFirm = (s: string | null | undefined) =>
  String(s || "").toUpperCase().replace(/[.,'&]/g, " ").replace(/\b(LLP|LLC|LTD|PC|P C|CHARTERED|AND|THE|LAW|OFFICES?|GROUP|ATTORNEYS? AT LAW)\b/g, " ").replace(/\s+/g, " ").trim();

export function splitName(full: string): { first: string | null; last: string | null } {
  const parts = String(full || "").replace(/,.*$/, "").split(/\s+/).filter((p) => p && !SUFFIX.test(p));
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

export function personKey(name: string, firm: string | null, ardcId: string | null): string {
  if (ardcId) return `ardc:${ardcId}`;
  return `name:${normName(name)}|firm:${normFirm(firm)}`.slice(0, 200);
}

/** Band of a directory row from its city (preferred) or zip. 0 = outside every band. */
export function bandOf(city: string | null, zip: string | null, state: string | null, bands: GeoBand[]): 0 | 1 | 2 | 3 | 4 {
  if (state && state.toUpperCase() !== "IL") return 0;
  const c = String(city || "").trim().toLowerCase().replace(/\s+/g, " ");
  const z3 = String(zip || "").slice(0, 3);
  for (const b of bands) {
    if (b.cities.some((x) => x.toLowerCase() === c)) return b.band;
  }
  for (const b of bands) {
    if (b.band === 4 && z3 && b.zipPrefixes.includes(z3)) return 4;
  }
  return 0;
}

// -- Discovery -----------------------------------------------------------------------

type DirRow = { name?: string; firm?: string | null; city?: string | null; state?: string | null; zip?: string | null; email?: string | null; phone?: string | null; website?: string | null; profileUrl?: string | null; practiceAreas?: string[]; tier?: string | null; extras?: any };

function shapeRows(out: any): DirRow[] { return Array.isArray(out?.rows) ? out.rows : []; }

const TOOL_PRIORITY: Record<string, number> = {
  actec_fellow_search: 30, acebc_fellow_search: 30, aaml_il_fellow_search: 30,
  collaborative_divorce_il_search: 22, cepc_member_search: 20, naela_il_search: 18,
  leading_lawyers_search: 15, courtlistener_counsel: 5,
};

/** Run one lane's directory tools for the bands allowed and merge the rows. */
export async function discoverLane(lane: LaneConfig, p: LawyerProgram, maxBand: number, log: (m: string) => void, stats?: { failed: number }): Promise<Candidate[]> {
  const bands = p.geo.filter((b) => b.band <= maxBand);
  const merged = new Map<string, Candidate>();
  const add = (row: DirRow, tool: string) => {
    const name = String(row.name || "").trim();
    if (!name || /\b(deceased|in memoriam)\b/i.test(name)) return;
    const band = bandOf(row.city ?? null, row.zip ?? null, row.state ?? null, p.geo);
    if (!band || band > maxBand) return;
    const key = `${normName(name)}|${normFirm(row.firm)}`;
    const w = (p.geo.find((b) => b.band === band)?.weight ?? 0) * 10 + (TOOL_PRIORITY[tool] ?? 10) + (row.email ? 8 : 0) + (/^LL/i.test(String(row.tier || "")) ? 3 : 0);
    const cur = merged.get(key);
    if (cur) {
      if (!cur.sources.includes(tool)) cur.sources.push(tool);
      cur.score += TOOL_PRIORITY[tool] ?? 10;
      cur.email = cur.email ?? row.email ?? null;
      cur.firm = cur.firm ?? row.firm ?? null;
      cur.phone = cur.phone ?? row.phone ?? null;
      cur.website = cur.website ?? row.website ?? null;
      for (const a of row.practiceAreas ?? []) if (!cur.practiceAreas.includes(a)) cur.practiceAreas.push(a);
      return;
    }
    const { first, last } = splitName(name);
    merged.set(key, {
      name, firstName: first, lastName: last, firm: row.firm ?? null, city: row.city ?? null, state: row.state ?? "IL", zip: row.zip ?? null,
      email: row.email ?? null, phone: row.phone ?? null, website: row.website ?? null, profileUrl: row.profileUrl ?? null,
      practiceAreas: [...(row.practiceAreas ?? [])], sources: [tool], category: lane.category, band: band as 1 | 2 | 3 | 4, score: w,
    });
  };
  const call = async (tool: string, fn: () => Promise<any>) => {
    try { const out = await fn(); const rs = shapeRows(out); for (const r of rs) add(r, tool); log(`${lane.category}/${tool}: ${rs.length} rows`); }
    catch (err) { if (stats) stats.failed += 1; log(`${lane.category}/${tool} failed: ${String(err).slice(0, 160)}`); }
  };

  const cityList = bands.flatMap((b) => b.cities);
  const cities = cityList.length ? cityList : ["Chicago"];
  for (const tool of lane.tools) {
    if (tool === "actec_fellow_search") {
      await call(tool, () => actecFellowSearch({ state: "IL", limit: 100 }));
    } else if (tool === "acebc_fellow_search") {
      await call(tool, () => acebcFellowSearch({ state: "IL", limit: 100 }));
    } else if (tool === "aaml_il_fellow_search") {
      await call(tool, () => aamlIlFellowSearch({ limit: 100 }));
    } else if (tool === "collaborative_divorce_il_search") {
      for (const city of cities.slice(0, 6)) await call(tool, () => collaborativeDivorceIlSearch({ role: "Attorney", city, details: true, detailLimit: 25, limit: 25 }));
    } else if (tool === "cepc_member_search") {
      await call(tool, () => cepcMemberSearch({ limit: 100, details: true }));
    } else if (tool === "naela_il_search") {
      await call(tool, () => naelaIlSearch({ zip: "60521", limit: 60 }));
    } else if (tool === "leading_lawyers_search") {
      const geoArgs: Array<Record<string, string>> = [];
      if (maxBand >= 1) geoArgs.push({ city: "Hinsdale" });
      if (maxBand >= 2) geoArgs.push({ county: "DuPage" }, { city: "La Grange" }, { city: "Western Springs" });
      if (maxBand >= 3) geoArgs.push({ city: "Chicago" });
      if (maxBand >= 4) geoArgs.push({ county: "Cook" }, { county: "Lake" });
      for (const preset of lane.llPresets) for (const g of geoArgs) {
        await call(tool, () => leadingLawyersSearch({ practiceArea: preset, state: "IL", ...g, limit: 100 }));
      }
    }
    // courtlistener_counsel is a docket signal, not a people directory; skipped in v1.
  }
  return [...merged.values()].sort((a, b) => a.band - b.band || b.score - a.score);
}

// v0.41.2: the directory walk is kept in lawyer_discovery for a week. It took
// about two minutes of every run (some forty Leading Lawyers pages, one at a
// time), which left time for one draft. The rosters change slowly; a lane is
// walked again only when its row is older than DISCOVERY_TTL_DAYS, or when a
// walk came back empty.
const DISCOVERY_TTL_DAYS = Math.max(1, Number(process.env.LAWYER_DISCOVERY_TTL_DAYS) || 7);
const cloneCands = (a: Candidate[]): Candidate[] => a.map((c) => ({ ...c, sources: [...(c.sources ?? [])], practiceAreas: [...(c.practiceAreas ?? [])] }));

async function saveDiscovery(lane: LawyerCategory, maxBand: number, found: Candidate[], log: (m: string) => void): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO lawyer_discovery (lane, max_band, candidates, n, fetched_at, complete)
      VALUES (${lane}, ${maxBand}, ${JSON.stringify(found)}::jsonb, ${found.length}, NOW(), TRUE)
      ON CONFLICT (lane, max_band) DO UPDATE SET candidates = EXCLUDED.candidates, n = EXCLUDED.n, fetched_at = EXCLUDED.fetched_at, complete = TRUE`);
  } catch (err) { log(`${lane}: directory walk not saved (${String(err).slice(0, 120)})`); }
}

/** A lane's candidates: the saved walk when there is one, else a fresh walk.
 *  `stale` = the saved walk is past its week and was used anyway, so drafting
 *  is not held up; the run walks that lane again afterwards if time is left.
 *  A saved walk four times past its week is not trusted: the lane is walked
 *  first. */
async function discoverLaneCached(lane: LaneConfig, p: LawyerProgram, maxBand: number, log: (m: string) => void, canWrite: boolean): Promise<{ rows: Candidate[]; stale: boolean }> {
  try {
    const r = rows<{ candidates: any; fetched_at: string; age_days: number }>(await db.execute(sql`
      SELECT candidates, fetched_at, EXTRACT(EPOCH FROM (NOW() - fetched_at)) / 86400 AS age_days FROM lawyer_discovery
      WHERE lane = ${lane.category} AND max_band = ${maxBand} AND n > 0 AND complete`));
    if (r[0] && Number(r[0].age_days) < DISCOVERY_TTL_DAYS * 4) {
      const list = typeof r[0].candidates === "string" ? JSON.parse(r[0].candidates) : r[0].candidates;
      if (Array.isArray(list) && list.length) {
        const stale = Number(r[0].age_days) >= DISCOVERY_TTL_DAYS;
        log(`${lane.category}: ${list.length} from the directory walk of ${new Date(r[0].fetched_at).toISOString().slice(0, 10)}${stale ? " (due for a new walk)" : ""}`);
        return { rows: cloneCands(list as Candidate[]), stale };
      }
    }
  } catch (err) { log(`${lane.category}: saved directory walk unreadable (${String(err).slice(0, 120)}); walking again`); }
  // v0.41.4: a walk in which any directory call failed is used for this run
  // but not kept. The third live run saved 9 divorce attorneys for a week
  // because one roster call timed out; the lane has 99.
  const stats = { failed: 0 };
  const found = await discoverLane(lane, p, maxBand, log, stats);
  if (found.length && canWrite && stats.failed === 0) await saveDiscovery(lane.category, maxBand, found, log);
  else if (stats.failed) log(`${lane.category}: ${stats.failed} directory call(s) failed; this walk is not kept`);
  return { rows: found, stale: false };
}

async function alreadyTouched(): Promise<Set<string>> {
  // retry:<reason> rows are owed one more attempt, so they are not "touched".
  const r = rows<{ person_key: string; person_name: string; firm_norm: string | null }>(await db.execute(sql`SELECT person_key, person_name, firm_norm FROM lawyer_leads WHERE status NOT LIKE 'retry:%'`));
  const s = new Set<string>();
  for (const x of r) { s.add(x.person_key); s.add(`name:${normName(x.person_name)}`); }
  return s;
}

// -- ARDC verification ------------------------------------------------------------------

export async function verifyArdc(c: Candidate): Promise<ArdcOut> {
  if (!c.lastName) return { ardcId: null, authorized: null, status: null, firm: null, admitted: null, discipline: null, email: null, profileUrl: null };
  const out: any = await ardcLawyerLookup({ lastName: c.lastName, firstName: c.firstName ?? undefined, authorizedOnly: false, includeDetails: true, detailLimit: 3, limit: 5 });
  const rs: any[] = shapeRows(out);
  const want = normName(c.name);
  const match = rs.find((r) => normName(String(r.name || "")) === want)
    ?? rs.find((r) => normName(String(r.name || "")).split(" ").slice(-1)[0] === want.split(" ").slice(-1)[0] && (!c.city || normName(String(r.city || "")) === normName(c.city)))
    ?? (rs.length === 1 ? rs[0] : null);
  if (!match) return { ardcId: null, authorized: null, status: null, firm: null, admitted: null, discipline: null, email: null, profileUrl: null };
  const authorizedRaw = match.authorizedToPractice;
  const authorized = typeof authorizedRaw === "boolean" ? authorizedRaw : /^(yes|true|active|authorized)/i.test(String(authorizedRaw ?? match.status ?? ""));
  const idFromUrl = String(match.profileUrl || "").match(/PrintableDetails\/([0-9a-f-]{36})/i)?.[1] ?? null;
  return {
    ardcId: idFromUrl,
    authorized,
    status: match.status ?? (authorized ? "Authorized to practice" : null),
    firm: match.firm ?? null,
    admitted: match.dateAdmitted ?? null,
    discipline: typeof match.disciplineFlag === "boolean" ? match.disciplineFlag : null,
    email: match.email && !/not available/i.test(String(match.email)) ? String(match.email) : null,
    profileUrl: match.profileUrl ?? null,
  };
}

// -- Research --------------------------------------------------------------------------------

async function researchLawyer(c: Candidate, lane: LaneConfig, ardc: ArdcOut, p: LawyerProgram, timeoutMs: number): Promise<ResearchOut> {
  const system = `You are a research analyst for Vistamark Investments, a Hinsdale, Illinois independent investment office. Its founder is about to write a first email to an attorney as a possible referral relationship (${lane.label}). Lane purpose: ${lane.purpose}

Your job: confirm this is the right attorney at this firm and find GENUINE, citable personalization, especially any SHARED AFFINITY from this list:
${p.affinities.map((a) => `- ${a}`).join("\n")}

Hard rules:
- Use web search (at most 4 searches). Anchor identity on the person's connection to the FIRM and practice area; say plainly how confident you are.
- personalization_hooks must be concrete, verifiable, and appropriate in a first professional email: practice focus, firm role, bar or society leadership, published articles or talks, board seats, civic recognition, alma mater. NEVER health, family, religion, politics, specific cases or clients, home, or anything creepy to have noticed.
- affinity: the single strongest shared-affinity fact you actually verified, else null. Do not stretch.
- practice_focus: ONE sentence on what this attorney actually does, drawn from the firm bio.
- high_asset_work: ${lane.expertWitness ? "true if the bio or press shows the attorney handles high-asset or complex-asset divorce matters (business owners, executives, professionals), false if clearly not, null if unknown." : "null (not relevant for this lane)."}
- Do not invent anything about Vistamark.

Your FINAL message must be exactly one JSON object inside <result></result> tags and nothing else:
{"confidence":"high|medium|low","identity_match":"...","summary":"2-3 sentence professional bio","practice_focus":"...","affinity":null,"affinity_kind":null,"high_asset_work":null,"personalization_hooks":[],"sources":[]}
affinity_kind is "school" | "city" | "board" | "career" | null.`;

  const user = `Attorney: ${c.name}
Firm: ${ardc.firm ?? c.firm ?? "unknown"}${c.city ? ` (${c.city}, ${c.state ?? "IL"})` : ""}
Directory listings: ${c.sources.join(", ")}${c.practiceAreas.length ? `\nListed practice areas: ${c.practiceAreas.slice(0, 8).join("; ")}` : ""}
${ardc.admitted ? `Illinois ARDC: admitted ${ardc.admitted}, status ${ardc.status ?? "unknown"}` : ""}
${c.website ? `Firm site: ${c.website}` : ""}${c.profileUrl ? `\nDirectory profile: ${c.profileUrl}` : ""}

Verify and research this attorney, following the rules exactly.`;

  const first = await anthropic({
    max_tokens: 3000, system,
    messages: [{ role: "user", content: user }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
  }, timeoutMs);
  let r: ResearchOut;
  try { r = extractJson<ResearchOut>(finalText(first)); }
  catch {
    const retry = await anthropic({
      max_tokens: 1500, system,
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
  if (typeof r.practice_focus !== "string") r.practice_focus = "";
  if (typeof r.summary !== "string") r.summary = "";
  if (typeof r.affinity !== "string") r.affinity = null;
  if (typeof r.high_asset_work !== "boolean") r.high_asset_work = null;
  return r;
}

// -- Draft -----------------------------------------------------------------------------------

/** The fixed ask (M. Rice, 2026-10-30): a 20-minute intro call, each learning
 *  what the other does and how to be helpful. COI tone, not sales. */
export const LAWYER_ASK = "Would you be open to a 20-minute call in the next few weeks so we can each hear what the other does and see where we might be helpful to each other's clients?";
const PLEASANTRY = /^(?:i\s+)?(?:hope|trust)\b|^i wanted to\b|^my name is\b|^allow me\b|^let me introduce\b/i;
const CAREER_IN_P2 = /\b(?:your (?:career|background|experience|tenure|practice has|time at|work at|years at|role as|leadership at)|you(?:'|\u2019)ve (?:spent|led|built|served|worked|held|overseen)|you have (?:spent|led|built|served|worked|held|overseen))\b/i;
const SHARED_TIE_CLAIM = /\bfellow\b|\balum(?:nus|na|ni)?\b|\balma mater\b|\bwe both\b|\blike you,? i\b|\bi (?:also|too) (?:went|attended|graduated|grew up|live|lived|served|sit|sat)\b|\bmy own (?:years|time) (?:at|in)\b/i;
const SALESY = /\brefer(?:ral)?s? (?:to|for) (?:me|us|vistamark)\b|\bsend (?:me|us) (?:your )?clients\b|\bmanage your clients?'? (?:money|assets)\b/i;

function senderFirstName(p: LawyerProgram): string { return p.persona.senderName.split(/[\s,]+/)[0] || p.persona.senderName; }
function words(t: string): number { return t.split(/\s+/).filter(Boolean).length; }

export function assembleBody(firstName: string | null | undefined, p1: string, p2: string, p: LawyerProgram): string {
  const clean = (t: string) => stripDashes(t.replace(/\s*\n+\s*/g, " ").trim());
  const a = clean(p1).replace(/^(?:hi|hello|hey|dear)\b[^,]*,\s*/i, "");
  let b = clean(p2);
  b = b.replace(/\s*(?:[^.!?]*\b(?:coffee|call|chat|conversation|meet|connect|minutes)\b[^.!?]*\?)\s*$/i, "").trim();
  if (b && !/[.!?]$/.test(b)) b += ".";
  b = b ? `${b} ${LAWYER_ASK}` : LAWYER_ASK;
  return normalizeDirectOpening(`${a}\n\n${b}\n\nBest,\n${senderFirstName(p)}`, firstName);
}

export function checkDraft(subject: string, body: string, p: LawyerProgram, affinity: string | null, lane: LaneConfig, highAsset: boolean | null): string[] {
  const problems: string[] = [];
  const paras = body.split(/\n\s*\n/);
  const p1 = paras[1] ?? "";
  const p2 = paras[2] ?? "";
  const facts = p.persona.facts.map((f) => f.replace(ALWAYS_TAG, ""));
  if (SHARED_TIE_CLAIM.test(`${p1} ${p2}`) && !sharedTieBacked(affinity, facts)) {
    problems.push("claims a shared tie (\"fellow\", \"alum\", \"we both\"...) that the sender's facts do not state; mention the recipient's tie without claiming it for the sender");
  }
  if (hasForbiddenDash(subject) || hasForbiddenDash(body)) problems.push("contains an em dash, en dash or \"--\"");
  const lower = `${body.toLowerCase()} ${subject.toLowerCase()}`;
  const hit = p.persona.banned.find((b) => lower.includes(b.toLowerCase()));
  if (hit) problems.push(`uses the banned phrase "${hit}"`);
  if (PLEASANTRY.test(p1.trim())) problems.push("paragraph 1 opens with a pleasantry or introduction instead of the reason for writing");
  if (CAREER_IN_P2.test(p2)) problems.push("paragraph 2 talks about the recipient's career; paragraph 2 is only about Vistamark and the sender");
  if (SALESY.test(body)) problems.push("asks for referrals or client money; this is a get-to-know-each-other note, the ask is a 20-minute call");
  if (/expert witness|testif/i.test(body) && !(lane.expertWitness && highAsset !== false)) problems.push("mentions expert witness work; only the divorce lane may, and only when the attorney handles high-asset matters");
  // v0.41.3: the first live draft turned "willing to serve as an expert witness"
  // into "I also serve as an expert witness". When the facts say only willing,
  // the email may say only willing.
  if (EW_PRESENT_CLAIM.test(body) && facts.some((f) => /willing to serve as an expert witness/i.test(f)) && !facts.some((f) => /\b(has served|serves|served) as an expert witness/i.test(f))) {
    problems.push("says the sender serves or has served as an expert witness; the facts say only that he is WILLING to. Write \"I am willing to serve as an expert witness\" or leave it out");
  }
  const n = words(p1) + words(p2);
  if (n < 45) problems.push(`too short (${n} words; aim for 60 to 90)`);
  if (n > 105) problems.push(`too long (${n} words; aim for 60 to 90)`);
  if (words(subject) > 7) problems.push("subject line longer than 6 words");
  return problems;
}

const EW_PRESENT_CLAIM = /\b(?:i|we|matt)\s+(?:also\s+|often\s+|regularly\s+|sometimes\s+)?(?:serve|act|work|testify|appear)s?\s+as\s+an?\s+expert witness|\bi am an expert witness|\bi(?: have|'ve)\s+(?:served|testified|acted)\b|\bmy (?:work|role) as an expert witness/i;

export async function draftEmail(c: Candidate, lane: LaneConfig, ardc: ArdcOut, r: ResearchOut, p: LawyerProgram, timeoutMs: number): Promise<DraftOut> {
  const ew = lane.expertWitness && r.high_asset_work !== false;
  const system = `You write very short first emails from ${p.persona.senderName}, ${p.persona.senderTitle} of ${p.persona.firm}, to attorneys in the Chicago area who could become referral relationships. This is a peer-to-peer "let's each learn what the other does" note between two professionals. Not a salesperson, not asking for anything but a short call.

Lane: ${lane.label}. ${lane.purpose}
Angle for paragraph 2 (orbit it, do not quote it): ${lane.hook}

About the sender and the firm. Use these facts and ONLY these facts about the sender, Vistamark or anyone at Vistamark:
${personaFactsBlock(p)}

Thesis (do not quote it): ${p.persona.thesis}

You write exactly TWO paragraphs. The greeting, the closing question and the sign-off are added for you; do not write them.

Paragraph 1 (personal, 1 to 2 sentences, about 25 to 40 words):
- Begin immediately with the specific reason you are writing to THIS attorney (e.g. "I'm writing because ..."). No pleasantries, no "hope all is well", no self-introduction.
- Build it from the shared affinity when one is provided, otherwise from their practice focus, their firm, a local tie (Hinsdale, the western suburbs), a society listing, or something they published.
- An affinity is the RECIPIENT's tie. Call it shared only when the sender's side is stated in the facts above, and then only at the level stated (e.g. "Northwestern"). Otherwise mention their tie without claiming one for the sender.
- Do NOT recap their career. Never mention specific cases or clients.

Paragraph 2 (cut to the chase, 1 to 2 sentences, about 25 to 40 words):
- What Vistamark does and what the sender brings that is relevant to THIS lane, using at most TWO of the facts above.${ew ? "\n- You MAY note in a few words that Matt is willing to serve as an expert witness on investment assets in divorce matters." : "\n- Do NOT mention expert witness work or testimony."}
- Frame it as mutual: there may be clients each of you should know about. Never ask for referrals and never offer to manage their clients' money.
- Nothing about the recipient's career. Do not end with a question; the ask is appended for you.

Rules:
- About 60 to 90 words across both paragraphs. Plain text. No bullet points, no bold.
${dashRule()}
- No performance claims, no promises, no return numbers. The $260 billion figure describes assets the prior firm oversaw and must be framed that way if used.
- Never use any of these words or phrases: ${p.persona.banned.join("; ")}.
- Subject line: 3 to 6 words, specific, no exclamation marks, no "introduction".

Return one JSON object in <result></result>: {"subject":"...","p1":"...","p2":"..."}`;

  const user = `Recipient: ${c.name} (first name: ${c.firstName ?? "unknown"}), ${ardc.firm ?? c.firm ?? "firm unknown"} (${c.city ?? ""}, ${c.state ?? "IL"})
Practice focus: ${r.practice_focus || c.practiceAreas.slice(0, 4).join("; ") || lane.label}
Shared affinity (lead paragraph 1 with it if present): ${r.affinity ?? "none"}
Directory listings: ${c.sources.join(", ")}
Hooks you may draw on for paragraph 1 (not a career recap):
${(r.personalization_hooks.length ? r.personalization_hooks : [r.summary || r.practice_focus]).map((h) => `- ${h}`).join("\n")}

Write the two paragraphs.`;

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: user }];
  let last: { subject: string; body: string; problems: string[] } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const blocks = await anthropic({ max_tokens: 700, system, messages }, timeoutMs);
    const raw = finalText(blocks);
    const j = extractJson<{ subject?: unknown; p1?: unknown; p2?: unknown }>(raw);
    if (typeof j.subject !== "string" || typeof j.p1 !== "string" || typeof j.p2 !== "string") throw new Error("draft missing subject/p1/p2");
    const subject = stripDashes(j.subject.trim().replace(/\s+/g, " ")).replace(/[.!]+$/, "").slice(0, 120);
    const body = assembleBody(c.firstName, j.p1, j.p2, p);
    const problems = checkDraft(subject, body, p, r.affinity, lane, r.high_asset_work);
    last = { subject, body, problems };
    if (!problems.length) return { subject, body };
    messages.push({ role: "assistant", content: raw.slice(-4000) });
    messages.push({ role: "user", content: `Fix these problems and return the corrected JSON only: ${problems.join("; ")}.` });
  }
  const hard = last!.problems.filter((x) => !/^too (?:short|long)|^subject line longer/.test(x));
  if (hard.length) throw new Error(`draft failed checks: ${hard.join("; ")}`);
  return { subject: last!.subject, body: last!.body };
}

function briefing(c: Candidate, lane: LaneConfig, ardc: ArdcOut, r: ResearchOut, emailStatus: string | null): string {
  return [
    `${c.name}${ardc.firm ?? c.firm ? `, ${ardc.firm ?? c.firm}` : ""} (${c.city ?? ""}, ${c.state ?? "IL"}) -- lane ${lane.label}, band ${c.band}`,
    `Listed in: ${c.sources.join(", ")}`,
    ardc.status ? `ARDC: ${ardc.status}${ardc.admitted ? `, admitted ${ardc.admitted}` : ""}${ardc.discipline ? " -- PUBLIC DISCIPLINE ON FILE" : ""}` : "ARDC: not matched",
    r.practice_focus ? `Focus: ${r.practice_focus}` : null,
    r.affinity ? `Affinity: ${r.affinity}` : null,
    lane.expertWitness ? `High-asset work: ${r.high_asset_work == null ? "unknown" : r.high_asset_work ? "yes" : "no"}` : null,
    `Email ${emailStatus ?? "unknown"}${emailStatus === "guessed" ? " -- VERIFY BEFORE SENDING" : ""}`,
  ].filter(Boolean).join("\n");
}

// -- VistaCRM ------------------------------------------------------------------------------

function crmConfigured(): boolean { return !!process.env.VISTACRM_BRIDGE_SECRET; }
function graphConfigured(): boolean { return !!(process.env.MS_GRAPH_TENANT_ID && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET); }
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

async function crmCreateLead(p: LawyerProgram, leadId: number, c: Candidate, lane: LaneConfig, ardc: ArdcOut, r: ResearchOut, email: string, emailStatus: string | null, d: DraftOut): Promise<{ crmId: string; created: boolean }> {
  const firm = ardc.firm ?? c.firm ?? null;
  const background = [
    `Lawyer COI outreach lead (${p.principalName} program, VistaIntel lawyer-engine, lane ${lane.label}).`,
    `Firm: ${firm ?? "unknown"}, ${c.city ?? ""} ${c.state ?? "IL"}. Listed in ${c.sources.join(", ")}.`,
    ardc.status ? `ARDC ${ardc.status}${ardc.admitted ? `, admitted ${ardc.admitted}` : ""}.` : null,
    r.practice_focus || null,
    r.affinity ? `Shared affinity: ${r.affinity}.` : null,
    r.summary,
  ].filter(Boolean).join(" ");
  const contact = {
    first_name: c.firstName ?? c.name.split(" ")[0],
    last_name: c.lastName ?? (c.name.split(" ").slice(1).join(" ") || null),
    roles: ["lead"],
    coordinator: p.principalEmail,
    source: "vistaintel:lawyer-outreach",
    company_name: firm,
    job_title: "Attorney",
    background: background.slice(0, 4000),
    tags: [...p.crmTags, `lawyer-${lane.category}`],
    emails: [{ address: email, kind: "work", is_primary: true }],
    phones: c.phone ? [{ number: c.phone, kind: "work", is_primary: true }] : [],
    addresses: c.city || c.state ? [{ city: c.city, state: c.state ?? "IL", postal: c.zip, kind: "work", is_primary: true }] : [],
    intel_ref: `vistaintel:lawyer:${leadId}`,
  };
  const res = await crmFetch("/api/contacts", { contact });
  let crmId: string | null = null;
  let created = false;
  if (res.status === 409 && Array.isArray(res.json?.duplicates) && res.json.duplicates.length) crmId = res.json.duplicates[0].crm_id;
  else if (res.json?.ok && res.json?.crm_id) { crmId = res.json.crm_id; created = true; }
  else throw new Error(`crm create ${res.status}: ${JSON.stringify(res.json).slice(0, 300)}`);

  const note = [
    `Lawyer COI outreach -- ${p.principalName} program, lane ${lane.label} (draft created, awaiting review in ${p.mailbox} Drafts).`,
    ``,
    `Attorney: ${c.name}${firm ? `, ${firm}` : ""} -- ${c.city ?? ""}, ${c.state ?? "IL"} ${c.zip ?? ""} (geo band ${c.band})`,
    `Directory listings: ${c.sources.join(", ")}${c.practiceAreas.length ? `\nPractice areas listed: ${c.practiceAreas.slice(0, 8).join("; ")}` : ""}`,
    ardc.status ? `ARDC: ${ardc.status}${ardc.admitted ? `, admitted ${ardc.admitted}` : ""}${ardc.discipline ? "; public discipline on file" : ""}${ardc.profileUrl ? `\nARDC profile: ${ardc.profileUrl}` : ""}` : "ARDC: no match found",
    c.website ? `Website: ${c.website}` : null,
    c.profileUrl ? `Profile: ${c.profileUrl}` : null,
    `Email: ${email} (${emailStatus ?? "unknown"}${emailStatus === "guessed" ? " -- verify before sending" : ""})`,
    r.affinity ? `Shared affinity: ${r.affinity} (${r.affinity_kind ?? ""})` : `Shared affinity: none found`,
    lane.expertWitness ? `High-asset divorce work: ${r.high_asset_work == null ? "unknown" : r.high_asset_work ? "yes" : "no"}` : null,
    ``,
    `Research (${r.confidence} confidence): ${r.summary}`,
    r.practice_focus ? `Practice focus: ${r.practice_focus}` : null,
    r.personalization_hooks.length ? `Hooks:\n${r.personalization_hooks.map((h) => `  - ${h}`).join("\n")}` : null,
    r.sources.length ? `Sources:\n${r.sources.map((s) => `  - ${s}`).join("\n")}` : null,
    ``,
    `Draft subject: ${d.subject}`,
    `If they reply, move them to Matt's routine COI program.`,
  ].filter((x) => x !== null).join("\n");
  const noteRes = await crmFetch(`/api/contacts/${crmId}/notes`, { body: note, author_email: "rstephens@vistamarkllc.com" });
  if (noteRes.status !== 200) throw new Error(`crm note ${noteRes.status}: ${JSON.stringify(noteRes.json).slice(0, 200)}`);
  return { crmId: crmId!, created };
}

// -- Persistence ---------------------------------------------------------------------------

/** A JS string[] as a Postgres text[] value. Drizzle expands a bare array
 *  parameter into a row "(a, b)", which Postgres rejects for a text[] column
 *  (v0.41.1: the first live run failed on exactly that). */
function textArray(a: string[] | null | undefined) {
  const v = (a ?? []).map((x) => String(x)).filter(Boolean);
  return v.length ? sql`ARRAY[${sql.join(v.map((x) => sql`${x}`), sql`, `)}]::text[]` : sql`'{}'::text[]`;
}

/** v0.41.1: failures that say nothing about the attorney (a registry or model
 *  call that errored). The attorney gets one more chance on a later run
 *  (status retry:<reason>) instead of being burned for good; a second failure
 *  is final. Same rule as the nonprofit engine. */
const TRANSIENT_REASONS = new Set(["ardc_error", "apollo_enrich_error", "research_error", "draft_error"]);

async function insertLead(p: LawyerProgram, c: Candidate): Promise<{ id: number; retried: boolean } | null> {
  const key = personKey(c.name, c.firm, null);
  const r = rows(await db.execute(sql`
    INSERT INTO lawyer_leads (program, category, person_key, person_name, first_name, last_name, firm, firm_norm, city, state, zip, geo_band,
                              source_tool, source_tools, practice_areas, email, email_status, status)
    VALUES (${p.key}, ${c.category}, ${key}, ${c.name}, ${c.firstName}, ${c.lastName}, ${c.firm}, ${normFirm(c.firm)}, ${c.city}, ${c.state}, ${c.zip}, ${c.band},
            ${c.sources[0] ?? null}, ${textArray(c.sources)}, ${textArray(c.practiceAreas)}, ${c.email}, ${c.email ? "directory" : null}, 'selected')
    ON CONFLICT (person_key) DO UPDATE SET status = 'selected:retry', updated_at = NOW() WHERE lawyer_leads.status LIKE 'retry:%'
    RETURNING id, status`));
  return r[0] ? { id: Number(r[0].id), retried: r[0].status === "selected:retry" } : null;
}

async function updateLead(id: number, fields: Record<string, unknown>): Promise<void> {
  const sets: any[] = [sql`updated_at = NOW()`];
  const map: Record<string, any> = {
    status: sql`status`, person_key: sql`person_key`, ardc_id: sql`ardc_id`, firm: sql`firm`, firm_norm: sql`firm_norm`,
    ardc_status: sql`ardc_status`, ardc_admitted: sql`ardc_admitted`, ardc_discipline: sql`ardc_discipline`,
    person_title: sql`person_title`, apollo_id: sql`apollo_id`, linkedin_url: sql`linkedin_url`, headline: sql`headline`,
    email: sql`email`, email_status: sql`email_status`, affinity: sql`affinity`, expert_witness: sql`expert_witness`,
    crm_contact_id: sql`crm_contact_id`, draft_subject: sql`draft_subject`, graph_message_id: sql`graph_message_id`, research: sql`research`,
    conversation_id: sql`conversation_id`, sent_at: sql`sent_at`, replied_at: sql`replied_at`, followup_state: sql`followup_state`,
    followup_at: sql`followup_at`, followup_message_id: sql`followup_message_id`, followup_checked_at: sql`followup_checked_at`,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in map)) continue;
    sets.push(k === "research" ? sql`${map[k]} = ${JSON.stringify(v)}::jsonb` : sql`${map[k]} = ${v as any}`);
  }
  await db.execute(sql`UPDATE lawyer_leads SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
}

async function logEvent(leadId: number | null, kind: string, detail: string, meta: Record<string, unknown>, actor: string): Promise<number> {
  const r = rows(await db.execute(sql`
    INSERT INTO lawyer_events (lead_id, kind, detail, meta, actor)
    VALUES (${leadId}, ${kind}, ${detail.slice(0, 2000)}, ${JSON.stringify(meta)}::jsonb, ${actor})
    RETURNING id`));
  return r[0]?.id ?? 0;
}

async function ardcIdClaimed(ardcId: string, exceptLeadId: number | null): Promise<boolean> {
  const r = rows<{ id: number }>(await db.execute(sql`SELECT id FROM lawyer_leads WHERE ardc_id = ${ardcId} AND id <> ${exceptLeadId ?? -1} LIMIT 1`));
  return r.length > 0;
}

// -- v0.41.0: schema for the follow-up columns (same statements as migration 0015) ---------

let schemaReady = false;
export async function ensureLawyerSchema(): Promise<void> {
  if (schemaReady) return;
  await db.execute(sql`ALTER TABLE lawyer_leads
    ADD COLUMN IF NOT EXISTS conversation_id TEXT, ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP, ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS followup_state VARCHAR(24), ADD COLUMN IF NOT EXISTS followup_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS followup_message_id TEXT, ADD COLUMN IF NOT EXISTS followup_checked_at TIMESTAMP`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS lawyer_discovery (
    lane VARCHAR(16) NOT NULL, max_band SMALLINT NOT NULL, candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
    n INTEGER NOT NULL DEFAULT 0, fetched_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY (lane, max_band))`);
  // v0.41.4: rows saved before this column existed read as not complete and are walked again.
  await db.execute(sql`ALTER TABLE lawyer_discovery ADD COLUMN IF NOT EXISTS complete BOOLEAN NOT NULL DEFAULT FALSE`);
  schemaReady = true;
}

// -- v0.41.0: one draft per firm inside the card's spacing window ----------------------------

async function recentlyDraftedFirms(days: number): Promise<Set<string>> {
  if (days <= 0) return new Set();
  const r = rows<{ firm_norm: string }>(await db.execute(sql`
    SELECT DISTINCT firm_norm FROM lawyer_leads
    WHERE draft_subject IS NOT NULL AND firm_norm IS NOT NULL AND firm_norm <> '' AND created_at > NOW() - make_interval(days => ${days})`));
  return new Set(r.map((x) => x.firm_norm));
}

// -- v0.41.0: the follow-up pass -------------------------------------------------------------
// A lead whose note the partner SENT and nobody answered gets ONE reply draft
// in the same thread, followUpDays after the send. A thread that was answered
// is marked replied (VistaRandall's reply watch does the Teams ping). A draft
// that was never sent is left alone and given up on after GIVE_UP_DAYS.

const FOLLOWUP_BATCH = 8;
const GIVE_UP_DAYS = 75;

export async function runLawyerFollowUps(mailbox: string, senderFirst: string, followUpDays: number, categories: string[], actor: string, deadline: number): Promise<FollowUpSummary> {
  const out: FollowUpSummary = { checked: 0, drafted: 0, replied: 0, notSent: 0, waiting: 0, errors: [] };
  const due = rows<{ id: number; first_name: string | null; person_name: string; conversation_id: string; created_at: string }>(await db.execute(sql`
    SELECT id, first_name, person_name, conversation_id, created_at FROM lawyer_leads
    WHERE status = 'drafted' AND conversation_id IS NOT NULL AND followup_state IS NULL
      AND created_at < NOW() - make_interval(days => ${followUpDays})
    ORDER BY COALESCE(followup_checked_at, created_at) ASC LIMIT ${FOLLOWUP_BATCH}`));
  for (const l of due) {
    if (Date.now() > deadline) break;
    out.checked += 1;
    try {
      const t = await threadState(mailbox, l.conversation_id);
      const ageDays = (Date.now() - new Date(l.created_at).getTime()) / 86_400_000;
      if (t.reply) {
        await updateLead(l.id, { followup_state: "replied", replied_at: t.reply.at, sent_at: t.sent ? t.sent.at : null, followup_checked_at: new Date().toISOString() });
        await logEvent(l.id, "followup", `replied by ${t.reply.from}; no follow-up`, { reply: t.reply }, actor);
        out.replied += 1; continue;
      }
      if (!t.sent) {
        if (ageDays > GIVE_UP_DAYS) {
          await updateLead(l.id, { followup_state: "not_sent", followup_checked_at: new Date().toISOString() });
          await logEvent(l.id, "followup", `first note never sent after ${Math.round(ageDays)} days; closed`, {}, actor);
          out.notSent += 1;
        } else { await updateLead(l.id, { followup_checked_at: new Date().toISOString() }); out.waiting += 1; }
        continue;
      }
      const sentAgeDays = (Date.now() - new Date(t.sent.at).getTime()) / 86_400_000;
      if (sentAgeDays < followUpDays) { await updateLead(l.id, { sent_at: t.sent.at, followup_checked_at: new Date().toISOString() }); out.waiting += 1; continue; }
      const text = followUpText(l.first_name || splitName(l.person_name).first, senderFirst);
      const d = await createFollowUpDraft(mailbox, t.sent.id, text, categories);
      await updateLead(l.id, { followup_state: "drafted", followup_at: new Date().toISOString(), followup_message_id: d.id, sent_at: t.sent.at, followup_checked_at: new Date().toISOString() });
      await logEvent(l.id, "followup", `follow-up draft placed (${Math.round(sentAgeDays)} days after the send, no reply)`, { graphMessageId: d.id, graphWebLink: d.webLink, body: text, sentAt: t.sent.at }, actor);
      out.drafted += 1;
    } catch (err) {
      out.errors.push(`${l.person_name}: ${String(err).slice(0, 180)}`);
      try { await updateLead(l.id, { followup_checked_at: new Date().toISOString() }); } catch { /* next run retries */ }
    }
  }
  return out;
}

// -- Orchestration -------------------------------------------------------------------------

const ACCEPT_GUESSED = process.env.LAWYER_ACCEPT_GUESSED !== "0";

export async function runLawyerEngine(opts: LawyerEngineOptions = {}): Promise<LawyerRunSummary> {
  const started = Date.now();
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const budgetMs = Math.max(60_000, Math.min(opts.budgetMs ?? 280_000, 780_000));
  const actor = opts.actor ?? ENGINE_ACTOR;
  const deadline = started + budgetMs;
  const remaining = () => deadline - Date.now();
  const base = (s: Partial<LawyerRunSummary>): LawyerRunSummary => ({
    ok: true, model: MODEL, elapsedMs: Date.now() - started, program: "matt", target: 0, category: null, maxBand: 1,
    examined: 0, drafted: 0, byLane: {}, skipped: [], drafts: [], budgetExhausted: false, candidatesExhausted: false, warnings: [], config: null, ...s,
  });

  const cfg = await loadEffectiveLawyerProgram();
  if (!cfg.ok) {
    const msg = `lawyer engine run SKIPPED: program settings could not be read from VistaRandall (${cfg.url}): ${cfg.error}. No drafts were made; lib/lawyer/programs.ts defaults were NOT used.`;
    console.error(`[lawyer-engine] ${msg}`);
    try { await logEvent(null, "config_unreachable", msg, { error: cfg.error, url: cfg.url }, actor); } catch (e) { console.error("[lawyer-engine] could not record config_unreachable:", e); }
    return base({ ok: false, error: msg });
  }
  const eff = cfg.program;
  const card = eff.directiveDnum ? `D-${String(eff.directiveDnum).padStart(3, "0")}` : "(no card bound)";
  if (!eff.enabled) {
    const msg = `lawyer program is paused on its VistaRandall card ${card}; not run`;
    console.log(`[lawyer-engine] ${msg}`);
    if (!opts.dryRun) await logEvent(null, "paused", msg, { directiveDnum: eff.directiveDnum }, actor);
    return base({ paused: true, directiveDnum: eff.directiveDnum, warnings: [msg], config: { source: cfg.url, fetchedAt: cfg.fetchedAt } });
  }

  const p = eff.program;
  if (!opts.dryRun) await ensureLawyerSchema();
  let followUps: FollowUpSummary | undefined;
  if (!opts.dryRun && opts.followUps !== false && eff.followUpDays > 0 && graphConfigured()) {
    try {
      followUps = await runLawyerFollowUps(p.mailbox, p.persona.senderName.split(/[\s,]+/)[0] || "Matt", eff.followUpDays,
        lawyerDraftCategories(eff.directiveDnum, eff.label || "Lawyer COI Outreach", "reply"), actor, Math.min(deadline - 200_000, Date.now() + 45_000));
      if (followUps.checked) console.log(`[lawyer-engine] follow-ups: ${JSON.stringify({ ...followUps, errors: followUps.errors.length })}`);
    } catch (err) { followUps = { checked: 0, drafted: 0, replied: 0, notSent: 0, waiting: 0, errors: [String(err).slice(0, 200)] }; }
  }
  const target = Math.max(1, Math.min(opts.target ?? eff.target, 15));
  const category = opts.category ?? eff.category;
  const maxCandidates = Math.max(target, Math.min(opts.maxCandidates ?? Math.max(15, target * 4), 60));
  const s = base({ target, category, maxBand: eff.maxBand, directiveDnum: eff.directiveDnum, config: { source: cfg.url, fetchedAt: cfg.fetchedAt }, ...(followUps ? { followUps } : {}) });
  if (followUps?.errors.length) s.warnings.push(`follow-up pass: ${followUps.errors.slice(0, 3).join(" | ")}`);
  if (!graphConfigured()) s.warnings.push("MS_GRAPH_* not set -- Outlook drafts cannot be created");
  if (!crmConfigured()) s.warnings.push("VISTACRM_BRIDGE_SECRET not set -- CRM lead creation skipped");
  const log = (m: string) => console.log(`[lawyer-engine] ${m}`);

  // Discovery: per lane, merged, then interleaved across lanes so a mixed run
  // spreads its drafts (erisa, divorce, te, transaction, tax, erisa, ...).
  const lanes: LawyerCategory[] = category ? [category] : p.laneOrder.filter((l) => LAWYER_CATEGORIES.includes(l));
  const touched = await alreadyTouched();
  // v0.41.0: a firm that got a draft inside the spacing window waits; its
  // attorneys are not claimed, so they come back once the window has passed.
  const busyFirms = await recentlyDraftedFirms(eff.firmSpacingDays);
  const firmBusy = (c: Candidate) => { const f = normFirm(c.firm); return !!f && busyFirms.has(f); };
  const perLane = new Map<LawyerCategory, Candidate[]>();
  // Lanes side by side; each reads its saved directory walk when it is fresh.
  const discovered = await Promise.all(lanes.map((lane) => discoverLaneCached(p.lanes[lane], p, eff.maxBand, log, !opts.dryRun)));
  for (let li = 0; li < lanes.length; li++) {
    const lane = lanes[li];
    const found = discovered[li].rows;
    const untouched = found.filter((c) => !touched.has(personKey(c.name, c.firm, null)) && !touched.has(`name:${normName(c.name)}`));
    const fresh = untouched.filter((c) => !firmBusy(c));
    log(`${lane}: ${found.length} found, ${untouched.length} untouched, ${untouched.length - fresh.length} held for firm spacing`);
    perLane.set(lane, fresh);
  }
  const candidates: Candidate[] = [];
  for (let i = 0; candidates.length < maxCandidates; i++) {
    let any = false;
    for (const lane of lanes) { const q = perLane.get(lane); if (q && q.length > i) { candidates.push(q[i]); any = true; } }
    if (!any) break;
  }
  // Lanes whose saved walk was past its week: walk them again, one at a time,
  // while there is time left in this run (after the drafting, or at once when
  // there was nobody left to draft).
  const refreshStale = async () => {
    if (opts.dryRun) return;
    for (let li = 0; li < lanes.length; li++) {
      if (!discovered[li].stale || remaining() < 75_000) continue;
      try { const st = { failed: 0 }; const fresh = await discoverLane(p.lanes[lanes[li]], p, eff.maxBand, log, st); if (fresh.length && st.failed === 0) await saveDiscovery(lanes[li], eff.maxBand, fresh, log); }
      catch (err) { log(`${lanes[li]}: new directory walk failed: ${String(err).slice(0, 120)}`); }
    }
  };
  if (!candidates.length) {
    await refreshStale();
    s.candidatesExhausted = true;
    s.warnings.push(`no untouched attorneys in ${lanes.join("/")} up to geo band ${eff.maxBand}; raise maxBand on card ${card}`);
    return s;
  }

  for (const c of candidates.slice(0, maxCandidates)) {
    if (s.drafted >= target) break;
    if (remaining() < 85_000) { s.budgetExhausted = true; break; }
    const lane = p.lanes[c.category];
    // v0.41.0: a second attorney at a firm drafted earlier in this run waits (not claimed).
    if (eff.firmSpacingDays > 0 && firmBusy(c)) { s.skipped.push({ reason: "firm_spacing", person: c.name, firm: c.firm, lane: c.category }); continue; }
    s.examined += 1;

    // v0.41.0: already a VistaCRM contact -> never a cold introduction. Asked
    // BEFORE the attorney is claimed; when the CRM cannot be asked the person
    // is left unclaimed for a later run.
    let known: Awaited<ReturnType<typeof crmLookup>> = null;
    if (crmConfigured()) {
      try { known = await crmLookup(c.firstName, c.lastName, c.email); }
      catch (err) { s.skipped.push({ reason: "crm_unreachable", person: c.name, firm: c.firm, lane: c.category, error: String(err).slice(0, 200) }); continue; }
    }

    const nameKey = personKey(c.name, c.firm, null);
    const claimed = opts.dryRun ? null : await insertLead(p, c);
    if (!opts.dryRun && claimed == null) { s.skipped.push({ reason: "already_claimed", person: c.name, firm: c.firm, lane: c.category }); continue; }
    const leadId = claimed?.id ?? null;
    const lid = leadId ?? 0;
    const fail = async (reason: string, meta: Record<string, unknown> = {}) => {
      if (meta.error) console.error(`[lawyer-engine] ${c.name}: ${reason}: ${String(meta.error).slice(0, 400)}`);
      s.skipped.push({ reason, person: c.name, firm: c.firm, lane: c.category, ...(meta.error ? { error: String(meta.error).slice(0, 200) } : {}) });
      if (!opts.dryRun && leadId != null) {
        const again = TRANSIENT_REASONS.has(reason) && !claimed?.retried;
        // A retry row goes back to its name key so the next run can claim it.
        await updateLead(leadId, again ? { status: `retry:${reason}`, person_key: nameKey, ardc_id: null } : { status: `skipped:${reason}` });
        await logEvent(leadId, "gate", again ? `will retry once: ${reason}` : `skipped: ${reason}`, meta, opts.actor ?? actor);
      }
    };

    if (known) { await fail("already_in_crm", { crmId: known.crmId, crmName: known.name, matchedBy: known.matchedBy, roles: known.roles }); if (leadId != null) await updateLead(leadId, { crm_contact_id: known.crmId }); continue; }

    // verify (ARDC)
    let ardc: ArdcOut;
    try { ardc = await verifyArdc(c); } catch (err) { await fail("ardc_error", { error: String(err) }); continue; }
    if (ardc.authorized === false) { await fail("ardc_not_authorized", { status: ardc.status }); continue; }
    if (ardc.ardcId && !opts.dryRun && (await ardcIdClaimed(ardc.ardcId, leadId))) { await fail("ardc_duplicate", { ardcId: ardc.ardcId }); continue; }
    if (ardc.firm && !c.firm) c.firm = ardc.firm;
    if (!opts.dryRun && leadId != null) {
      await updateLead(leadId, {
        status: "researching", ardc_id: ardc.ardcId, ardc_status: ardc.status, ardc_admitted: ardc.admitted, ardc_discipline: ardc.discipline,
        firm: c.firm, firm_norm: normFirm(c.firm), ...(ardc.ardcId ? { person_key: personKey(c.name, c.firm, ardc.ardcId) } : {}),
      });
      await logEvent(leadId, "verify", `ardc: ${ardc.status ?? "no match"}${ardc.firm ? ` at ${ardc.firm}` : ""}`, { ...ardc }, actor);
    }

    // email
    let email: string | null = c.email ?? ardc.email ?? null;
    let emailStatus: string | null = email ? "directory" : null;
    let apolloId: string | null = null; let linkedinUrl: string | null = null; let headline: string | null = null; let title: string | null = null;
    if (!email) {
      try {
        const enr: any = await apolloPersonEnrich({ name: c.name, organizationName: c.firm ?? undefined, ...(c.website ? { domain: c.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "") } : {}) });
        const person: any = enr?.person;
        email = person?.email ?? null;
        emailStatus = person?.emailStatus ?? null;
        apolloId = person?.apolloId ?? null; linkedinUrl = person?.linkedinUrl ?? null; headline = person?.headline ?? null; title = person?.title ?? null;
        if (person?.firstName && !c.firstName) c.firstName = person.firstName;
      } catch (err) { await fail("apollo_enrich_error", { error: String(err) }); continue; }
    }
    if (!email) { await fail("no_email"); continue; }
    if (emailStatus === "guessed" && !ACCEPT_GUESSED) { await fail("apollo_email_guessed"); continue; }
    // v0.41.0: the address may belong to a CRM contact filed under another spelling of the name.
    if (crmConfigured() && email !== c.email) {
      try {
        const byEmail = await crmLookup(null, null, email);
        if (byEmail) { await fail("already_in_crm", { crmId: byEmail.crmId, crmName: byEmail.name, matchedBy: "email", roles: byEmail.roles }); if (leadId != null) await updateLead(leadId, { crm_contact_id: byEmail.crmId }); continue; }
      } catch (err) { s.warnings.push(`crm email check failed for ${c.name}: ${String(err).slice(0, 120)}`); }
    }
    if (!opts.dryRun && leadId != null) await updateLead(leadId, { email, email_status: emailStatus, apollo_id: apolloId, linkedin_url: linkedinUrl, headline, person_title: title });

    // research
    let r: ResearchOut;
    try { r = await researchLawyer(c, lane, ardc, p, Math.min(70_000, Math.max(30_000, remaining() - 50_000))); }
    catch (err) { await fail("research_error", { error: String(err) }); continue; }
    if (r.affinity && !affinityOnList(r.affinity, p.affinities)) {
      log(`${c.name}: affinity "${r.affinity}" is not on the list; dropped to a hook`);
      if (!r.personalization_hooks.some((h) => h.toLowerCase().includes(r.affinity!.toLowerCase().slice(0, 20)))) r.personalization_hooks.unshift(r.affinity);
      r.affinity = null; r.affinity_kind = null;
    }
    if (!opts.dryRun && leadId != null) {
      await updateLead(leadId, { affinity: r.affinity, expert_witness: lane.expertWitness ? r.high_asset_work : null, research: r });
      await logEvent(leadId, "research", `(${r.confidence}) ${r.summary}`.slice(0, 1800), { research: r }, actor);
    }
    if (r.confidence === "low") { await fail("identity_low_confidence"); continue; }

    // draft
    let d: DraftOut;
    try { d = await draftEmail(c, lane, ardc, r, p, 45_000); } catch (err) { await fail("draft_error", { error: String(err) }); continue; }
    const note = briefing(c, lane, ardc, r, emailStatus);
    const cardLabel = eff.label || "Lawyer COI Outreach";

    let delivery = "pending";
    let graph: { id: string; webLink: string | null } | null = null;
    let noteState = "skipped";
    if (opts.dryRun) { delivery = "dry_run"; noteState = "dry_run"; }
    else if (graphConfigured()) {
      try { graph = await createDraft(p.mailbox, email, c.name, d.subject, d.body, lawyerDraftCategories(eff.directiveDnum, cardLabel)); delivery = "outlook_draft"; }
      catch (err) { s.warnings.push(`graph draft failed for ${c.name} (${p.mailbox}): ${String(err).slice(0, 180)}`); }
      if (graph?.id) {
        const n = await postInternalNote(p.mailbox, graph.id, note, `${cardLabel} briefing`);
        noteState = n.ok ? "internal_note" : "note_failed";
        if (!n.ok) s.warnings.push(`internal note not written for ${c.name} (draft IS placed): ${n.error}`);
      }
    }
    if (!opts.dryRun && leadId != null) {
      await logEvent(leadId, "deliver", `draft -> ${email}: ${d.subject}`, {
        delivery, to: email, toName: c.name, mailbox: p.mailbox, subject: d.subject, body: d.body, briefing: note, briefingDelivery: noteState,
        emailStatus, graphMessageId: graph?.id ?? null, graphWebLink: graph?.webLink ?? null, model: MODEL, lane: c.category, band: c.band,
      }, actor);
      let conversationId: string | null = null;
      if (graph?.id) { try { conversationId = await conversationIdOf(p.mailbox, graph.id); } catch (err) { s.warnings.push(`conversation id not read for ${c.name} (no follow-up will be drafted): ${String(err).slice(0, 120)}`); } }
      await updateLead(leadId, { status: "drafted", draft_subject: d.subject, graph_message_id: graph?.id ?? null, conversation_id: conversationId });
    }

    // crm -- only after the draft exists
    let crmState = "skipped";
    if (!opts.dryRun) {
      if (crmConfigured()) {
        try {
          const { crmId, created } = await crmCreateLead(p, lid, c, lane, ardc, r, email, emailStatus, d);
          crmState = created ? `created:${crmId}` : `linked_existing:${crmId}`;
          if (leadId != null) { await updateLead(leadId, { crm_contact_id: crmId }); await logEvent(leadId, "crm", `lead ${created ? "created" : "linked to existing"} ${crmId}`, { crmId, created }, actor); }
        } catch (err) {
          crmState = "error";
          s.warnings.push(`crm failed for ${c.name}: ${String(err).slice(0, 180)}`);
          if (leadId != null) await logEvent(leadId, "crm", `crm error: ${String(err).slice(0, 300)}`, { error: String(err) }, actor);
        }
      } else crmState = "pending_secret";
    } else crmState = "dry_run";

    s.drafted += 1;
    { const f = normFirm(c.firm); if (f && eff.firmSpacingDays > 0) busyFirms.add(f); }
    s.byLane[c.category] = (s.byLane[c.category] ?? 0) + 1;
    s.drafts.push({ leadId: lid, person: c.name, firm: c.firm, lane: c.category, band: c.band, email, emailStatus, subject: d.subject, delivery, crm: crmState });
  }
  if (s.drafted < target && !s.budgetExhausted && s.examined >= Math.min(candidates.length, maxCandidates)) s.candidatesExhausted = true;
  await refreshStale();
  s.elapsedMs = Date.now() - started;
  return s;
}

/** Status for the VistaRandall card / lawyer_status tool. */
export async function lawyerEngineStatus(): Promise<{ totals: Record<string, number>; byLane: Record<string, number>; recent: any[]; lastRun: any | null }> {
  const t = rows<{ status: string; n: number }>(await db.execute(sql`SELECT CASE WHEN status LIKE 'skipped:%' THEN 'skipped' ELSE status END AS status, COUNT(*)::int AS n FROM lawyer_leads GROUP BY 1`));
  const l = rows<{ category: string; n: number }>(await db.execute(sql`SELECT category, COUNT(*)::int AS n FROM lawyer_leads WHERE status = 'drafted' GROUP BY 1`));
  const recent = rows(await db.execute(sql`SELECT id, category, person_name, firm, city, geo_band, email_status, status, draft_subject, crm_contact_id, created_at FROM lawyer_leads ORDER BY created_at DESC LIMIT 15`));
  const last = rows(await db.execute(sql`SELECT kind, detail, created_at FROM lawyer_events WHERE kind IN ('deliver','paused','config_unreachable') ORDER BY created_at DESC LIMIT 1`));
  return {
    totals: Object.fromEntries(t.map((x) => [x.status, x.n])),
    byLane: Object.fromEntries(l.map((x) => [x.category, x.n])),
    recent, lastRun: last[0] ?? null,
  };
}
