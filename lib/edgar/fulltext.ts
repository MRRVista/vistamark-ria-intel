/**
 * SEC EDGAR full-text search (efts.sec.gov) + Form D / Reg D layer.
 *
 * EDGAR full-text search indexes the text of filings from 2001 onward and is
 * the only free way to search ACROSS filers (the submissions API is per-CIK,
 * and the ticker map only covers listed companies — most Form D filers are
 * private funds with no ticker). This module exposes:
 *
 *   edgar_fulltext_search — keyword search across all EDGAR filings,
 *                            filterable by form type(s) and date range
 *   formd_search          — the Form D / exempt-offering lens: which GPs,
 *                            private funds, and issuers are raising
 *
 * Endpoint (GET): https://efts.sec.gov/LATEST/search-index?q=...&forms=...
 *   Optional: dateRange=custom&startdt=YYYY-MM-DD&enddt=YYYY-MM-DD, from=N.
 * Response is Elasticsearch-style JSON: { hits: { total: {value}, hits: [
 *   { _id: "adsh:filename", _source: { ciks, display_names, file_type,
 *     file_date, ... } } ] } }.
 * The API serves at most ~10 hits per page — paginate with `from`.
 *
 * Parsed defensively (multiple candidate field names, sampleRawHit surfaced
 * when parsing yields nothing) so a shape change is visible, not silent.
 */
import { jsonFetch } from "../data/http";

const EFTS_BASE = "https://efts.sec.gov/LATEST/search-index";

function parseHit(h: any) {
  const src = (h && h._source) || {};
  const id = String(h?._id ?? "");
  let adshFromId: string | null = null;
  let fileName: string | null = null;
  if (id.includes(":")) {
    const idx = id.indexOf(":");
    adshFromId = id.slice(0, idx);
    fileName = id.slice(idx + 1) || null;
  }
  const adsh: string | null = src.adsh ?? adshFromId ?? null;
  const ciks: string[] = Array.isArray(src.ciks)
    ? src.ciks.map((c: any) => String(c))
    : src.cik != null
      ? [String(src.cik)]
      : [];
  const displayNames: string[] = Array.isArray(src.display_names)
    ? src.display_names.map((d: any) => String(d))
    : [];
  const cikNum = ciks.length ? Number(ciks[0]) : null;
  const accNoDash = adsh ? String(adsh).replace(/-/g, "") : null;
  return {
    filer: displayNames[0] ?? null,
    ...(displayNames.length > 1 ? { allFilers: displayNames } : {}),
    cik: ciks[0] ?? null,
    form: src.file_type ?? src.root_form ?? src.root_forms ?? null,
    fileDate: src.file_date ?? null,
    accessionNumber: adsh,
    documentUrl:
      cikNum != null && Number.isFinite(cikNum) && accNoDash && fileName
        ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${fileName}`
        : null,
    filingIndexUrl:
      cikNum != null && Number.isFinite(cikNum) && accNoDash
        ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/`
        : null,
  };
}

async function runFts(args: {
  query: string;
  forms?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  params.set("q", args.query);
  if (args.forms) params.set("forms", args.forms);
  if (args.startDate || args.endDate) {
    params.set("dateRange", "custom");
    if (args.startDate) params.set("startdt", args.startDate);
    if (args.endDate) params.set("enddt", args.endDate);
  }
  if (args.offset) params.set("from", String(args.offset));
  const raw = await jsonFetch<any>(`${EFTS_BASE}?${params.toString()}`);
  const hitsWrap = raw?.hits ?? {};
  const totalRaw = hitsWrap?.total;
  const total: number | null =
    typeof totalRaw === "number" ? totalRaw : totalRaw?.value ?? null;
  const hitList: any[] = Array.isArray(hitsWrap?.hits) ? hitsWrap.hits : [];
  const limit = Math.min(args.limit ?? 10, 10);
  const filings = hitList.slice(0, limit).map(parseHit);
  const parsedNothing = filings.length > 0 && filings.every((f) => !f.filer && !f.cik);
  return {
    totalMatches: total,
    returned: filings.length,
    filings,
    ...(parsedNothing && hitList.length ? { sampleRawHit: hitList[0] } : {}),
    ...(!hitList.length && raw && total == null ? { unparsedRaw: raw } : {}),
  };
}

export interface EdgarFullTextSearchArgs {
  query: string;
  forms?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export async function edgarFullTextSearch(args: EdgarFullTextSearchArgs) {
  if (!args.query || !String(args.query).trim()) {
    return {
      dataSource: "SEC EDGAR full-text search (efts.sec.gov, live)",
      error: "query is required — EDGAR full-text search needs a keyword or quoted phrase.",
      filings: [],
    };
  }
  const res = await runFts({
    query: String(args.query).trim(),
    forms: args.forms,
    startDate: args.startDate,
    endDate: args.endDate,
    limit: args.limit,
    offset: args.offset,
  });
  return {
    ...res,
    dataSource: "SEC EDGAR full-text search (efts.sec.gov, live)",
    request: {
      query: String(args.query).trim(),
      forms: args.forms ?? null,
      startDate: args.startDate ?? null,
      endDate: args.endDate ?? null,
      offset: args.offset ?? 0,
    },
    note:
      "Covers filing text from 2001 onward, across ALL filers (including private funds with no ticker). Use quoted phrases for exact match (e.g. '\"structured settlement\"'); forms is a comma-separated list (e.g. 'D', '8-K,10-K'). The API returns at most 10 hits per page — use offset (multiples of 10) to page. totalMatches is the full match count.",
  };
}

export interface FormdSearchArgs {
  query: string;
  startDate?: string;
  endDate?: string;
  includeAmendments?: boolean;
  limit?: number;
  offset?: number;
}

export async function formdSearch(args: FormdSearchArgs) {
  if (!args.query || !String(args.query).trim()) {
    return {
      dataSource: "SEC Form D search (EDGAR full-text, live)",
      error:
        "query is required — provide an issuer/fund keyword (e.g. 'credit fund', 'real estate', a GP name).",
      filings: [],
    };
  }
  // EDGAR FTS quirk (verified 2026-10-21): forms=D already returns D AND D/A,
  // while forms=D,D/A returns ONLY amendments — the old default silently
  // dropped most original filings. Exclude amendments client-side instead.
  const forms = "D";
  const res = await runFts({
    query: String(args.query).trim(),
    forms,
    startDate: args.startDate,
    endDate: args.endDate,
    limit: args.limit,
    offset: args.offset,
  });
  const initialOnly = args.includeAmendments === false;
  const filings = initialOnly ? res.filings.filter((f: any) => f.form === "D") : res.filings;
  return {
    ...res,
    filings,
    returned: filings.length,
    dataSource: "SEC Form D search (EDGAR full-text, live)",
    request: {
      query: String(args.query).trim(),
      forms,
      includeAmendments: !initialOnly,
      startDate: args.startDate ?? null,
      endDate: args.endDate ?? null,
      offset: args.offset ?? 0,
    },
    note:
      "Form D = Reg D exempt-offering notices: which GPs, private funds, and issuers are raising, filed within days of first sale. Amendments (D/A) included by default (includeAmendments=false for initial filings only). Date-bound with startDate/endDate (YYYY-MM-DD) for 'raising NOW'. Each hit's documentUrl is the primary_doc — the filing itself lists offering size, amount sold, minimum investment, and related persons. 10 hits per page; use offset to page; totalMatches is the full count.",
  };
}
