/**
 * legal-pros · directories-estate-family — trusts & estates and family/matrimonial
 * attorney directories for the Chicago metro (all keyless, all public listings).
 *
 *   actec_fellow_search              ACTEC "Find a Lawyer" WordPress REST (mg/v1/directory)
 *   aaml_il_fellow_search            AAML Illinois Chapter fellows (MembershipWorks directory API)
 *   collaborative_divorce_il_search  Collaborative Divorce Illinois "Find a Professional" (GravityView REST)
 *   cepc_member_search               Chicago Estate Planning Council public Services Directory (HTML)
 *   naela_il_search                  NAELA "Find a Lawyer" (iMIS WebForms postback; distance-sorted)
 *
 * Verified live from the sandbox 2026-10-24 — see README-directories-estate-family.md for
 * endpoint shapes, parameters discovered from each site's JS, quirks and what could not be
 * verified. Results are public directory records of professionals who chose to be listed;
 * they are not consent to contact. Professional/firm contact info only.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { politeFetch } from "../data/http";
import {
  cached,
  clampInt,
  decodeEntities,
  fetchWithBackoff,
  HOUR,
  jsonWithBackoff,
  stripTags,
  textWithBackoff,
  trim,
} from "../web-intel/common";

/* ------------------------------------------------------------------------------------------ */
/* shared                                                                                      */
/* ------------------------------------------------------------------------------------------ */

interface ProRow {
  name: string;
  firm: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  practiceAreas: string[];
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  profileUrl: string | null;
  source: string;
  extras?: Record<string, unknown>;
}

const GUARDRAIL =
  "Rows are public directory listings of professionals who opted to be listed — not consent to contact; professional/firm contact info only. Cite the directory and asOf date; use 'listed in / serves alongside' language.";

const s = (v: unknown, max = 160): string | null => trim(v, max);
const lower = (v: unknown) => String(v ?? "").toLowerCase().trim();
const includes = (hay: unknown, needle: string | null | undefined) => (needle ? lower(hay).includes(lower(needle)) : true);
const zip5 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(0, 5);
const zipMatch = (rowZip: unknown, want: string | null | undefined) => (want ? zip5(rowZip).startsWith(zip5(want)) : true);
const cityMatch = (rowCity: unknown, want: string | null | undefined) =>
  want ? lower(rowCity).replace(/[^a-z]/g, "") === lower(want).replace(/[^a-z]/g, "") : true;
const nameMatch = (rowName: unknown, want: string | null | undefined) =>
  want ? lower(want).split(/\s+/).filter(Boolean).every((w) => lower(rowName).includes(w)) : true;

function uniq(a: string[]): string[] {
  return [...new Set(a.filter(Boolean))];
}

/** Run `fn` over `items` with bounded concurrency; failures become null. */
async function pooled<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<Array<R | null>> {
  const out: Array<R | null> = new Array(items.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx]!);
      } catch {
        out[idx] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function finish(dataSource: string, rows: ProRow[], total: number | null, limit: number, notes: string[], extra: Record<string, unknown> = {}) {
  const page = rows.slice(0, limit);
  return {
    dataSource,
    asOf: new Date().toISOString().slice(0, 10),
    returned: page.length,
    total: total ?? rows.length,
    ...extra,
    rows: page,
    note: [rows.length > limit ? `Showing ${limit} of ${rows.length} matches — raise limit or narrow the filter.` : null, ...notes, GUARDRAIL]
      .filter(Boolean)
      .join(" "),
  };
}

const HTML_HEADERS = { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" };

/* ------------------------------------------------------------------------------------------ */
/* ACTEC — American College of Trust and Estate Counsel                                        */
/* ------------------------------------------------------------------------------------------ */

const ACTEC_DIR = "https://www.actec.org/wp-json/mg/v1/directory";

const STATE_NAMES: Record<string, string> = {
  IL: "Illinois", IN: "Indiana", WI: "Wisconsin", MI: "Michigan", IA: "Iowa", MO: "Missouri", MN: "Minnesota", OH: "Ohio",
  NY: "New York", CA: "California", TX: "Texas", FL: "Florida", AZ: "Arizona", CO: "Colorado", GA: "Georgia", MA: "Massachusetts",
  NJ: "New Jersey", PA: "Pennsylvania", WA: "Washington", DC: "District of Columbia", NC: "North Carolina", VA: "Virginia",
  MD: "Maryland", CT: "Connecticut", TN: "Tennessee", OR: "Oregon", NV: "Nevada", UT: "Utah", KS: "Kansas", NE: "Nebraska",
  KY: "Kentucky", SC: "South Carolina", AL: "Alabama", LA: "Louisiana", OK: "Oklahoma", AR: "Arkansas", MS: "Mississippi",
  NM: "New Mexico", ID: "Idaho", MT: "Montana", WY: "Wyoming", ND: "North Dakota", SD: "South Dakota", NH: "New Hampshire",
  VT: "Vermont", ME: "Maine", RI: "Rhode Island", DE: "Delaware", WV: "West Virginia", HI: "Hawaii", AK: "Alaska",
};

/** practice_areas values seen on Illinois fellows (pipe-separated in the API). */
export const ACTEC_PRACTICE_AREAS = [
  "General Trust & Estate", "Trust and Estate Administration", "Transfer Planning", "Business Planning", "Charitable Planning",
  "Testamentary Planning", "Fiduciary Litigation", "Tax Controversies", "Fiduciary Income Tax Planning", "Income Tax Planning",
  "International Trust & Estate", "Asset Protection", "Conservatorships/Guardianships", "Pre/Post Marital Agreements",
  "Special Needs", "Employee Benefits", "Alternate Dispute Resolution (ADR)", "Elder Law",
];

/** Escape a user term for the site's Lucene-ish `query` grammar (mirrors the theme JS). */
function luceneTerm(v: string, wildcard: boolean): string {
  const clean = v.replace(/["()\\:*]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (/\s/.test(clean) || !wildcard) return `"${clean}"`;
  return `${clean}*`;
}

export async function actecFellowSearch(args: any) {
  const limit = clampInt(args?.limit, 25, 1, 100);
  const stateIn = String(args?.state ?? "Illinois").trim();
  const state = stateIn.toUpperCase() === "ANY" ? "" : STATE_NAMES[stateIn.toUpperCase()] ?? stateIn;
  const city = s(args?.city, 60);
  const zip = args?.zip ? String(args.zip).replace(/\D/g, "").slice(0, 5) : null;
  const radiusMiles = args?.radiusMiles != null ? clampInt(args.radiusMiles, 25, 1, 200) : null;
  const lastName = s(args?.lastName, 60);
  const firstName = s(args?.firstName, 60);
  const firm = s(args?.firm, 80);
  const practiceAreas: string[] = Array.isArray(args?.practiceArea) ? args.practiceArea : args?.practiceArea ? [String(args.practiceArea)] : [];
  const fellowsOnly = args?.fellowsOnly !== false;

  if (!state && !city && !zip && !lastName && !firm) {
    throw new Error("actec_fellow_search: pass a geography (state — default Illinois —, city, zip[+radiusMiles]) or a lastName/firm; unbounded dumps of the 2,100+ fellows are refused.");
  }

  const clauses: string[] = [];
  if (state) clauses.push(`address_state:"${state.replace(/"/g, "")}"`);
  if (city) clauses.push(`address_city:${luceneTerm(city, false)}`);
  if (zip && !radiusMiles) clauses.push(`address_zip:${zip.length === 5 ? zip : zip + "*"}`);
  if (lastName) clauses.push(`last_name:${luceneTerm(lastName.replace(/-/g, " "), true)}`);
  if (firstName) clauses.push(`first_name:${luceneTerm(firstName, true)}`);
  if (firm) clauses.push(`organization:${luceneTerm(firm, true)}`);
  if (practiceAreas.length) clauses.push(`practice_areas:(${practiceAreas.map((p) => `"${String(p).replace(/"/g, "")}"`).join(" OR ")})`);

  const params = new URLSearchParams({ query: clauses.join(" AND "), page: "1", mode: "list", showall: "true" });
  if (zip && radiusMiles) {
    if (zip.length !== 5) throw new Error("actec_fellow_search: radiusMiles needs a full 5-digit zip.");
    params.set("zip", zip);
    params.set("radius", String(radiusMiles));
  }
  const url = `${ACTEC_DIR}?${params}`;
  const data = await cached(`actec:${url}`, 12 * HOUR, () =>
    jsonWithBackoff<any>(url, { source: "ACTEC directory", headers: { Accept: "application/json" }, timeoutMs: 25000 }),
  );
  const result: any[] = Array.isArray(data?.result) ? data.result : [];
  const hits = Number(data?.hits ?? result.length);

  let rows: ProRow[] = result.map((r) => ({
    name: decodeEntities(String(r.title ?? `${r.first_name ?? ""} ${r.last_name ?? ""}`)).trim(),
    firm: s(decodeEntities(String(r.organization ?? ""))),
    city: s(r.address_city, 60),
    state: s(r.address_state, 40),
    zip: s(r.address_zip, 12),
    practiceAreas: uniq(String(r.practice_areas ?? "").split("|").map((p) => decodeEntities(p).trim())),
    phone: s(String(r.phones ?? "").replace(/\s*\((Work|Office|Business)\)/gi, "").split("|")[0], 40),
    email: s(r.email, 80),
    website: s(r.website, 160),
    profileUrl: s(r.url, 200),
    source: "ACTEC",
    extras: {
      membershipType: s(r.membership_type, 40),
      isFellow: String(r.is_fellow) === "True",
      yearElected: s(r.year_elected, 8),
      lawSchool: s(r.law_schools, 80),
      jurisdictions: s(r.practice_jurisdictions, 80),
      address: s([r.address_line1, r.address_line2].filter(Boolean).join(", "), 100),
    },
  }));
  const notes: string[] = [];
  if (fellowsOnly) {
    const before = rows.length;
    rows = rows.filter((r) => r.extras?.isFellow);
    if (before !== rows.length) notes.push(`${before - rows.length} non-fellow listing(s) (retired/honorary/academic) hidden — fellowsOnly:false shows them.`);
  }
  if (hits > result.length) notes.push(`Upstream reports ${hits} matches but returned ${result.length} (API cap 300) — narrow by city/zip.`);
  if (zip && radiusMiles) notes.push(`Sorted by distance from ${zip} within ${radiusMiles} mi.`);
  return finish("ACTEC Find a Lawyer directory (actec.org, mg/v1/directory)", rows, hits, limit, notes, { query: params.get("query") || "*" });
}

/* ------------------------------------------------------------------------------------------ */
/* AAML Illinois — American Academy of Matrimonial Lawyers, Illinois Chapter                   */
/* ------------------------------------------------------------------------------------------ */

const MW_API = "https://api.membershipworks.com/v2/directory";
const AAML_IL_ORG = "35637"; // data-org on https://aaml-illinois.org/find-a-lawyer/
const AAML_IL_PAGE = "https://aaml-illinois.org/find-a-lawyer/";

async function aamlIlRoster(): Promise<any[]> {
  return cached("aaml-il:roster", 12 * HOUR, async () => {
    const url = `${MW_API}?${new URLSearchParams({ _rf: "Members", ord: "lnm" })}`;
    const data = await jsonWithBackoff<any>(url, {
      source: "AAML Illinois (MembershipWorks)",
      headers: { "X-Org": AAML_IL_ORG, Accept: "application/json", "Source-Url": AAML_IL_PAGE },
      timeoutMs: 20000,
    });
    if (!Array.isArray(data?.usr)) throw new Error("AAML Illinois: MembershipWorks returned no `usr` array (widget org id may have changed — check data-org on the Find a Lawyer page).");
    return data.usr;
  });
}

export async function aamlIlFellowSearch(args: any) {
  const limit = clampInt(args?.limit, 25, 1, 100);
  const city = s(args?.city, 60);
  const zip = args?.zip ? String(args.zip).replace(/\D/g, "").slice(0, 5) : null;
  const name = s(args?.name, 80);
  const firm = s(args?.firm, 80);
  const county = s(args?.county, 40);

  const roster = await aamlIlRoster();
  const rows: ProRow[] = roster
    .map((u: any) => ({
      name: decodeEntities(String(u.nam ?? "")).trim(),
      firm: s(decodeEntities(String(u.biz ?? "")).replace(/[│|]/g, " ")),
      city: s(u.adr?.cit, 60),
      state: s(u.adr?.sta, 10),
      zip: s(u.adr?.zip, 10),
      practiceAreas: ["Family / Matrimonial Law"],
      phone: s(u.phn?.[0], 40),
      website: s(u.web, 160),
      profileUrl: u.uid ? `${AAML_IL_PAGE}#!biz/id/${u.uid}` : AAML_IL_PAGE,
      source: "AAML Illinois",
      extras: { county: s(u.adr?.cot, 40), address: s(u.adr?.ad1, 80) },
    }))
    .filter((r) => cityMatch(r.city, city) && zipMatch(r.zip, zip) && nameMatch(r.name, name) && includes(r.firm, firm) && includes(r.extras?.county, county));
  const notes = [`${roster.length} fellows on the Illinois Chapter roster (statewide).`];
  return finish("AAML Illinois Chapter — Find a Lawyer (aaml-illinois.org via MembershipWorks)", rows, rows.length, limit, notes);
}

/* ------------------------------------------------------------------------------------------ */
/* Collaborative Divorce Illinois — Find a Professional (GravityView view 261)                 */
/* ------------------------------------------------------------------------------------------ */

const CDI_BASE = "https://collaborativedivorceillinois.org";
const CDI_VIEW = 261;
export const CDI_ROLES = ["Attorney", "Coach", "Financial Specialist", "Child Specialist", "New Collaborator/Recent Law School Graduate", "Affiliate"];

// Browser-looking UAs get the connection reset by the site's bot shield (sgcaptcha) from
// this network; the plain Vistamark UA passes. So: default politeFetch headers only.
const CDI_OPTS = { source: "Collaborative Divorce Illinois", timeoutMs: 25000 };

interface CdiListRow { id: string; name: string; roles: string[] }

async function cdiList(params: URLSearchParams): Promise<{ total: number; rows: CdiListRow[] }> {
  const url = `${CDI_BASE}/wp-json/gravityview/v1/views/${CDI_VIEW}/entries.html?${params}`;
  return cached(`cdi:list:${url}`, 12 * HOUR, async () => {
    const raw = await textWithBackoff(url, { ...CDI_OPTS, headers: { Accept: "application/json" } });
    // The endpoint returns a JSON-encoded HTML string.
    let html: string;
    try {
      html = JSON.parse(raw);
    } catch {
      html = raw;
    }
    if (/sgcaptcha/i.test(html)) throw new Error("Collaborative Divorce Illinois served its bot-check page (sgcaptcha) — retry later or from Vercel.");
    const total = Number(html.match(/X-Item-Total"\s+content="(\d+)"/)?.[1] ?? NaN);
    const rows: CdiListRow[] = [];
    const re = /<div id="gv_list_(\d+)" class="gv-list-view">([\s\S]*?)(?=<div id="gv_list_\d+" class="gv-list-view">|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const block = m[2]!;
      const name = stripTags(block.match(/profileListName[^>]*>\s*<p>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
      const roles = [...block.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => stripTags(x[1]!));
      if (name) rows.push({ id: m[1]!, name, roles });
    }
    return { total: Number.isFinite(total) ? total : rows.length, rows };
  });
}

async function cdiEntry(id: string): Promise<Partial<ProRow>> {
  return cached(`cdi:entry:${id}`, 24 * HOUR, async () => {
    const e = await jsonWithBackoff<any>(`${CDI_BASE}/wp-json/gravityview/v1/views/${CDI_VIEW}/entries/${id}.json`, { ...CDI_OPTS, headers: { Accept: "application/json" } });
    const contact = String(e?.custom ?? "");
    const addr = e?.["6"] ?? {};
    const siteHtml = String(e?.["custom(2)"] ?? "");
    const bioHtml = String(e?.["custom(3)"] ?? "");
    return {
      phone: s(stripTags(contact.match(/Phone:<\/strong>\s*([^<]*)/i)?.[1] ?? ""), 40),
      email: s(stripTags(contact.match(/Email:<\/strong>\s*([^<]*)/i)?.[1] ?? ""), 80),
      website: s(siteHtml.match(/href="([^"]+)"/)?.[1], 160),
      city: s(addr["6.3"], 60),
      state: s(addr["6.4"], 30),
      zip: s(addr["6.5"], 10),
      extras: {
        address: s(addr["6.1"], 80),
        practiceLabel: s(stripTags(bioHtml.match(/singleProfilePracticeArea">([\s\S]*?)<\/span>/)?.[1] ?? ""), 60),
        firmHint: s(stripTags(bioHtml.match(/<p><strong>([\s\S]*?)<\/strong>/)?.[1] ?? "").replace(/,\s*$/, ""), 80),
      },
    };
  });
}

export async function collaborativeDivorceIlSearch(args: any) {
  const limit = clampInt(args?.limit, 25, 1, 100);
  const roleIn = String(args?.role ?? "Attorney").trim();
  const role = roleIn.toUpperCase() === "ANY" ? "" : CDI_ROLES.find((r) => r.toLowerCase() === roleIn.toLowerCase()) ?? roleIn;
  const city = s(args?.city, 60);
  const search = s(args?.search, 80);
  const zip = args?.zip ? String(args.zip).replace(/\D/g, "").slice(0, 5) : null;
  const details = args?.details !== false;
  const detailCap = clampInt(args?.detailLimit, Math.min(limit, 25), 0, 40);

  if (!role && !city && !search && !zip) {
    throw new Error("collaborative_divorce_il_search: pass role (default Attorney), city, zip or search (name/firm text) — the full 127-member roster is not dumped.");
  }
  const params = new URLSearchParams({ limit: "200", mode: "all" });
  if (role) params.set("filter_11", role);
  if (city) params.set("filter_6_3", city);
  // gv_search is full-text across the entry (name, firm, address incl. zip); a zip rides on it.
  if (search || zip) params.set("gv_search", [search, zip].filter(Boolean).join(" "));

  const { total, rows: listed } = await cdiList(params);
  const pick = listed.slice(0, limit);
  const detailRows = details && detailCap ? await pooled(pick.slice(0, detailCap), 6, (r) => cdiEntry(r.id)) : [];

  const rows: ProRow[] = pick.map((r, i) => {
    const d = detailRows[i] ?? null;
    return {
      name: r.name,
      firm: d?.extras?.firmHint && !lower(d.extras.firmHint).startsWith(lower(r.name.split(" ")[0])) ? String(d.extras.firmHint) : null,
      city: d?.city ?? (city ?? null),
      state: d?.state ?? "Illinois",
      zip: d?.zip ?? null,
      practiceAreas: r.roles.length ? r.roles.map((x) => `Collaborative Divorce — ${x}`) : ["Collaborative Divorce"],
      phone: d?.phone ?? undefined,
      email: d?.email ?? undefined,
      website: d?.website ?? undefined,
      profileUrl: `${CDI_BASE}/find-a-professional/entry/${r.id}/`,
      source: "Collaborative Divorce Illinois",
      extras: { entryId: r.id, address: d?.extras?.address ?? null, detailed: Boolean(d) },
    };
  });
  const notes: string[] = [];
  if (zip) {
    // gv_search matches the zip anywhere in the entry; keep rows whose address zip actually matches when details were fetched.
    const kept = rows.filter((r) => !r.extras?.detailed || zipMatch(r.zip, zip));
    if (kept.length !== rows.length) notes.push(`${rows.length - kept.length} row(s) matched '${zip}' only in free text and were dropped.`);
    rows.splice(0, rows.length, ...kept);
  }
  if (details && pick.length > detailCap) notes.push(`Contact details fetched for the first ${detailCap} rows only (detailLimit).`);
  if (!details) notes.push("details:false — phone/email/address omitted; open profileUrl or re-run with details:true.");
  notes.push("Interdisciplinary roster: role 'Financial Specialist' lists CDFA/CPA collaborators (potential referral partners and competitors).");
  return finish("Collaborative Divorce Illinois — Find a Professional (collaborativedivorceillinois.org, GravityView view 261)", rows, total, limit, notes, { role: role || "ANY" });
}

/* ------------------------------------------------------------------------------------------ */
/* CEPC — Chicago Estate Planning Council public Services Directory                            */
/* ------------------------------------------------------------------------------------------ */

const CEPC_BASE = "https://www.cepcweb.org";
export const CEPC_CATEGORIES: Record<string, number> = {
  "Attorney at Law": 17,
  "Estate Planning & Administration": 18,
  "Trust & Estate Administration": 19,
  "Wealth Management Services": 20,
  "Elderly & Disability Services": 21,
  "Life Insurance": 22,
  "Charitable Giving": 23,
  "Federal & State Tax Litigation": 41,
  "Retirement Plan Admin. & Consulting": 52,
  "Retirement Services": 53,
  "Accounting & Tax Preparation": 15,
  "Appraisers & Valuation": 16,
};

interface CepcListing { id: string; name: string; title: string | null; firm: string | null; featured: boolean }

async function cepcCategory(catId: number, zip: string | null): Promise<CepcListing[]> {
  const url = `${CEPC_BASE}/council/services-directory/${catId}${zip ? `/${zip}` : ""}`;
  return cached(`cepc:cat:${url}`, 12 * HOUR, async () => {
    const html = await textWithBackoff(url, { source: "CEPC services directory", headers: HTML_HEADERS, timeoutMs: 20000 });
    const body = html.slice(html.indexOf('id="serviceDirectoryListings"'));
    if (!body || /no listings for this category/i.test(html)) return [];
    const out: CepcListing[] = [];
    let featured = false;
    // Walk headings and listings in document order.
    const re = /<h4>([^<]*)<\/h4>|<div class="serviceDirectoryListing clear">([\s\S]*?)<\/div>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      if (m[1] != null) {
        featured = /featured/i.test(m[1]);
        continue;
      }
      const block = m[2]!;
      const a = block.match(/<a href="\/council\/services-directory\/member\/(\d+)">([\s\S]*?)<\/a>/);
      if (!a) continue;
      const full = stripTags(a[2]!);
      const [name, ...rest] = full.split(/,\s*/);
      const firm = stripTags(block.slice(block.lastIndexOf("<br />") + 6).replace(/<a[\s\S]*?<\/a>/g, ""));
      out.push({ id: a[1]!, name: (name ?? full).trim(), title: rest.length ? rest.join(", ") : null, firm: firm || null, featured });
    }
    return out;
  });
}

async function cepcMember(id: string): Promise<Partial<ProRow>> {
  return cached(`cepc:member:${id}`, 24 * HOUR, async () => {
    const html = await textWithBackoff(`${CEPC_BASE}/council/services-directory/member/${id}`, { source: "CEPC member listing", headers: HTML_HEADERS, timeoutMs: 20000 });
    const block = html.match(/<div class="serviceDirectoryListing">([\s\S]*?)<p class="clear">/)?.[1] ?? "";
    const divs = [...block.matchAll(/<div>([\s\S]*?)<\/div>/g)].map((x) => stripTags(x[1]!));
    const addr = divs.find((d) => /\b[A-Z]{2}\s+\d{5}/.test(d) && !/Phone:/i.test(d)) ?? null;
    const phoneDiv = divs.find((d) => /Phone:/i.test(d)) ?? "";
    const csz = addr?.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
    const site = block.match(/Website:\s*<a href="([^"]+)"/i)?.[1] ?? null;
    return {
      city: csz?.[1]?.trim() ?? null,
      state: csz?.[2] ?? null,
      zip: csz?.[3] ?? null,
      phone: s(phoneDiv.match(/Phone:\s*([()\d\s.-]{7,})/i)?.[1], 30),
      website: site ? s(/^https?:/i.test(site) ? site : `http://${site}`, 160) : null,
      extras: { address: s(addr, 120) },
    };
  });
}

export async function cepcMemberSearch(args: any) {
  const limit = clampInt(args?.limit, 25, 1, 100);
  const catIn = String(args?.category ?? "Attorney at Law").trim();
  const catName = Object.keys(CEPC_CATEGORIES).find((k) => k.toLowerCase() === catIn.toLowerCase()) ?? Object.keys(CEPC_CATEGORIES).find((k) => k.toLowerCase().includes(catIn.toLowerCase()));
  if (!catName) throw new Error(`cepc_member_search: unknown category '${catIn}'. Use one of: ${Object.keys(CEPC_CATEGORIES).join("; ")}.`);
  const zip = args?.zip ? String(args.zip).replace(/\D/g, "") : null;
  if (zip && zip.length !== 5) throw new Error("cepc_member_search: zip must be a full 5-digit code (the site filters by exact zip; prefixes are not supported).");
  const name = s(args?.name, 80);
  const firm = s(args?.firm, 80);
  const details = args?.details === true;
  const detailCap = clampInt(args?.detailLimit, Math.min(limit, 25), 0, 40);

  const listed = (await cepcCategory(CEPC_CATEGORIES[catName]!, zip)).filter((l) => nameMatch(l.name, name) && includes(l.firm, firm));
  const pick = listed.slice(0, limit);
  const det = details && detailCap ? await pooled(pick.slice(0, detailCap), 6, (l) => cepcMember(l.id)) : [];
  const rows: ProRow[] = pick.map((l, i) => {
    const d = det[i] ?? null;
    return {
      name: l.name,
      firm: l.firm,
      city: d?.city ?? (zip ? null : "Chicago area"),
      state: d?.state ?? "IL",
      zip: d?.zip ?? zip,
      practiceAreas: [catName],
      phone: d?.phone ?? undefined,
      website: d?.website ?? undefined,
      profileUrl: `${CEPC_BASE}/council/services-directory/member/${l.id}`,
      source: "CEPC Services Directory",
      extras: { title: l.title, featured: l.featured, address: d?.extras?.address ?? null, detailed: Boolean(d) },
    };
  });
  const notes = [
    "CEPC's full member directory (~700 members) is login-only; this is the public, opt-in Services Directory, so absence here is not evidence of non-membership.",
    details ? (pick.length > detailCap ? `Address/phone fetched for the first ${detailCap} rows only.` : "") : "details:true adds address, phone and website from each member page (one request per row).",
  ].filter(Boolean);
  return finish("Chicago Estate Planning Council — public Services Directory (cepcweb.org)", rows, listed.length, limit, notes, { category: catName, zip: zip ?? null });
}

/* ------------------------------------------------------------------------------------------ */
/* NAELA — National Academy of Elder Law Attorneys, Find a Lawyer (iMIS WebForms)              */
/* ------------------------------------------------------------------------------------------ */

const NAELA_URL = "https://www.naela.org/Web/Shared_Content/Directories/Find-a-Lawyer.aspx";
const NAELA_SHEET = "ctl01$TemplateBody$WebPartManager1$gwpciDirectoryCCO$ciDirectoryCCO$DistanceQueryMenu$ResultsGrid$Sheet0$";
const NAELA_GRID = "ctl01$TemplateBody$WebPartManager1$gwpciDirectoryCCO$ciDirectoryCCO$DistanceQueryMenu$ResultsGrid$Grid1$ctl00$ctl03$ctl01$";
const NAELA_PAGE_SIZE = 20;

interface NaelaRow extends ProRow { distanceMiles: number }

function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const tag = m[0];
    const name = tag.match(/name="(__[A-Za-z]+)"/)?.[1];
    if (!name) continue;
    out[name] = decodeEntities(tag.match(/value="([^"]*)"/)?.[1] ?? "");
  }
  return out;
}

function parseNaelaRows(html: string): NaelaRow[] {
  const rows: NaelaRow[] = [];
  const parts = html.split('<div class="jcFALRow').slice(1);
  for (const p of parts) {
    const id = p.match(/Profile\.aspx\?id=(\d+)/)?.[1] ?? null;
    // Telerik emits stray double spaces (`<div  class="H4">`), so match attributes loosely.
    const name = stripTags(p.match(/class="H4"\s*>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "");
    if (!name) continue;
    const loc = stripTags(p.match(/class="LocRight"\s*>([\s\S]*?)<br/)?.[1] ?? "");
    const [city, st] = loc.split(/,\s*/);
    const dist = Number(p.match(/([\d.]+) miles away/)?.[1] ?? NaN);
    const since = p.match(/Member Since:\s*([\d/]+)/)?.[1] ?? null;
    const paCount = Number(p.match(/Experienced in (\d+) Practice Areas/)?.[1] ?? NaN);
    const phone = p.match(/href="tel:([^"]+)"/)?.[1] ?? null;
    const contact = p.match(/<h3>Contact Information<\/h3>([\s\S]*?)<\/span>\s*<\/div>/)?.[1] ?? "";
    const lines = contact
      .replace(/<span class="DetailName2">[\s\S]*?<\/span>/, "")
      .split(/<br\s*\/?>/)
      .map((x) => stripTags(x))
      .filter(Boolean);
    const firm = lines[0] && !/^\d/.test(lines[0]) && !/^Phone:/i.test(lines[0]) ? lines[0] : null;
    const csz = lines.find((l) => /,\s*[A-Z]{2}\s+\d{5}/.test(l));
    const zip = csz?.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? null;
    const street = lines.filter((l) => l !== firm && l !== csz && !/^Phone:/i.test(l)).join(", ");
    rows.push({
      name,
      firm: s(firm, 80),
      city: s(city, 60),
      state: s(st, 4),
      zip,
      practiceAreas: ["Elder Law / Special Needs"],
      phone: s(phone, 30),
      profileUrl: id ? `https://www.naela.org/Shared_Content/Directories/Profile.aspx?id=${id}` : null,
      source: "NAELA",
      distanceMiles: Number.isFinite(dist) ? Math.round(dist * 10) / 10 : NaN,
      extras: { memberSince: since, practiceAreaCount: Number.isFinite(paCount) ? paCount : null, address: s(street, 100), credential: /\bCELA\b/.test(name) ? "CELA" : /\bFellow\b/.test(name) ? "Fellow" : null },
    });
  }
  return rows;
}

async function naelaPost(fields: Record<string, string>, cookie: string): Promise<{ html: string; cookie: string }> {
  const res = await politeFetch(NAELA_URL, {
    method: "POST",
    retries: 0,
    timeoutMs: 25000,
    headers: { ...HTML_HEADERS, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Referer: NAELA_URL },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`NAELA Find a Lawyer rejected the search (HTTP ${res.status} redirect) — the ASP.NET session cookie or __RequestVerificationToken was not accepted.`);
  if (!res.ok) throw new Error(`NAELA Find a Lawyer HTTP ${res.status}`);
  const more = (res.headers as any).getSetCookie?.() as string[] | undefined;
  const merged = mergeCookies(cookie, more ?? []);
  return { html: await res.text(), cookie: merged };
}

function mergeCookies(existing: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const kv of existing.split(/;\s*/).filter(Boolean)) {
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  for (const sc of setCookies) {
    const first = sc.split(";")[0] ?? "";
    const i = first.indexOf("=");
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function naelaSearchPages(zip: string, pages: number): Promise<{ rows: NaelaRow[]; totalItems: number | null }> {
  return cached(`naela:${zip}:${pages}`, 6 * HOUR, async () => {
    const first = await fetchWithBackoff(NAELA_URL, { source: "NAELA Find a Lawyer", headers: HTML_HEADERS, timeoutMs: 25000 });
    let cookie = mergeCookies("", ((first.headers as any).getSetCookie?.() as string[] | undefined) ?? []);
    const landing = await first.text();
    const fields = hiddenFields(landing);
    if (!fields.__VIEWSTATE) throw new Error("NAELA Find a Lawyer: landing page had no __VIEWSTATE (page layout changed or bot-blocked).");
    fields[`${NAELA_SHEET}Input0$TextBox1`] = zip;
    fields[`${NAELA_SHEET}Input1$DropDown1`] = "100";
    fields[`${NAELA_SHEET}Input3$TextBox1`] = zip;
    fields[`${NAELA_SHEET}SubmitButton`] = "Find";
    let { html, cookie: c2 } = await naelaPost(fields, cookie);
    cookie = c2;
    if (/valid value for all required filters/i.test(html)) throw new Error("NAELA Find a Lawyer: server rejected the filters (zip must be a 5-digit US zip the site knows).");
    const totalItems = Number(html.match(/<strong>(\d+)<\/strong> items in <strong>\d+<\/strong> pages/)?.[1] ?? NaN);
    let rows = parseNaelaRows(html);
    for (let p = 2; p <= pages && rows.length >= NAELA_PAGE_SIZE * (p - 1); p++) {
      const next = hiddenFields(html);
      next[`${NAELA_GRID}ctl28`] = " "; // "Next Page" submit
      const r = await naelaPost(next, cookie);
      html = r.html;
      cookie = r.cookie;
      const more = parseNaelaRows(html);
      if (!more.length) break;
      rows = rows.concat(more);
    }
    return { rows, totalItems: Number.isFinite(totalItems) ? totalItems : null };
  });
}

export async function naelaIlSearch(args: any) {
  const limit = clampInt(args?.limit, 25, 1, 60);
  const zip = String(args?.zip ?? "60521").replace(/\D/g, "").slice(0, 5);
  if (zip.length !== 5) throw new Error("naela_il_search: zip must be a 5-digit code (default 60521 Hinsdale; use 60603 for the Loop).");
  const radiusMiles = clampInt(args?.radiusMiles, 25, 1, 300);
  const state = args?.state === "" || String(args?.state ?? "").toUpperCase() === "ANY" ? null : String(args?.state ?? "IL").toUpperCase();
  const city = s(args?.city, 60);
  const name = s(args?.name, 80);
  const pages = clampInt(args?.pages, Math.ceil(limit / NAELA_PAGE_SIZE), 1, 3);

  const { rows: all, totalItems } = await naelaSearchPages(zip, pages);
  const rows = all.filter(
    (r) => (!Number.isFinite(r.distanceMiles) || r.distanceMiles <= radiusMiles) && (!state || r.state === state) && cityMatch(r.city, city) && nameMatch(r.name, name),
  );
  const notes = [
    `Nearest ${all.length} NAELA members to ${zip} fetched (${pages} page(s) × ${NAELA_PAGE_SIZE}, distance-sorted); ${rows.length} within ${radiusMiles} mi${state ? ` in ${state}` : ""}.`,
    all.length && all[all.length - 1]!.distanceMiles <= radiusMiles ? "The radius extends past the fetched pages — raise `pages` (max 3) to see more." : "",
    "NAELA practice-area lists load client-side and are not captured; practiceAreaCount is shown. Site search does not expose state/name filters — those are applied locally.",
  ].filter(Boolean);
  return finish("NAELA Find a Lawyer (naela.org, public basic search)", rows, rows.length, limit, notes, { zip, radiusMiles, fetched: all.length, naelaMembersNationwide: totalItems });
}

/* ------------------------------------------------------------------------------------------ */
/* tool defs                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const limitProp = { type: "number", default: 25, maximum: 100, description: "Rows to return (default 25, max 100)." };

export const DIRECTORIES_ESTATE_FAMILY_TOOLS: ToolDef[] = [
  {
    name: "actec_fellow_search",
    description:
      `ACTEC Fellows (American College of Trust and Estate Counsel) — the peer-elected top tier of trusts & estates lawyers; live from actec.org's public Find-a-Lawyer REST directory (no key). ~2,180 fellows nationally, 97 in Illinois (75 Chicago; also Lake Forest, Oak Brook, Hinsdale, Western Springs, Northbrook, Springfield). Default state Illinois. Filter by city, zip (5-digit, or a prefix like '605'), zip+radiusMiles (distance-sorted), lastName/firstName, firm (organization prefix, e.g. 'ArentFox'), practiceArea (one or more of: ${ACTEC_PRACTICE_AREAS.join("; ")}). Returns name, firm, city/state/zip, practice areas, firm phone/email/website, ACTEC profile URL, membership type, year elected, law school, jurisdictions. Use case: build the T&E referral-partner list (Vistamark Integrated CIO / family-office clients need estate counsel) and identify the attorneys already serving your prospects' peers. ${GUARDRAIL}`,
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Full state name or 2-letter code (default Illinois). 'ANY' for nationwide — then city/zip/lastName/firm is required." },
        city: { type: "string", description: "e.g. Chicago, Oak Brook, Lake Forest." },
        zip: { type: "string", description: "5-digit zip or prefix (e.g. 6052 → 60521/60523…)." },
        radiusMiles: { type: "number", description: "With a 5-digit zip: fellows within N miles, sorted by distance." },
        lastName: { type: "string" },
        firstName: { type: "string" },
        firm: { type: "string", description: "Firm name prefix (e.g. 'McDermott', 'ArentFox')." },
        practiceArea: { type: ["string", "array"], items: { type: "string", enum: ACTEC_PRACTICE_AREAS } },
        fellowsOnly: { type: "boolean", default: true, description: "Hide retired/honorary/academic listings." },
        limit: limitProp,
      },
    },
    handler: actecFellowSearch,
  },
  {
    name: "aaml_il_fellow_search",
    description:
      "AAML Illinois Chapter Fellows (American Academy of Matrimonial Lawyers) — the ~89 peer-vetted family/matrimonial law specialists in Illinois (divorce, prenups/postnups, complex marital estates); live from aaml-illinois.org's public Find-a-Lawyer directory (MembershipWorks API, no key). Filter by city (most are Chicago; also Springfield, Wheaton, Lake Forest…), zip or zip prefix, county, name, firm. Returns name, firm, city/state/zip, firm phone, website, profile URL. Use case: divorce is a top money-in-motion trigger — these are the attorneys whose HNW clients need a post-settlement adviser; they are also prenup/postnup counsel for family-office clients. Statewide roster is small, so no filter returns all fellows. " + GUARDRAIL,
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
        zip: { type: "string", description: "5-digit zip or prefix." },
        county: { type: "string", description: "e.g. Cook County, DuPage County, Lake County." },
        name: { type: "string", description: "Any words of the fellow's name." },
        firm: { type: "string", description: "Substring of the firm name (e.g. 'Schiller', 'Grund')." },
        limit: limitProp,
      },
    },
    handler: aamlIlFellowSearch,
  },
  {
    name: "collaborative_divorce_il_search",
    description:
      `Collaborative Divorce Illinois member roster (collaborativedivorceillinois.org Find a Professional, live, no key) — ~127 collaboratively-trained professionals: ~97 attorneys plus divorce coaches, child specialists and Financial Specialists (CDFAs/CPAs who are referral partners or competitors). Default role Attorney; role ANY or one of: ${CDI_ROLES.join("; ")}. Filter by city (e.g. Chicago, Hinsdale, Oak Brook, Northbrook), zip, or search text (name/firm). details:true (default) fetches each profile for firm phone, email, website and office address (first detailLimit rows, default ≤25). Returns name, roles, city/state/zip, phone, email, website, profile URL. Use case: collaborative-divorce attorneys work in interdisciplinary teams and actively refer financial neutrals/advisers — a warm channel for divorce-driven money in motion. ${GUARDRAIL}`,
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: `Default 'Attorney'. 'ANY' or one of: ${CDI_ROLES.join(", ")}.` },
        city: { type: "string", description: "Office city (server-side filter)." },
        zip: { type: "string", description: "5-digit zip (full-text match, then verified against the address when details are fetched)." },
        search: { type: "string", description: "Free text — name or firm fragment." },
        details: { type: "boolean", default: true, description: "Fetch profile pages for phone/email/address/website." },
        detailLimit: { type: "number", description: "Max profiles to fetch (default min(limit,25), max 40)." },
        limit: limitProp,
      },
    },
    handler: collaborativeDivorceIlSearch,
  },
  {
    name: "cepc_member_search",
    description:
      `Chicago Estate Planning Council (CEPC, est. 1938, ~700 members) — public Services Directory on cepcweb.org (live, no key). The full member directory is login-only, so this covers the opt-in listings by category: default 'Attorney at Law' (~140 T&E attorneys incl. ArentFox Schiff, Harrison, Levun Goodman & Cohen, Krieg DeVault…); other categories: ${Object.keys(CEPC_CATEGORIES).filter((k) => k !== "Attorney at Law").join("; ")} (the Wealth Management and Trust categories list competitors and bank trust officers). Filter by exact 5-digit zip (site-side), name, firm. details:true fetches each listing page for office address, phone and website (≤ detailLimit rows). Returns name, title, firm, category, profile URL (+ city/zip/phone/website with details). Use case: multidisciplinary estate-planning referral network in Chicago — attorneys, CPAs, trust officers and planned-giving officers who co-serve HNW families. ${GUARDRAIL}`,
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: Object.keys(CEPC_CATEGORIES), default: "Attorney at Law" },
        zip: { type: "string", description: "Exact 5-digit office zip (e.g. 60606). Prefixes are not supported by the site." },
        name: { type: "string" },
        firm: { type: "string" },
        details: { type: "boolean", default: false, description: "Fetch each member page for address/phone/website (one request per row)." },
        detailLimit: { type: "number", description: "Max member pages to fetch (default min(limit,25), max 40)." },
        limit: limitProp,
      },
    },
    handler: cepcMemberSearch,
  },
  {
    name: "naela_il_search",
    description:
      "NAELA members (National Academy of Elder Law Attorneys — elder law, special-needs planning, Medicaid/long-term-care planning, guardianship) near a Chicago-area zip; live from naela.org's public Find-a-Lawyer basic search (ASP.NET postback, no key). The site returns members sorted by distance from the zip (20 per page; pages ≤3 → up to 60 nearest); radiusMiles (default 25), state (default IL; '' or ANY to include IN/WI), city and name are applied locally. Default zip 60521 (Hinsdale) — use 60603 for the Loop, 60093 for the North Shore. Returns name (CELA/Fellow flagged), firm, city/state/zip, distance, member-since date, phone, office address, profile URL. Use case: aging-parent and special-needs planning referrals for family-office clients; elder-law attorneys see liquidity events (home sales, LTC funding) early. Fragile upstream (viewstate + session cookie) — if it errors, retry once or use the profile URLs. " + GUARDRAIL,
    inputSchema: {
      type: "object",
      properties: {
        zip: { type: "string", default: "60521", description: "5-digit origin zip for the distance search." },
        radiusMiles: { type: "number", default: 25 },
        state: { type: "string", default: "IL", description: "2-letter state to keep; '' or 'ANY' keeps all." },
        city: { type: "string" },
        name: { type: "string" },
        pages: { type: "number", description: "Result pages to fetch (20 rows each, max 3). Default ceil(limit/20)." },
        limit: { type: "number", default: 25, maximum: 60 },
      },
    },
    handler: naelaIlSearch,
  },
];

export const DIRECTORIES_ESTATE_FAMILY_CATALOG: CatalogDomain["tools"] = [
  { name: "actec_fellow_search", backing: "live-api", probe: "unprobed", note: "actec.org wp-json/mg/v1/directory (no nonce needed); IL=97 fellows" },
  { name: "aaml_il_fellow_search", backing: "live-api", probe: "unprobed", note: "api.membershipworks.com/v2/directory X-Org 35637; 89 fellows" },
  { name: "collaborative_divorce_il_search", backing: "live-api", probe: "unprobed", note: "GravityView REST view 261; browser UAs get reset — Vistamark UA only" },
  { name: "cepc_member_search", backing: "live-api", probe: "unprobed", note: "cepcweb.org public Services Directory (opt-in; member directory is login-only)" },
  { name: "naela_il_search", backing: "live-api", probe: "unprobed", note: "naela.org iMIS WebForms postback; 2-5 s; fragile" },
];

export const DIRECTORIES_ESTATE_FAMILY_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "legalpros: ACTEC Illinois fellows (Hinsdale/Oak Brook zips)", tool: "actec_fellow_search", args: { zip: "6052", limit: 3 } },
  { name: "legalpros: AAML Illinois fellows in Chicago", tool: "aaml_il_fellow_search", args: { city: "Chicago", limit: 3 } },
  { name: "legalpros: Collaborative Divorce IL attorneys (list only)", tool: "collaborative_divorce_il_search", args: { role: "Attorney", city: "Hinsdale", details: false, limit: 3 } },
  { name: "legalpros: CEPC services directory attorneys 60606", tool: "cepc_member_search", args: { zip: "60606", limit: 3 } },
  // naela_il_search omitted: ASP.NET viewstate + cookie postback runs 3-6 s cold and is the most likely to break; probe manually.
];
