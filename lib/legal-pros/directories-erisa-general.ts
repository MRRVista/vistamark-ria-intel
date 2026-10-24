/**
 * legal-pros · directories-erisa-general — ERISA / general attorney directories + ARDC verification.
 *
 *   acebc_fellow_search    — American College of Employee Benefits Counsel "Find a Fellow" (acebc.com, GET, no key)
 *   leading_lawyers_search — Leading Lawyers (leadinglawyers.com) peer-recommended IL/MI/MO directory,
 *                            practice area × city/county/zip (ColdFusion form POST, no key)
 *   ardc_lawyer_lookup     — Illinois ARDC Lawyer Search (iardc.org) — registration status, admission date,
 *                            registered firm/address/phone, malpractice-insurance and public-discipline flags
 *                            (ASP.NET MVC anti-forgery POST → AJAX grid → details, no key)
 *
 * All three are public directory / registry records, NOT consent to contact. Only professional/firm contact
 * details are returned. Each response cites dataSource + asOf so Randall can attribute the record.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { politeFetch, redactUrl } from "../data/http";
import {
  BROWSER_UA,
  HOUR,
  cached,
  clampInt,
  decodeEntities,
  fetchWithBackoff,
  stripTags,
  textWithBackoff,
  trim,
} from "../web-intel/common";

const TIMEOUT_MS = 25_000;
const today = () => new Date().toISOString().slice(0, 10);

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
function lc(s: unknown): string {
  return norm(s).toLowerCase();
}
function contains(hay: unknown, needle: unknown): boolean {
  const n = lc(needle);
  return !n || lc(hay).includes(n);
}
function toIsoDay(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/** POST a form (x-www-form-urlencoded) with a browser UA; one network-error retry; non-OK → Error. */
async function postForm(
  url: string,
  fields: Record<string, string>,
  opts: { source: string; headers?: Record<string, string>; timeoutMs?: number },
): Promise<Response> {
  const body = new URLSearchParams(fields).toString();
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "Content-Type": "application/x-www-form-urlencoded",
    ...(opts.headers ?? {}),
  };
  const init = { method: "POST", body, headers, retries: 0, timeoutMs: opts.timeoutMs ?? TIMEOUT_MS } as const;
  let res: Response;
  try {
    res = await politeFetch(url, init);
  } catch {
    await new Promise((r) => setTimeout(r, 600));
    res = await politeFetch(url, init);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ");
    const cfErr = text.match(/coldfusion\.[\w.]+Exception[^<]{0,160}/i)?.[0];
    throw new Error(
      `${opts.source} HTTP ${res.status} from ${redactUrl(url)}${cfErr ? ` — ${cfErr}` : `: ${text.slice(0, 160)}`}`,
    );
  }
  return res;
}

/* ────────────────────────────────────────────────────────────────────────────────
 * ACEBC — American College of Employee Benefits Counsel
 * GET https://www.acebc.com/fellows?fullname=&state=IL&topics=&is_speaker=1&search-submit=Search
 * Results: <table id="search-results"> rows: column1 (name link + status badges), column2 "City, ST",
 * column3 "Topic | Expert Witness | Mediator | Speaker<br />..." (self-designated availability).
 * No paging (IL = 36 rows, all-fellows directory page = 583 rows, 2026-10-24). Profile pages carry only a bio.
 * ──────────────────────────────────────────────────────────────────────────────── */

const ACEBC_BASE = "https://www.acebc.com";
const ACEBC_TOPICS: Record<string, string> = {
  "1": "DB Plans",
  "2": "DC Plans",
  "3": "IRAs",
  "4": "Exempt/Governmental Plans",
  "5": "Multiemployer Plans",
  "6": "Health and Welfare Plans",
  "7": "Fiduciary/Other Title I Issues",
  "8": "IRC Issues",
  "9": "PBGC Issues",
  "10": "Executive Compensation",
  "11": "Fringe Benefits",
  "12": "Actuarial Issues",
};
const ACEBC_STATUS: Record<string, string> = {
  H: "Honorary Fellow",
  CF: "Charter Fellow",
  F: "Fellow",
  E: "Emeritus Fellow",
  M: "In Memoriam",
  D: "Deceased",
};

interface AcebcRow {
  name: string;
  lastName: string;
  city: string | null;
  state: string | null;
  membership: string[];
  availability: Array<{ topic: string; roles: string[] }>;
  profileUrl: string | null;
}

function parseAcebc(html: string): AcebcRow[] {
  const table = html.match(/<table[^>]*id="search-results"[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) return [];
  const rows: AcebcRow[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(table))) {
    const tr = m[1]!;
    const c1 = tr.match(/<td class="column1"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    const c2 = tr.match(/<td class="column2"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    const c3 = tr.match(/<td class="column3"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    const link = c1.match(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)(?:<\/a>|<div)/i);
    if (!link) continue;
    const rawName = stripTags(link[2]!);
    if (!rawName) continue;
    const badges = [...c1.matchAll(/<span>\s*([A-Z]{1,2})\s*<\/span>/g)].map((b) => b[1]!);
    const loc = stripTags(c2);
    const locM = loc.match(/^(.*?),\s*([A-Z]{2})$/);
    const availability: Array<{ topic: string; roles: string[] }> = [];
    for (const line of c3.split(/<br\s*\/?>/i)) {
      const t = stripTags(line);
      if (!t) continue;
      const parts = t.split("|").map((p) => p.trim()).filter(Boolean);
      availability.push({ topic: parts[0]!, roles: parts.slice(1) });
    }
    // Directory lists "Last, First Middle"; present as "First Middle Last".
    const comma = rawName.indexOf(",");
    const lastName = comma > 0 ? rawName.slice(0, comma).trim() : rawName.split(" ").pop()!;
    const display = comma > 0 ? `${rawName.slice(comma + 1).trim()} ${lastName}`.replace(/\s+/g, " ").trim() : rawName;
    rows.push({
      name: display,
      lastName,
      city: locM ? locM[1]!.trim() : loc || null,
      state: locM ? locM[2]! : null,
      membership: badges.map((b) => ACEBC_STATUS[b] ?? b),
      availability,
      profileUrl: decodeEntities(link[1]!),
    });
  }
  return rows;
}

export async function acebcFellowSearch(args: any = {}) {
  const state = args.state ? String(args.state).trim().toUpperCase() : "";
  const name = norm(args.name);
  const city = norm(args.city);
  const topic = args.topic != null ? String(args.topic).trim() : "";
  const topicId = topic
    ? Object.entries(ACEBC_TOPICS).find(([id, label]) => id === topic || lc(label) === lc(topic) || lc(label).includes(lc(topic)))?.[0]
    : undefined;
  if (topic && !topicId) {
    throw new Error(`Unknown ACEBC topic '${topic}'. Use one of: ${Object.values(ACEBC_TOPICS).join("; ")}`);
  }
  if (!state && !name && !city) {
    throw new Error("acebc_fellow_search needs state (e.g. 'IL'), city or name — the full 580+ fellow roll is not returned unfiltered.");
  }
  const includeInactive = args.includeInactive === true;
  const limit = clampInt(args.limit, 25, 1, 100);

  const qs = new URLSearchParams();
  qs.set("fullname", name);
  qs.set("state", state);
  qs.set("topics", topicId ?? "");
  if (args.expertWitness) qs.set("is_expert_witness", "1");
  if (args.mediator) qs.set("is_mediator", "1");
  if (args.speaker) qs.set("is_speaker", "1");
  qs.set("search-submit", "Search");
  const url = `${ACEBC_BASE}/fellows?${qs.toString()}`;

  const html = await cached(`legalpros:acebc:${url}`, 12 * HOUR, () =>
    textWithBackoff(url, { source: "ACEBC fellows directory", headers: { "User-Agent": BROWSER_UA, Accept: "text/html" }, timeoutMs: TIMEOUT_MS }),
  );
  let rows = parseAcebc(html);
  const total = rows.length;
  if (city) rows = rows.filter((r) => contains(r.city, city));
  if (!includeInactive) rows = rows.filter((r) => !r.membership.some((m) => m === "Deceased" || m === "In Memoriam"));
  const matched = rows.length;

  return {
    dataSource: "American College of Employee Benefits Counsel (ACEBC) Fellows directory, acebc.com (public, live)",
    asOf: today(),
    query: { state: state || null, city: city || null, name: name || null, topic: topicId ? ACEBC_TOPICS[topicId] : null },
    returned: Math.min(matched, limit),
    total: matched,
    rows: rows.slice(0, limit).map((r) => ({
      name: r.name,
      city: r.city,
      state: r.state,
      practiceAreas: ["Employee Benefits / ERISA"],
      membership: r.membership,
      availability: r.availability.length ? r.availability.map((a) => (a.roles.length ? `${a.topic}: ${a.roles.join(", ")}` : a.topic)) : undefined,
      profileUrl: r.profileUrl,
      source: "ACEBC",
    })),
    note:
      `${total} fellows matched upstream${city ? `, ${matched} after city filter` : ""}. ACEBC fellows have 20+ years in employee-benefits law; ` +
      "the directory publishes name, city/state, membership status and self-designated expert-witness/mediator/speaker topics only — " +
      "no firm, phone or email (take the firm from ardc_lawyer_lookup or leading_lawyers_search). Public directory record, not consent to contact; " +
      "describe as 'listed in the ACEBC fellows directory'.",
  };
}

/* ────────────────────────────────────────────────────────────────────────────────
 * Leading Lawyers — https://www.leadinglawyers.com/search/search_results.cfm (ColdFusion, form POST).
 * Form fields (ALL must be present or CF throws "Element COUNTYIL is undefined in FORM" → 500):
 *   aol (practice area label, exact text of the <option value>), state (IL|MI|MO), cityDefault, cityIL, cityMI, cityMO,
 *   zip, countyDefault, countyIL, countyMO, countyMI, LL=on (Leading Lawyers), EL=on (Emerging Lawyers), search_type.
 * The response is a single page (no server paging; 338 rows for Family Law × Chicago came back in one 250 KB page).
 * Rows: <li><a href="../atty_profile.cfm?TOCUID=…">Name</a></li> (members, with phone/email/website/firm/sub-areas)
 *       or <li><strong>Name</strong></li> (non-members: name, city, firm, practice areas only). Members listed first.
 * Order within groups is random by design ("in no way a ranking").
 * ──────────────────────────────────────────────────────────────────────────────── */

const LL_BASE = "https://www.leadinglawyers.com";
const LL_RESULTS = `${LL_BASE}/search/search_results.cfm`;

/** Preset → exact Leading Lawyers "aol" option value (personal or business form). */
export const LL_PRESETS: Record<string, { aol: string; form: "personal" | "business" }> = {
  estate: { aol: "Trust, Will & Estate Planning Law", form: "personal" },
  tax_individual: { aol: "Tax Law: Individual", form: "personal" },
  tax_business: { aol: "Tax Law: Business", form: "business" },
  employee_benefits: { aol: "Employee Benefits Law", form: "business" },
  family: { aol: "Family Law", form: "personal" },
  family_appellate: { aol: "Family Appellate Law", form: "personal" },
  adr_family: { aol: "ADR Law: Family", form: "personal" },
  adoption: { aol: "Adoption & Reproductive Technology Law", form: "personal" },
  elder: { aol: "Elder Law", form: "personal" },
  closely_held: { aol: "Closely & Privately Held Business Law", form: "business" },
  nonprofit: { aol: "Association Non-Profit Law", form: "business" },
  real_estate_residential: { aol: "Real Estate Law: Residential", form: "personal" },
  securities: { aol: "Securities & Venture Finance Law", form: "business" },
  banking: { aol: "Banking & Financial Institutions Law", form: "business" },
  ma: { aol: "Mergers & Acquisitions Law", form: "business" },
};

interface LlRow {
  name: string;
  member: boolean;
  tier: "Leading Lawyer" | "Emerging Lawyer" | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  firm: string | null;
  website: string | null;
  practiceAreas: string[];
  focus: string[];
  profileUrl: string | null;
}

function parseLeadingLawyers(html: string): { rows: LlRow[]; total: number | null } {
  // Start at the first group banner (LLlogo/ELlogo) so the nav <li>s are excluded and the first banner is seen.
  const start = html.search(/images\/(LL|EL)logo\.png/);
  const body = html.slice(start >= 0 ? Math.max(0, html.lastIndexOf("<", start)) : 0);
  const total = (() => {
    const m = html.replace(/\s+/g, " ").match(/Results:\s*<b>\s*\d+\s*(?:&nbsp;|\s)*-\s*(?:&nbsp;|\s)*\d+\s*<\/b>\s*of\s*<strong>\s*(\d+)/i);
    if (m) return Number(m[1]);
    if (/Results:\s*0(?:&nbsp;|\s)*-(?:&nbsp;|\s)*0/i.test(html)) return 0;
    return null;
  })();
  // Split on result <li>; nav <li>s all precede "Members:" / first result table.
  const chunks = body.split(/(?=<li>)/).slice(1);
  const rows: LlRow[] = [];
  let tier: LlRow["tier"] = null;
  // Group banners: LLlogo.png precedes Leading Lawyers groups, ELlogo.png precedes Emerging Lawyers.
  const bannerPositions: Array<{ at: number; tier: LlRow["tier"] }> = [];
  for (const bm of body.matchAll(/images\/(LL|EL)logo\.png/g)) bannerPositions.push({ at: bm.index!, tier: bm[1] === "EL" ? "Emerging Lawyer" : "Leading Lawyer" });
  let cursor = 0;
  for (const chunk of chunks) {
    const at = body.indexOf(chunk, cursor);
    cursor = at + 1;
    for (const b of bannerPositions) if (b.at < at) tier = b.tier;

    const head = chunk.match(/^<li>([\s\S]*?)<\/li>/i)?.[1] ?? "";
    const link = head.match(/<a\s+href="([^"]+)"[^>]*>/i);
    const name = stripTags(head);
    if (!name || /^(Find a Lawyer|Selection Process|Legal Help Desk|Member Login|Advisory Board|About Us)$/i.test(name)) continue;

    // Everything up to the next group banner / end belongs to this lawyer.
    const seg = chunk.replace(/<table width="100%" border="0" cellspacing="0" cellpadding="0">\s*<TR><td\s+valign="top" bgcolor[\s\S]*$/i, "");
    const navyCells = [...seg.matchAll(/<font face='Arial' size ='2' color='navy'>([\s\S]*?)<\/font>/gi)].map((c) => stripTags(c[1]!));
    const city = navyCells.find((c) => c && !/^\(?\d{3}\)?[\s.-]?\d{3}/.test(c) && !/^www\.|^https?:/i.test(c)) ?? null;
    const phone = seg.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}/)?.[0]?.trim() ?? null;
    const email = seg.match(/mailto:([^'"]+)/i)?.[1]?.trim() ?? null;
    const website = seg.match(/<a href='(https?:\/\/[^']+)'>/i)?.[1] ?? null;
    const firm = seg.match(/colspan='3'><font face='Arial' size ='2'>([\s\S]*?)<\/font>/i)?.[1];
    const maroon = seg.match(/color='maroon'>([\s\S]*?)<\/font>/i)?.[1] ?? "";
    const practiceAreas = maroon.split(/<br\s*\/?>/i).map((s) => stripTags(s)).filter(Boolean);
    const focusBlock = seg.match(/nowrap width='300'><font face='Arial' size ='1'>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    const focus = focusBlock.split(/<br\s*\/?>/i).map((s) => stripTags(s)).filter(Boolean);

    rows.push({
      name,
      member: !!link,
      tier,
      city: city ? trim(city, 60) : null,
      phone,
      email,
      firm: firm ? stripTags(firm) || null : null,
      website: website ? decodeEntities(website) : null,
      practiceAreas,
      focus,
      profileUrl: link ? `${LL_BASE}/${decodeEntities(link[1]!).replace(/^(\.\.\/)+/, "")}` : null,
    });
  }
  return { rows, total };
}

export async function leadingLawyersSearch(args: any = {}) {
  const presetKey = args.practiceArea ? String(args.practiceArea).trim() : "";
  const preset = presetKey ? LL_PRESETS[presetKey] : undefined;
  const aolFree = norm(args.aol);
  if (presetKey && !preset && !aolFree) {
    throw new Error(`Unknown practiceArea preset '${presetKey}'. Presets: ${Object.keys(LL_PRESETS).join(", ")} — or pass aol with the exact Leading Lawyers category text.`);
  }
  const aol = preset?.aol ?? aolFree;
  if (!aol) throw new Error("leading_lawyers_search requires practiceArea (preset) or aol (exact Leading Lawyers category text, e.g. 'Employee Benefits Law').");

  const state = (args.state ? String(args.state) : "IL").trim().toUpperCase();
  if (!["IL", "MI", "MO"].includes(state)) throw new Error("Leading Lawyers covers Illinois, Michigan and Missouri only (state IL|MI|MO).");
  const city = norm(args.city);
  const county = norm(args.county);
  const zip = norm(args.zip);
  if (!city && !county && !zip) {
    throw new Error("leading_lawyers_search needs a geography: city (e.g. 'Hinsdale', 'Chicago'), county (e.g. 'DuPage', 'Cook') or zip. Statewide dumps are refused.");
  }
  const tierArg = args.tier ? String(args.tier).toLowerCase() : "both";
  const limit = clampInt(args.limit, 25, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 5000);
  const nameFilter = norm(args.name);
  const firmFilter = norm(args.firm);
  const membersOnly = args.membersOnly === true;

  const titleCity = city.replace(/\b\w/g, (c) => c.toUpperCase()); // option values are Title Case ("Oak Brook", "La Grange")
  const fields: Record<string, string> = {
    aol,
    state,
    cityDefault: "",
    cityIL: state === "IL" ? titleCity : "",
    cityMI: state === "MI" ? titleCity : "",
    cityMO: state === "MO" ? titleCity : "",
    zip,
    countyDefault: "",
    countyIL: state === "IL" ? county : "",
    countyMO: state === "MO" ? county : "",
    countyMI: state === "MI" ? county : "",
    search_type: preset?.form ?? "personal",
  };
  if (tierArg !== "emerging") fields.LL = "on";
  if (tierArg !== "leading") fields.EL = "on";

  const key = `legalpros:ll:${JSON.stringify(fields)}`;
  const html = await cached(key, 12 * HOUR, async () => {
    const res = await postForm(LL_RESULTS, fields, { source: "Leading Lawyers", headers: { Referer: `${LL_BASE}/search/search_${fields.search_type}.cfm` } });
    return res.text();
  });
  const parsed = parseLeadingLawyers(html);
  let rows = parsed.rows;
  if (nameFilter) rows = rows.filter((r) => contains(r.name, nameFilter));
  if (firmFilter) rows = rows.filter((r) => contains(r.firm, firmFilter));
  if (membersOnly) rows = rows.filter((r) => r.member);
  const matched = rows.length;
  const page = rows.slice(offset, offset + limit);

  return {
    dataSource: "Leading Lawyers (leadinglawyers.com) — peer-recommended attorney directory, IL/MI/MO (public, live)",
    asOf: today(),
    query: { practiceArea: aol, state, city: city || null, county: county || null, zip: zip || null, tier: tierArg },
    returned: page.length,
    total: matched,
    upstreamTotal: parsed.total,
    offset,
    rows: page.map((r) => ({
      name: r.name,
      firm: r.firm,
      city: r.city,
      state,
      practiceAreas: r.practiceAreas,
      focus: r.focus.length ? r.focus : undefined,
      phone: r.phone,
      email: r.email,
      website: r.website,
      tier: r.tier,
      profile: r.member ? "member (full profile)" : "listed (basic)",
      profileUrl: r.profileUrl,
      source: "Leading Lawyers",
    })),
    note:
      `Leading Lawyers = top ~5% of lawyers in the state by peer survey; Emerging Lawyers = under-40/≤10-yr peers (~2%). Order within each group is random (not a ranking). ` +
      `Phone/email/website appear only for paying member profiles. Verify licence status with ardc_lawyer_lookup before any referral. ` +
      `Public directory record, not consent to contact; cite as 'listed in Leading Lawyers (${today()})'.`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────────
 * ARDC — Illinois Attorney Registration & Disciplinary Commission Lawyer Search (ASP.NET MVC, anti-forgery).
 *   1. GET  /Lawyer/Search            → cookie __RequestVerificationToken + form token (in #lawyer-search-form)
 *   2. POST /Lawyer/SearchResults     → page whose inline script carries PageKey (GUID) and enum ints
 *   3. POST /Lawyer/SearchGrid?rows=N → mvc-grid HTML table (Name | City | State | Date Admitted | Authorized To Practice),
 *                                       data-total-results, data-id GUID per row. rows ≤100, page=N.
 *   4. POST /Lawyer/Details {id}      → modal: registered address (firm line 1), phone, email, admitted, status,
 *                                       malpractice-insurance statement, public discipline list.
 *      (GET /Lawyer/PrintableDetails/{id}?includeFormerNames=False returns the same content without cookies.)
 * Enum ints on the grid POST: LastNameMatch 0=Exact 1=Phonetic; Status 0=AuthorizedToPractice 1=All;
 * StatusChangeTimeFrame 0=Last30Days; BusinessLocation 0=All.
 * ──────────────────────────────────────────────────────────────────────────────── */

const ARDC_BASE = "https://www.iardc.org";

function cookieHeader(res: Response, prev = ""): string {
  const set = (res.headers as any).getSetCookie?.() as string[] | undefined;
  const raw = set && set.length ? set : [res.headers.get("set-cookie") ?? ""];
  const jar = new Map<string, string>();
  for (const kv of prev.split(";")) {
    const [k, v] = kv.split("=");
    if (k && v) jar.set(k.trim(), v.trim());
  }
  for (const line of raw) {
    for (const part of line.split(/,(?=[^;,]+=)/)) {
      const first = part.split(";")[0]?.trim();
      const eq = first?.indexOf("=") ?? -1;
      if (first && eq > 0) jar.set(first.slice(0, eq), first.slice(eq + 1));
    }
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

interface ArdcSession {
  cookie: string;
  formToken: string;
}

async function ardcSession(): Promise<ArdcSession> {
  const res = await fetchWithBackoff(`${ARDC_BASE}/Lawyer/Search`, {
    source: "ARDC Lawyer Search",
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    timeoutMs: TIMEOUT_MS,
  });
  const html = await res.text();
  const form = html.match(/<form[^>]*id="lawyer-search-form"[^>]*>([\s\S]*?)<\/form>/i)?.[1] ?? html;
  const formToken = form.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1];
  if (!formToken) throw new Error("ARDC Lawyer Search page did not contain an anti-forgery token — the form may have changed (check https://www.iardc.org/Lawyer/Search).");
  return { cookie: cookieHeader(res), formToken };
}

interface ArdcGridRow {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  dateAdmitted: string | null;
  authorizedToPractice: boolean | null;
}

function parseArdcGrid(html: string): { rows: ArdcGridRow[]; total: number | null } {
  const total = html.match(/data-total-results",\s*(\d+)/)?.[1];
  const rows: ArdcGridRow[] = [];
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  for (const tr of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!);
    if (cells.length < 7) continue;
    const id = tr[1]!.match(/data-id='([0-9a-f-]{36})'/i)?.[1] ?? stripTags(cells[0]!);
    rows.push({
      id,
      name: stripTags(cells[2]!),
      city: stripTags(cells[3]!) || null,
      state: stripTags(cells[4]!) || null,
      dateAdmitted: toIsoDay(stripTags(cells[5]!) || null),
      authorizedToPractice: /^yes$/i.test(stripTags(cells[6]!)) ? true : /^no$/i.test(stripTags(cells[6]!)) ? false : null,
    });
  }
  return { rows, total: total ? Number(total) : null };
}

interface ArdcDetail {
  fullLicensedName: string | null;
  firm: string | null;
  addressLines: string[];
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  dateAdmitted: string | null;
  status: string | null;
  malpracticeInsurance: boolean | null;
  malpracticeStatement: string | null;
  discipline: string[];
  asOf: string | null;
}

function parseArdcDetail(html: string): ArdcDetail {
  const field = (label: string): string | null => {
    const re = new RegExp(`<label[^>]*>\\s*${label}\\s*</label>\\s*<div[^>]*>\\s*(?:<p[^>]*>|<div[^>]*>)([\\s\\S]*?)</(?:p|div)>`, "i");
    const m = html.match(re);
    return m ? m[1]! : null;
  };
  const vfield = (label: string): string | null => {
    const re = new RegExp(`<p class="form-control-static">\\s*${label}\\s*</p>\\s*</div>\\s*<div[^>]*>\\s*<p[^>]*>([\\s\\S]*?)</p>`, "i");
    return html.match(re)?.[1] ?? null;
  };
  // Address block: <label>Registered Address</label><div class="col-xs-9"><div class="form-control-static"><div>line</div>…</div></div>
  const addrRaw = html.match(/Registered Address\s*<\/label>([\s\S]*?)<label/i)?.[1] ?? "";
  const addressLines = [...addrRaw.matchAll(/<div>([\s\S]*?)<\/div>/g)].map((d) => stripTags(d[1]!)).filter(Boolean);
  const last = addressLines[addressLines.length - 1] ?? "";
  const csz = last.match(/^(.*?),\s*([A-Za-z .]+?)\s+(\d{5}(?:-\d{4})?)$/);
  const streetIdx = addressLines.findIndex((l) => /^\d/.test(l) || /\b(P\.?O\.? Box|Suite|Floor|Street|Avenue|Ave\b|St\b|Blvd|Drive|Dr\b|Road|Rd\b|Plaza)\b/i.test(l));
  const firm = addressLines.length > 1 && streetIdx !== 0 ? addressLines[0]! : null;
  const phoneRaw = stripTags(field("Registered Phone") ?? "");
  const emailRaw = stripTags(field("Registered Email") ?? "");
  const malStmt = vfield("Malpractice Insurance");
  const malText = malStmt ? stripTags(malStmt) : null;
  const discBlock = html.match(/Public Record of Discipline and Pending Proceedings[\s\S]*?<div class="panel-body">([\s\S]*?)<\/div>\s*<div class="cases-footer">/i)?.[1] ?? "";
  const discipline = [...discBlock.matchAll(/<(?:p|li|a)\b[^>]*>([\s\S]*?)<\/(?:p|li|a)>/gi)].map((d) => stripTags(d[1]!)).filter((t) => t && !/^none$/i.test(t));
  return {
    fullLicensedName: stripTags(field("Full Licensed Name") ?? "") || null,
    firm,
    addressLines,
    city: csz ? csz[1]!.trim() : null,
    state: csz ? csz[2]!.trim() : null,
    zip: csz ? csz[3]! : null,
    phone: phoneRaw && !/not available/i.test(phoneRaw) ? phoneRaw : null,
    email: emailRaw && !/not available/i.test(emailRaw) ? emailRaw : null,
    dateAdmitted: toIsoDay(stripTags(vfield("Date Admitted") ?? "") || null),
    status: stripTags(vfield("Illinois Registration Status") ?? "") || null,
    malpracticeInsurance: malText ? (/does not|no malpractice|not maintain/i.test(malText) ? false : /maintains malpractice insurance/i.test(malText) ? true : null) : null,
    malpracticeStatement: malText ? trim(malText, 160) : null,
    discipline,
    asOf: html.match(/as of\s+([\d/]+\s+[\d:]+\s*[AP]M)/i)?.[1] ?? null,
  };
}

export async function ardcLawyerLookup(args: any = {}) {
  const lastName = norm(args.lastName);
  const firstName = norm(args.firstName);
  const city = norm(args.city);
  if (!lastName) throw new Error("ardc_lawyer_lookup requires lastName (plus optional firstName, city, county). ARDC does not support practice-area or firm search.");
  const phonetic = args.phonetic === true;
  const authorizedOnly = args.authorizedOnly !== false; // default true
  const county = norm(args.county);
  const limit = clampInt(args.limit, 25, 1, 100);
  const detailMax = clampInt(args.detailLimit, 5, 0, 10);
  const includeDetails = args.includeDetails !== false;

  const key = `legalpros:ardc:${JSON.stringify({ lastName, firstName, city, county, phonetic, authorizedOnly, limit })}`;
  const grid = await cached(key, 6 * HOUR, async () => {
    const s = await ardcSession();
    // Step 2: SearchResults page → PageKey + fresh form token for the grid POST.
    const resultsRes = await postForm(
      `${ARDC_BASE}/Lawyer/SearchResults`,
      {
        __RequestVerificationToken: s.formToken,
        IsRecentSearch: "False",
        IncludeFormerNames: "false",
        LastName: lastName,
        LastNameMatch: phonetic ? "Phonetic" : "Exact",
        FirstName: firstName,
        Status: authorizedOnly ? "AuthorizedToPractice" : "All",
        LawyerCounty: county,
        City: city,
        State: "",
        Country: "",
        StatusChangeTimeFrame: "Last30Days",
        BusinessLocation: "All",
        County: "",
        JudicialCircuit: "",
        JudicialDistrict: "",
        StatusLastName: "",
      },
      { source: "ARDC Lawyer Search", headers: { Cookie: s.cookie, Referer: `${ARDC_BASE}/Lawyer/Search` } },
    );
    const cookie = cookieHeader(resultsRes, s.cookie);
    const resultsHtml = await resultsRes.text();
    const pageKey = resultsHtml.match(/PageKey:\s*"([0-9a-f-]{36})"/i)?.[1];
    const gridToken = resultsHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1] ?? s.formToken;
    if (!pageKey) {
      const err = stripTags(resultsHtml.match(/<div id="error"[\s\S]*?<\/div>/i)?.[0] ?? "").slice(0, 160);
      throw new Error(`ARDC SearchResults page did not yield a PageKey${err ? ` (${err})` : ""} — form shape may have changed.`);
    }
    // Step 3: grid.
    const gridRes = await postForm(
      `${ARDC_BASE}/Lawyer/SearchGrid?rows=${limit}&page=1`,
      {
        PageKey: pageKey,
        LastName: lastName,
        StatusLastName: "",
        LastNameMatch: phonetic ? "1" : "0",
        IncludeFormerNames: "false",
        FirstName: firstName,
        Status: authorizedOnly ? "0" : "1",
        City: city,
        State: "",
        Country: "",
        StatusChangeTimeFrame: "0",
        BusinessLocation: "0",
        County: "",
        LawyerCounty: county,
        JudicialCircuit: "",
        JudicialDistrict: "",
        IsRecentSearch: "false",
        __RequestVerificationToken: gridToken,
      },
      { source: "ARDC Lawyer Search grid", headers: { Cookie: cookie, Referer: `${ARDC_BASE}/Lawyer/SearchResults`, "X-Requested-With": "XMLHttpRequest" } },
    );
    const parsed = parseArdcGrid(await gridRes.text());
    return { ...parsed, cookie, token: gridToken };
  });

  const rows = grid.rows.slice(0, limit);
  const details = new Map<string, ArdcDetail>();
  if (includeDetails && rows.length) {
    const want = rows.slice(0, Math.min(detailMax, rows.length));
    for (const r of want) {
      try {
        const d = await cached(`legalpros:ardc:detail:${r.id}`, 24 * HOUR, async () => {
          const res = await postForm(
            `${ARDC_BASE}/Lawyer/Details`,
            { id: r.id, includeFormerNames: "false", __RequestVerificationToken: grid.token },
            { source: "ARDC lawyer details", headers: { Cookie: grid.cookie, Referer: `${ARDC_BASE}/Lawyer/SearchResults`, "X-Requested-With": "XMLHttpRequest" } },
          );
          return parseArdcDetail(await res.text());
        });
        details.set(r.id, d);
      } catch {
        // Details are best-effort; the grid row still carries status + admission date.
      }
    }
  }

  return {
    dataSource: "Illinois ARDC Lawyer Search (iardc.org) — Supreme Court of Illinois attorney registration & discipline records (public, live)",
    asOf: today(),
    query: { lastName, firstName: firstName || null, city: city || null, county: county || null, match: phonetic ? "phonetic" : "exact", status: authorizedOnly ? "authorized to practice" : "all" },
    returned: rows.length,
    total: grid.total,
    rows: rows.map((r) => {
      const d = details.get(r.id);
      return {
        name: d?.fullLicensedName ?? r.name,
        firm: d?.firm ?? null,
        city: d?.city ?? r.city,
        state: d?.state ?? r.state,
        zip: d?.zip ?? null,
        phone: d?.phone ?? null,
        email: d?.email ?? null,
        dateAdmitted: d?.dateAdmitted ?? r.dateAdmitted,
        authorizedToPractice: r.authorizedToPractice,
        status: d?.status ?? (r.authorizedToPractice ? "Authorized to practice (grid)" : r.authorizedToPractice === false ? "Not authorized (grid)" : null),
        malpracticeInsurance: d ? d.malpracticeInsurance : undefined,
        disciplineFlag: d ? d.discipline.length > 0 : undefined,
        discipline: d && d.discipline.length ? d.discipline.map((x) => trim(x, 160)) : undefined,
        detail: d ? "loaded" : includeDetails ? "not loaded (detailLimit)" : "skipped",
        profileUrl: `${ARDC_BASE}/Lawyer/PrintableDetails/${r.id}?includeFormerNames=False`,
        source: "ARDC",
      };
    }),
    note:
      `ARDC is the verification source for Illinois attorneys (IDFPR does not license lawyers). Grid rows carry status + admission date; ` +
      `firm/address/phone/discipline come from the details call (first ${detailMax} rows; raise detailLimit ≤10 or narrow with firstName/city). ` +
      `Registered address/phone are the attorney's business registration — professional contact only. Registration changes post next business day. ` +
      `Discipline shown is public record only; investigations are confidential. Not consent to contact.`,
  };
}

/* ──────────────────────────────────────────────────────────────────────────────── */

export const ERISAGENERAL_TOOLS: ToolDef[] = [
  {
    name: "acebc_fellow_search",
    description:
      `American College of Employee Benefits Counsel (ACEBC) "Find a Fellow" directory (acebc.com, live, no key): the ~580 invited fellows nationwide (36 in Illinois) with 20+ years in ERISA / employee-benefits law — the credential tier for ERISA counsel. Returns name, city/state, membership status (Fellow, Charter, Emeritus, Honorary), self-designated expert-witness / mediator / speaker topics (${Object.values(ACEBC_TOPICS).join(", ")}) and profile URL. Filter by state (e.g. 'IL'), city (client-side, e.g. 'Chicago'), name, topic, expertWitness/mediator/speaker. No firm, phone or email is published — chain to ardc_lawyer_lookup (lastName + firstName) for the registered firm and phone, or leading_lawyers_search for a profile. Use for: identifying senior ERISA counsel serving 401(k)/DB sponsors as referral partners for Vistamark's fiduciary-consulting work. Public directory record, not consent to contact; cite 'listed in the ACEBC fellows directory'.`,
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "2-letter state, e.g. IL (default none; one of state/city/name required)." },
        city: { type: "string", description: "City substring, applied client-side (e.g. Chicago, Oak Brook)." },
        name: { type: "string", description: "Name fragment (upstream fullname search)." },
        topic: { type: "string", description: "Expertise topic label or id 1-12, e.g. 'DC Plans', 'Fiduciary/Other Title I Issues', 'Executive Compensation'." },
        expertWitness: { type: "boolean" },
        mediator: { type: "boolean" },
        speaker: { type: "boolean" },
        includeInactive: { type: "boolean", default: false, description: "Keep Deceased / In Memoriam entries." },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: acebcFellowSearch,
  },
  {
    name: "leading_lawyers_search",
    description:
      `Leading Lawyers (leadinglawyers.com, live, no key): Illinois peer-recommended attorney directory (also MI, MO) — Leading Lawyers = top ~5% by statewide peer survey, Emerging Lawyers = top ~2% under 40. Search practice area × geography: practiceArea preset (${Object.keys(LL_PRESETS).join(", ")}) or aol = exact Leading Lawyers category text (e.g. 'Employee Benefits Law', 'Trust, Will & Estate Planning Law', 'Tax Law: Individual', 'Family Law', 'Elder Law'); geography = city (Leading Lawyers spelling, e.g. Hinsdale, Oak Brook, Chicago, La Grange), county (DuPage, Cook, Lake, Will) or zip. Returns name, firm, city, practice areas, tier (Leading/Emerging), and for member profiles phone, firm email, website, focus statements and profile URL (TOCUID). Optional name/firm substring filters, membersOnly, tier (leading|emerging|both), offset for paging (whole result set is fetched once and cached 12 h; Family Law × Chicago ≈ 340 rows, Employee Benefits × Chicago ≈ 86, Trust & Estate × DuPage ≈ 48). Order within tiers is random by design, not a ranking. Verify with ardc_lawyer_lookup before referring. Public directory record, not consent to contact; cite 'listed in Leading Lawyers'.`,
    inputSchema: {
      type: "object",
      properties: {
        practiceArea: { type: "string", enum: Object.keys(LL_PRESETS), description: "Preset practice area." },
        aol: { type: "string", description: "Exact Leading Lawyers category text when no preset fits (e.g. 'Health Law'). Business-form categories need aol only; search_type is inferred for presets." },
        state: { type: "string", enum: ["IL", "MI", "MO"], default: "IL" },
        city: { type: "string", description: "City name as Leading Lawyers spells it (Title Case applied automatically)." },
        county: { type: "string", description: "County name, e.g. DuPage, Cook, Lake, Will, Kane, McHenry." },
        zip: { type: "string", description: "5-digit zip (business address)." },
        tier: { type: "string", enum: ["leading", "emerging", "both"], default: "both" },
        membersOnly: { type: "boolean", default: false, description: "Only paid member profiles (these carry phone/email/website)." },
        name: { type: "string", description: "Client-side name substring." },
        firm: { type: "string", description: "Client-side firm substring." },
        limit: { type: "number", default: 25, maximum: 100 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: leadingLawyersSearch,
  },
  {
    name: "ardc_lawyer_lookup",
    description:
      "Illinois ARDC Lawyer Search (iardc.org, live, no key) — THE verification source for Illinois attorneys (lawyers are not in IDFPR / idfpr_licensee_search). Look up by lastName (exact, or phonetic:true) + optional firstName, city, county. Returns per lawyer: full licensed name, Illinois registration status (e.g. 'Active and authorized to practice law'), authorizedToPractice, date admitted, registered firm (first line of the registered business address), city/state/zip, registered phone and email when the attorney published them, malpracticeInsurance (self-reported in annual registration), disciplineFlag + public discipline / pending-proceeding entries, and a printable profile URL. Grid rows (up to limit ≤100) always carry status + admission date; firm/phone/discipline require a per-lawyer details call and are loaded for the first detailLimit (default 5, max 10) rows — narrow with firstName/city when a surname is common (Smith = 480 authorized IL lawyers). Default authorizedOnly=true; set false to include inactive/retired/disbarred. Use after acebc_fellow_search / leading_lawyers_search / dol_sch_c_legal_counsel to confirm the person is licensed and clean before any referral or outreach. Registered address/phone are business registration data — professional contact only. Investigations are confidential; only public discipline appears. Public registry record, not consent to contact.",
    inputSchema: {
      type: "object",
      properties: {
        lastName: { type: "string", description: "Required. Exact surname (hyphenated names match on the full string)." },
        firstName: { type: "string" },
        city: { type: "string", description: "Registered business city, e.g. Chicago, Hinsdale, Oak Brook." },
        county: { type: "string", description: "Illinois county of the registered address, e.g. Cook, DuPage." },
        phonetic: { type: "boolean", default: false, description: "Phonetic (sounds-like) surname match." },
        authorizedOnly: { type: "boolean", default: true, description: "Only lawyers currently authorized to practice." },
        includeDetails: { type: "boolean", default: true },
        detailLimit: { type: "number", default: 5, maximum: 10, description: "How many rows get the firm/phone/discipline details call." },
        limit: { type: "number", default: 25, maximum: 100 },
      },
      required: ["lastName"],
    },
    handler: ardcLawyerLookup,
  },
];

export const ERISAGENERAL_CATALOG: CatalogDomain["tools"] = [
  { name: "acebc_fellow_search", backing: "live-api", probe: "unprobed", note: "acebc.com/fellows GET, HTML; no firm/phone published" },
  { name: "leading_lawyers_search", backing: "live-api", probe: "unprobed", note: "leadinglawyers.com ColdFusion POST search_results.cfm; IL/MI/MO" },
  { name: "ardc_lawyer_lookup", backing: "live-api", probe: "unprobed", note: "iardc.org anti-forgery POST → SearchGrid → Details; verification source" },
];

export const ERISAGENERAL_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "legalpros: ACEBC Illinois fellows", tool: "acebc_fellow_search", args: { state: "IL", limit: 3 } },
  { name: "legalpros: Leading Lawyers T&E Hinsdale", tool: "leading_lawyers_search", args: { practiceArea: "estate", city: "Hinsdale", limit: 3 } },
  {
    name: "legalpros: ARDC lookup (grid only)",
    tool: "ardc_lawyer_lookup",
    args: { lastName: "Hughes", firstName: "Benjamin", includeDetails: false, limit: 3 },
    note: "3 sequential requests (~2-3 s cold); details skipped to stay under budget",
  },
];
