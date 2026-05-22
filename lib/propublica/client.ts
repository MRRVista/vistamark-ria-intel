/**
 * ProPublica Nonprofit Explorer API v2 client.
 *
 * Docs:    https://projects.propublica.org/nonprofits/api
 * Base:    https://projects.propublica.org/nonprofits/api/v2
 * Auth:    None required.
 * Limits:  ~60 requests / minute. We don't throttle aggressively; politeFetch
 *          handles 429s with exponential backoff.
 *
 * Endpoints used:
 *   GET /search.json?q=&state[id]=&ntee[id]=&c_code[id]=&page=
 *   GET /organizations/{ein}.json
 */

import { jsonFetch } from "../data/http";

const BASE = "https://projects.propublica.org/nonprofits/api/v2";

export interface PpSearchOrg {
  ein: number;
  strein?: string;
  name: string;
  sub_name?: string;
  city?: string;
  state?: string;
  ntee_code?: string;
  raw_ntee_code?: string;
  subseccd?: number;
  has_subseccd?: boolean;
  have_filings?: boolean;
  have_extracts?: boolean;
  have_pdfs?: boolean;
  score?: number;
}

export interface PpSearchResponse {
  total_results: number;
  organizations: PpSearchOrg[];
  num_pages: number;
  cur_page: number;
  page_offset: number;
  per_page: number;
  search_query?: string;
  selected_state?: unknown;
  selected_ntee?: unknown;
  selected_subsection?: unknown;
  data_source?: string;
  api_version?: string;
}

export interface PpOrgDetail {
  ein: number;
  strein?: string;
  name: string;
  careofname?: string;
  address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  exemption_number?: number;
  subseccd?: number;
  affiliation_code?: number;
  classification_codes?: string;
  ruling_date?: string;
  deductibility_code?: number;
  foundation_code?: number;
  activity_codes?: string;
  organization_code?: number;
  status_code?: number;
  tax_period?: number;
  asset_code?: number;
  income_code?: number;
  filing_req_code?: string;
  pf_filing_req_code?: string;
  accounting_period?: number;
  asset_amount?: number;
  income_amount?: number;
  revenue_amount?: number;
  ntee_code?: string;
  sort_name?: string;
  data_source?: string;
}

export interface PpFiling {
  tax_prd?: number;
  tax_prd_yr?: number;
  formtype?: number;
  pdf_url?: string;
  updated?: string;
  totrevenue?: number;
  totfuncexpns?: number;
  totassetsend?: number;
  totliabend?: number;
  pct_compnsatncurrofcr?: number;
  totprgmrevnue?: number;
  invstmntinc?: number;
  txexmptbndsproceeds?: number;
  royaltsinc?: number;
  grsrntsreal?: number;
  grsrntsprsnl?: number;
  rntlexpnsreal?: number;
  rntlexpnsprsnl?: number;
  rntlincreal?: number;
  rntlincprsnl?: number;
  netrntlinc?: number;
  grsalesecur?: number;
  grsalesothr?: number;
  cstbasisecur?: number;
  cstbasisothr?: number;
  gnlsecur?: number;
  gnlsothr?: number;
  netgnls?: number;
  totrcptperbks?: number;
  totexpnspbks?: number;
  excessrcpts?: number;
  netinvinc?: number;
  totnetassetend?: number;
}

export interface PpOrgResponse {
  organization: PpOrgDetail;
  filings_with_data: PpFiling[];
  filings_without_data: PpFiling[];
  data_source?: string;
  api_version?: string;
}

export interface SearchParams {
  q: string;
  state?: string;
  ntee?: number;
  cCode?: number;
  page?: number;
}

export async function searchOrganizations(params: SearchParams): Promise<PpSearchResponse> {
  const url = new URL(`${BASE}/search.json`);
  url.searchParams.set("q", params.q);
  if (params.state) url.searchParams.set("state[id]", params.state.toUpperCase());
  if (params.ntee != null) url.searchParams.set("ntee[id]", String(params.ntee));
  if (params.cCode != null) url.searchParams.set("c_code[id]", String(params.cCode));
  if (params.page != null) url.searchParams.set("page", String(params.page));
  return jsonFetch<PpSearchResponse>(url.toString());
}

export async function getOrganization(ein: string | number): Promise<PpOrgResponse> {
  const normalized = String(ein).replace(/\D/g, "");
  if (normalized.length !== 9) {
    throw new Error(`Invalid EIN: ${ein} (must be 9 digits after stripping punctuation)`);
  }
  const url = `${BASE}/organizations/${normalized}.json`;
  return jsonFetch<PpOrgResponse>(url);
}
