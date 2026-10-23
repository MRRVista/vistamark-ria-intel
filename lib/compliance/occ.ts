/**
 * OCC Enforcement Action Search (apps.occ.gov/EASearch).
 *
 * Verified 2026-10-22: the search app is server-rendered MVC, but its "Save
 * As" menu exposes a JSON export of the WHOLE result set:
 *   GET https://apps.occ.gov/EASearch/Search/ExportToJSON?q=&isAdv=true     (~3.4 MB, ~6.1k actions, 1987→today)
 *   optional query params: q (free text), startDteMin/startDteMax, termDteMin/termDteMax (MM/DD/YYYY),
 *   indOnly/instOnly/activeOnly/terminatedOnly (true|false), tps=<TypeCode> (repeatable), sms=<SubjectMatter>
 * Row shape: Institution, CharterNumber, Company, Individual, Location ("City, ST"), TypeCode, TypeDescription,
 *   Amount ("0.00"), StartDate, StartDocuments[], TerminationDate, TerminationDocuments[], DocketNumber, SubjectMatters[]
 * Documents resolve to https://occ.gov/static/enforcement-actions/ea{Doc}.pdf (verified for both "2005-98" and "AA-ENF-2026-46").
 *
 * Quirks: the app sits behind a WAF that answers a random ~50% of requests with
 * "302 Security Redirect → https://www.occ.treas.gov/" regardless of headers or
 * cookies; a plain retry succeeds. We fetch with redirect:"manual", retry up to
 * 8× (longer backoff on 5xx), and cache the full list 12 h so a cold call costs one ~9 s download.
 * Type codes seen: CMP, FA, C&D, Prohibition, REST, 1829, Notice, PCAD, SEC, GLBA, CD, Suspension, SASO.
 * 1829 prohibition notifications before 2022-12-23 are omitted upstream (Fair Hiring in Banking Act).
 * Also covers former OTS actions (thrifts) since the 2011 merger.
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, clampInt, HOUR, nameScore, normIsoDate, prepareName, str, usDateToIso } from "./common";

const BASE = "https://apps.occ.gov/EASearch";
const TTL = 12 * HOUR;

interface RawRow {
  Institution: string;
  CharterNumber: string;
  Company: string;
  Individual: string;
  Location: string;
  TypeCode: string;
  TypeDescription: string;
  Amount: string;
  StartDate: string;
  StartDocuments: string[];
  TerminationDate: string;
  TerminationDocuments: string[];
  DocketNumber: string;
  SubjectMatters: string[];
}

export interface OccAction {
  institution: string | null;
  charter: string | null;
  company: string | null;
  individual: string | null;
  city: string | null;
  state: string | null;
  typeCode: string;
  type: string;
  amount: number;
  startDate: string | null;
  startDocs: string[];
  terminationDate: string | null;
  terminationDocs: string[];
  docket: string | null;
  subjects: string[];
}

interface OccDataset {
  rows: OccAction[];
  fetchedAt: string;
  typeCodes: Record<string, string>;
}

async function fetchExport(params: Record<string, string>): Promise<RawRow[]> {
  const qs = new URLSearchParams({ q: "", isAdv: "true", ...params }).toString();
  const url = `${BASE}/Search/ExportToJSON?${qs}`;
  let last = "";
  const MAX = 8;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const res = await politeFetch(url, {
      redirect: "manual",
      retries: 0,
      timeoutMs: 40000,
      headers: { Accept: "application/json, */*", Referer: `${BASE}/` },
    });
    if (res.status === 200) {
      const text = await res.text();
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data)) return data as RawRow[];
        last = "non-array JSON";
      } catch {
        last = `non-JSON body (${text.slice(0, 60)})`;
      }
    } else {
      last = `HTTP ${res.status}${res.status === 302 ? " Security Redirect (WAF)" : ""}`;
      await res.text().catch(() => "");
      if (res.status >= 400 && res.status !== 429 && res.status < 500) break; // real client error — do not hammer
    }
    // 302 = WAF coin-flip (short wait); 5xx/429 = upstream trouble (longer wait)
    await new Promise((r) => setTimeout(r, (last.startsWith("HTTP 302") ? 250 : 1200) + attempt * 400));
  }
  throw new Error(`OCC EASearch export failed after ${MAX} attempts (${last}) — ${redactUrl(url)}`);
}

const isDoc = (d: unknown): d is string => typeof d === "string" && /^[A-Za-z0-9-]+$/.test(d) && !/^n\/?a$/i.test(d);

function normalize(r: RawRow): OccAction {
  const [city, state] = (str(r.Location) || ", ").split(",").map((s) => s.trim());
  const n = (v: string | undefined) => (str(v) ? str(v) : null);
  return {
    institution: n(r.Institution),
    charter: n(r.CharterNumber),
    company: n(r.Company),
    individual: n(r.Individual),
    city: city || null,
    state: state || null,
    typeCode: str(r.TypeCode),
    type: str(r.TypeDescription),
    amount: Number(str(r.Amount).replace(/[,$]/g, "")) || 0,
    startDate: usDateToIso(r.StartDate),
    startDocs: Array.isArray(r.StartDocuments) ? r.StartDocuments.filter(isDoc) : [],
    terminationDate: usDateToIso(r.TerminationDate),
    terminationDocs: Array.isArray(r.TerminationDocuments) ? r.TerminationDocuments.filter(isDoc) : [],
    docket: n(r.DocketNumber),
    subjects: Array.isArray(r.SubjectMatters) ? r.SubjectMatters : [],
  };
}

export function loadOcc(): Promise<OccDataset> {
  return cached("occ:all", TTL, async () => {
    const raw = await fetchExport({});
    if (raw.length < 1000) throw new Error(`OCC export returned only ${raw.length} rows — upstream may have changed`);
    const rows = raw.map(normalize);
    const typeCodes: Record<string, string> = {};
    for (const r of rows) if (r.typeCode && !typeCodes[r.typeCode]) typeCodes[r.typeCode] = r.type;
    return { rows, fetchedAt: new Date().toISOString(), typeCodes };
  });
}

export const docUrl = (doc: string) => `https://occ.gov/static/enforcement-actions/ea${doc}.pdf`;

function compact(a: OccAction, score?: number) {
  return {
    score,
    party: a.individual ? `${a.individual} (individual)` : a.company || a.institution,
    institution: a.individual || a.company ? a.institution ?? undefined : undefined,
    charter: a.charter ?? undefined,
    location: [a.city, a.state].filter(Boolean).join(", ") || undefined,
    type: `${a.typeCode} — ${a.type}`,
    amount: a.amount || undefined,
    startDate: a.startDate,
    status: a.terminationDate ? `terminated ${a.terminationDate}` : "active",
    docket: a.docket ?? undefined,
    documents: [...a.startDocs, ...a.terminationDocs].slice(0, 3).map(docUrl),
    subjects: a.subjects.length ? a.subjects.slice(0, 6) : undefined,
  };
}

export async function occEnforcementSearch(args: any) {
  const name = str(args?.name);
  const state = str(args?.state).toUpperCase();
  const typeArg = str(args?.type).toUpperCase();
  const since = normIsoDate(args?.since);
  const until = normIsoDate(args?.until, true);
  const party = str(args?.party).toLowerCase(); // individual | institution
  const activeOnly = args?.activeOnly === true;
  const subject = str(args?.subject).toLowerCase();
  const minScore = clampInt(args?.minScore, 85, 1, 100);
  const limit = clampInt(args?.limit, 15, 1, 25);
  if (!name && !state && !since && !typeArg && !subject) {
    throw new Error("occ_enforcement_search: pass `name` (bank, company or individual) and/or filters (`state`, `type`, `since`, `subject`)");
  }
  const ds = await loadOcc();
  const typeCode = typeArg ? Object.keys(ds.typeCodes).find((c) => c.toUpperCase() === typeArg || ds.typeCodes[c]!.toUpperCase().includes(typeArg)) : null;
  if (typeArg && !typeCode) throw new Error(`occ_enforcement_search: unknown type "${typeArg}". Known codes: ${Object.keys(ds.typeCodes).join(", ")}`);

  const q = name ? prepareName(name, true) : null;
  const hits: Array<{ a: OccAction; score: number }> = [];
  for (const a of ds.rows) {
    if (state && a.state !== state) continue;
    if (typeCode && a.typeCode !== typeCode) continue;
    if (since && (!a.startDate || a.startDate < since)) continue;
    if (until && (!a.startDate || a.startDate > until)) continue;
    if (party === "individual" && !a.individual) continue;
    if (party === "institution" && a.individual) continue;
    if (activeOnly && a.terminationDate) continue;
    if (subject && !a.subjects.some((s) => s.toLowerCase().includes(subject))) continue;
    let score = 100;
    if (q) {
      score = 0;
      for (const cand of [a.institution, a.company, a.individual]) {
        if (!cand) continue;
        score = Math.max(score, nameScore(q, prepareName(cand, true)));
        if (score >= 100) break;
      }
      if (score < minScore) continue;
    }
    hits.push({ a, score });
  }
  hits.sort((x, y) => y.score - x.score || (y.a.startDate ?? "").localeCompare(x.a.startDate ?? ""));
  const byType: Record<string, number> = {};
  let active = 0;
  let penalties = 0;
  for (const h of hits) {
    byType[h.a.typeCode] = (byType[h.a.typeCode] ?? 0) + 1;
    if (!h.a.terminationDate) active++;
    penalties += h.a.amount;
  }
  return {
    source: "OCC Enforcement Action Search (apps.occ.gov/EASearch JSON export; national banks + federal thrifts, incl. legacy OTS)",
    fetchedAt: ds.fetchedAt,
    actionsOnFile: ds.rows.length,
    query: { name: name || null, state: state || null, type: typeCode ?? null, since, until, party: party || null, activeOnly, subject: subject || null },
    matchCount: hits.length,
    summary: hits.length ? { active, terminated: hits.length - active, byType, totalCivilMoneyPenalties: penalties || undefined } : undefined,
    results: hits.slice(0, limit).map((h) => compact(h.a, q ? h.score : undefined)),
    typeCodes: hits.length ? undefined : ds.typeCodes,
    note: "OCC covers national banks, federal savings associations and their institution-affiliated parties only; state banks are FDIC/Fed/state-regulated. 1829 prohibition notices before 2022-12-23 are not listed.",
  };
}
