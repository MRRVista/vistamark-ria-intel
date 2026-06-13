/**
 * SEC EDGAR data clients (data.sec.gov + sec.gov). No auth — the SEC fair-access
 * policy only requires a declared User-Agent, which politeFetch already sends
 * ("Vistamark Intel ... mrice@vistamarkllc.com").
 *
 * Sources:
 *  - company_tickers.json : ticker/name -> CIK resolver map (~10k listed filers)
 *  - /submissions/CIK##########.json : company metadata + recent filing history
 *  - /api/xbrl/companyconcept/CIK##########/{taxonomy}/{concept}.json :
 *      one financial concept's full reported time series
 *
 * CIK must be zero-padded to 10 digits for the data.sec.gov endpoints; the
 * EDGAR Archives document path uses the un-padded CIK.
 */
import { jsonFetch } from "../data/http";

const SEC = "https://www.sec.gov";
const DATA = "https://data.sec.gov";

export function padCik(cik: string | number): string {
  const digits = String(cik).replace(/\D/g, "");
  return digits.padStart(10, "0");
}

export interface TickerEntry {
  cik: number;
  ticker: string;
  title: string;
}

// Memoized at module scope: the ticker map is ~1MB and reused across warm
// invocations of the same lambda. Cold starts refetch once.
let _tickers: TickerEntry[] | null = null;

export async function companyTickers(): Promise<TickerEntry[]> {
  if (_tickers) return _tickers;
  const raw = await jsonFetch<Record<string, { cik_str: number; ticker: string; title: string }>>(
    `${SEC}/files/company_tickers.json`
  );
  _tickers = Object.values(raw).map((r) => ({
    cik: r.cik_str,
    ticker: r.ticker,
    title: r.title,
  }));
  return _tickers;
}

export interface SubmissionsResponse {
  cik?: string;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  sic?: string;
  sicDescription?: string;
  category?: string;
  formerNames?: Array<{ name: string; from?: string; to?: string }>;
  addresses?: Record<string, any>;
  filings?: { recent?: Record<string, any[]> };
}

export async function submissions(cik: string | number): Promise<SubmissionsResponse> {
  return jsonFetch<SubmissionsResponse>(`${DATA}/submissions/CIK${padCik(cik)}.json`);
}

export interface ConceptUnitPoint {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

export interface CompanyConceptResponse {
  cik?: number;
  taxonomy?: string;
  tag?: string;
  label?: string;
  description?: string;
  units?: Record<string, ConceptUnitPoint[]>;
}

export async function companyConcept(
  cik: string | number,
  concept: string,
  taxonomy = "us-gaap"
): Promise<CompanyConceptResponse> {
  return jsonFetch<CompanyConceptResponse>(
    `${DATA}/api/xbrl/companyconcept/CIK${padCik(cik)}/${taxonomy}/${encodeURIComponent(concept)}.json`
  );
}
