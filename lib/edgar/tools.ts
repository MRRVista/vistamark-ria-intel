/**
 * MCP tool handlers for SEC EDGAR company intelligence (live).
 *
 * Tools:
 *   edgar_company_lookup     — resolve a ticker or company name to a CIK
 *   edgar_company_filings    — recent filing history for a company (by CIK/ticker/name)
 *   edgar_financial_concept  — a financial concept's XBRL time series (revenue, assets, ...)
 *
 * Complements the 13F dataset: 13F is holdings BY managers (keyed on CUSIP/
 * issuer); EDGAR is the issuer side — who the company is, what it has filed,
 * and its reported financials.
 */
import {
  companyTickers,
  submissions,
  companyConcept,
  padCik,
  type TickerEntry,
  type CompanyConceptResponse,
} from "./client";

async function resolveCik(args: {
  cik?: string | number;
  ticker?: string;
  name?: string;
}): Promise<{ cik: string | null; matched: TickerEntry | null }> {
  if (args.cik != null && String(args.cik).trim() !== "") {
    return { cik: padCik(args.cik), matched: null };
  }
  const tickers = await companyTickers();
  if (args.ticker) {
    const t = args.ticker.trim().toUpperCase();
    const hit = tickers.find((x) => x.ticker.toUpperCase() === t);
    if (hit) return { cik: padCik(hit.cik), matched: hit };
  }
  if (args.name) {
    const n = args.name.trim().toLowerCase();
    const exact = tickers.find((x) => x.title.toLowerCase() === n);
    const hit = exact ?? tickers.find((x) => x.title.toLowerCase().includes(n));
    if (hit) return { cik: padCik(hit.cik), matched: hit };
  }
  return { cik: null, matched: null };
}

export interface EdgarCompanyLookupArgs {
  query: string;
  limit?: number;
}

export async function edgarCompanyLookup(args: EdgarCompanyLookupArgs) {
  if (!args.query) throw new Error("edgar_company_lookup requires a query (ticker or company name).");
  const q = args.query.trim();
  const ql = q.toLowerCase();
  const qu = q.toUpperCase();
  const tickers = await companyTickers();
  const limit = Math.min(args.limit ?? 10, 100);
  const scored = tickers
    .map((x) => {
      let score = 0;
      if (x.ticker.toUpperCase() === qu) score = 100;
      else if (x.title.toLowerCase() === ql) score = 90;
      else if (x.ticker.toUpperCase().startsWith(qu)) score = 70;
      else if (x.title.toLowerCase().startsWith(ql)) score = 60;
      else if (x.title.toLowerCase().includes(ql)) score = 40;
      return { x, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    dataSource: "SEC EDGAR (company_tickers.json)",
    query: q,
    matchCount: scored.length,
    matches: scored.map((s) => ({
      cik: padCik(s.x.cik),
      cikNumeric: s.x.cik,
      ticker: s.x.ticker,
      name: s.x.title,
    })),
    note:
      scored.length === 0
        ? "No ticker/name match. Only companies with a listed ticker appear in this map; private companies and non-ticker filers are not included."
        : "Use a returned cik with edgar_company_filings or edgar_financial_concept.",
  };
}

export interface EdgarCompanyFilingsArgs {
  cik?: string | number;
  ticker?: string;
  name?: string;
  formType?: string;
  limit?: number;
}

export async function edgarCompanyFilings(args: EdgarCompanyFilingsArgs) {
  const { cik, matched } = await resolveCik(args);
  if (!cik) {
    return {
      dataSource: "SEC EDGAR (submissions)",
      error: "Could not resolve a CIK. Provide cik, a valid ticker, or a company name (try edgar_company_lookup first).",
      filings: [],
    };
  }
  const sub = await submissions(cik);
  const recent = sub.filings?.recent ?? {};
  const forms: string[] = recent.form ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const reportDates: string[] = recent.reportDate ?? [];
  const accs: string[] = recent.accessionNumber ?? [];
  const primaryDocs: string[] = recent.primaryDocument ?? [];
  const primaryDescs: string[] = recent.primaryDocDescription ?? [];
  const limit = Math.min(args.limit ?? 25, 200);
  const want = args.formType?.trim().toUpperCase() ?? null;
  const cikNumeric = Number(cik);
  const rows: any[] = [];
  for (let i = 0; i < forms.length && rows.length < limit; i++) {
    if (want && String(forms[i] ?? "").toUpperCase() !== want) continue;
    const acc = accs[i] ?? "";
    const accNoDashes = acc.replace(/-/g, "");
    rows.push({
      form: forms[i] ?? null,
      filingDate: dates[i] ?? null,
      reportDate: reportDates[i] ?? null,
      accessionNumber: acc || null,
      primaryDocument: primaryDocs[i] ?? null,
      description: primaryDescs[i] ?? null,
      filingUrl: acc
        ? `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accNoDashes}/${primaryDocs[i] ?? ""}`
        : null,
    });
  }
  return {
    dataSource: "SEC EDGAR (submissions)",
    company: {
      cik,
      name: sub.name ?? matched?.title ?? null,
      tickers: sub.tickers ?? null,
      exchanges: sub.exchanges ?? null,
      sic: sub.sic ?? null,
      sicDescription: sub.sicDescription ?? null,
      formerNames: sub.formerNames ?? null,
    },
    formTypeFilter: want,
    filingCount: rows.length,
    filings: rows,
    note:
      "Covers the submissions API 'recent' block (~1000 latest filings). filingUrl points at the primary document on EDGAR. Common formType values: 10-K, 10-Q, 8-K, DEF 14A, 13F-HR, SC 13D, SC 13G, 4.",
  };
}

// Common alternate XBRL tags for line items that filers report under different
// concepts across years/companies. Tried when the requested concept returns
// no data OR when its latest fact is STALE (e.g. Apple reported Revenues only
// through FY2018, then switched to
// RevenueFromContractWithCustomerExcludingAssessedTax — the old tag still has
// data, so an empty-only fallback never fires; freshness has to be the trigger).
const CONCEPT_FALLBACKS: Record<string, string[]> = {
  Revenues: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  RevenueFromContractWithCustomerExcludingAssessedTax: [
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  NetIncomeLoss: ["ProfitLoss"],
};

// A concept counts as stale when its most recent fact ended more than ~18
// months ago — an actively used tag gets a new fact at least annually, filed
// within a few months of period end, so 550 days is a safe threshold.
const STALE_MS = 550 * 24 * 60 * 60 * 1000;

function conceptHasData(data: CompanyConceptResponse | null): boolean {
  if (!data || !data.units) return false;
  return Object.values(data.units).some((arr) => Array.isArray(arr) && arr.length > 0);
}

function latestEnd(data: CompanyConceptResponse | null): string | null {
  if (!data || !data.units) return null;
  let max: string | null = null;
  for (const arr of Object.values(data.units)) {
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      const e = (p as any)?.end;
      if (typeof e === "string" && (max === null || e > max)) max = e;
    }
  }
  return max;
}

function isStale(end: string | null): boolean {
  if (!end) return true;
  const t = Date.parse(end);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > STALE_MS;
}

async function tryConcept(
  cik: string,
  concept: string,
  taxonomy: string
): Promise<CompanyConceptResponse | null> {
  try {
    const data = await companyConcept(cik, concept, taxonomy);
    return conceptHasData(data) ? data : null;
  } catch {
    // Non-OK (usually 404 — filer never reported this exact tag).
    return null;
  }
}

/**
 * Fetch a concept with freshness-aware fallback.
 *
 * Fast path: if the requested concept has data and its latest fact is recent,
 * return it (one API call, no fallback traffic). Otherwise fetch the known
 * alternate tags in parallel and return whichever candidate has the MOST
 * RECENT latest fact — the requested concept wins ties. staleFallbackUsed
 * flags the case where the requested tag had data but a fresher alternate
 * was chosen; candidateLatest reports each candidate's latest fact end-date
 * so the switch is auditable.
 */
async function fetchConceptWithFallback(
  cik: string,
  concept: string,
  taxonomy: string
): Promise<{
  data: CompanyConceptResponse | null;
  resolvedConcept: string | null;
  tried: string[];
  candidateLatest: Record<string, string | null>;
  staleFallbackUsed: boolean;
}> {
  const fallbacks = CONCEPT_FALLBACKS[concept] ?? [];
  const tried: string[] = [concept];
  const candidateLatest: Record<string, string | null> = {};

  const primary = await tryConcept(cik, concept, taxonomy);
  const primaryEnd = latestEnd(primary);
  candidateLatest[concept] = primaryEnd;

  if (primary && !isStale(primaryEnd)) {
    return { data: primary, resolvedConcept: concept, tried, candidateLatest, staleFallbackUsed: false };
  }
  if (fallbacks.length === 0) {
    return {
      data: primary,
      resolvedConcept: primary ? concept : null,
      tried,
      candidateLatest,
      staleFallbackUsed: false,
    };
  }

  tried.push(...fallbacks);
  const results = await Promise.all(fallbacks.map((c) => tryConcept(cik, c, taxonomy)));

  let best: { concept: string; data: CompanyConceptResponse; end: string | null } | null = primary
    ? { concept, data: primary, end: primaryEnd }
    : null;
  for (let i = 0; i < fallbacks.length; i++) {
    const d = results[i];
    const e = latestEnd(d);
    candidateLatest[fallbacks[i]] = e;
    if (d && (best === null || (e ?? "") > (best.end ?? ""))) {
      best = { concept: fallbacks[i], data: d, end: e };
    }
  }

  if (best === null) {
    return { data: null, resolvedConcept: null, tried, candidateLatest, staleFallbackUsed: false };
  }
  return {
    data: best.data,
    resolvedConcept: best.concept,
    tried,
    candidateLatest,
    staleFallbackUsed: primary !== null && best.concept !== concept,
  };
}

export interface EdgarFinancialConceptArgs {
  cik?: string | number;
  ticker?: string;
  name?: string;
  concept: string;
  taxonomy?: string;
  unit?: string;
  annualOnly?: boolean;
  limit?: number;
}

export async function edgarFinancialConcept(args: EdgarFinancialConceptArgs) {
  if (!args.concept) {
    throw new Error(
      "edgar_financial_concept requires a concept (e.g. Revenues, Assets, Liabilities, NetIncomeLoss, StockholdersEquity)."
    );
  }
  const { cik, matched } = await resolveCik(args);
  if (!cik) {
    return {
      dataSource: "SEC EDGAR (XBRL companyconcept)",
      error: "Could not resolve a CIK. Provide cik, ticker, or name (try edgar_company_lookup first).",
      observations: [],
    };
  }
  const taxonomy = args.taxonomy?.trim() || "us-gaap";
  const { data, resolvedConcept, tried, candidateLatest, staleFallbackUsed } =
    await fetchConceptWithFallback(cik, args.concept, taxonomy);
  if (!data || !resolvedConcept) {
    return {
      dataSource: "SEC EDGAR (XBRL companyconcept)",
      company: { cik, name: matched?.title ?? null },
      requestedConcept: args.concept,
      taxonomy,
      conceptsTried: tried,
      candidateLatest,
      observationCount: 0,
      observations: [],
      note:
        `No XBRL data for "${args.concept}"` +
        (tried.length > 1 ? ` or its known fallbacks (${tried.slice(1).join(", ")})` : "") +
        ` under taxonomy "${taxonomy}" for this filer. The company may tag this line item under a different concept — inspect filings with edgar_company_filings, or pass an explicit alternate via the concept argument.`,
    };
  }
  const units = data.units ?? {};
  const unitKey = args.unit && units[args.unit] ? args.unit : Object.keys(units)[0] ?? null;
  let points: Array<Record<string, any>> = unitKey ? units[unitKey]! : [];
  if (args.annualOnly) {
    points = points.filter(
      (p) => String(p.form ?? "").toUpperCase().startsWith("10-K") || p.fp === "FY"
    );
  }
  points = [...points].sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const limit = Math.min(args.limit ?? 40, 500);
  const trimmed = points.slice(-limit);
  return {
    dataSource: "SEC EDGAR (XBRL companyconcept)",
    company: { cik, name: matched?.title ?? null },
    requestedConcept: args.concept,
    resolvedConcept,
    conceptFallbackUsed: resolvedConcept !== args.concept,
    staleFallbackUsed,
    conceptsTried: tried,
    candidateLatest,
    concept: data.tag ?? resolvedConcept,
    taxonomy,
    label: data.label ?? null,
    unit: unitKey,
    observationCount: trimmed.length,
    latest: trimmed.length ? trimmed[trimmed.length - 1] : null,
    observations: trimmed.map((p) => ({
      end: p.end ?? null,
      start: p.start ?? null,
      value: p.val ?? null,
      fy: p.fy ?? null,
      fp: p.fp ?? null,
      form: p.form ?? null,
      filed: p.filed ?? null,
      frame: p.frame ?? null,
    })),
    note:
      "XBRL facts as reported. Concepts use us-gaap taxonomy tags. When the requested concept returns nothing OR its latest fact is stale (>~18 months old — filers switch tags across years, e.g. Revenues -> RevenueFromContractWithCustomerExcludingAssessedTax), common alternates are tried and the FRESHEST tag wins. resolvedConcept shows which tag returned the data; staleFallbackUsed flags a freshness-triggered switch; candidateLatest reports each candidate's latest fact date so the choice is auditable. annualOnly filters to 10-K / full-year facts.",
  };
}
