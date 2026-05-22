/**
 * U.S. Treasury Fiscal Data API client.
 *
 * Docs: https://fiscaldata.treasury.gov/api-documentation/
 * Base: https://api.fiscaldata.treasury.gov/services/api/fiscal_service/
 * Auth: None required.
 */

import { jsonFetch } from "../data/http";

const BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";

export interface FiscalApiMeta {
  count: number;
  labels: Record<string, string>;
  dataTypes: Record<string, string>;
  dataFormats: Record<string, string>;
  total_count: number;
  total_pages: number;
}

export interface FiscalApiResponse<T> {
  data: T[];
  meta: FiscalApiMeta;
  links?: { self?: string; first?: string; prev?: string; next?: string; last?: string };
}

export interface AvgRateRow {
  record_date: string;
  security_type_desc: string;
  security_desc: string;
  avg_interest_rate_amt: string;
  src_line_nbr?: string;
}

export async function avgInterestRates(asOfDate?: string): Promise<AvgRateRow[]> {
  const url = new URL(`${BASE}/v2/accounting/od/avg_interest_rates`);
  url.searchParams.set("format", "json");
  if (asOfDate) {
    url.searchParams.set("filter", `record_date:eq:${asOfDate}`);
    url.searchParams.set("page[size]", "200");
  } else {
    url.searchParams.set("sort", "-record_date");
    url.searchParams.set("page[size]", "50");
  }
  const resp = await jsonFetch<FiscalApiResponse<AvgRateRow>>(url.toString());
  if (resp.data.length === 0) return [];
  if (!asOfDate) {
    const latest = resp.data[0]!.record_date;
    return resp.data.filter((r) => r.record_date === latest);
  }
  return resp.data;
}

export interface SecuritiesOutstandingRow {
  record_date: string;
  security_type_desc: string;
  security_class_desc: string;
  total_mil_amt: string;
}

export async function securitiesOutstanding(asOfDate?: string): Promise<SecuritiesOutstandingRow[]> {
  const url = new URL(`${BASE}/v1/accounting/od/securities_outstanding`);
  url.searchParams.set("format", "json");
  if (asOfDate) {
    url.searchParams.set("filter", `record_date:eq:${asOfDate}`);
    url.searchParams.set("page[size]", "200");
  } else {
    url.searchParams.set("sort", "-record_date");
    url.searchParams.set("page[size]", "50");
  }
  const resp = await jsonFetch<FiscalApiResponse<SecuritiesOutstandingRow>>(url.toString());
  if (resp.data.length === 0) return [];
  if (!asOfDate) {
    const latest = resp.data[0]!.record_date;
    return resp.data.filter((r) => r.record_date === latest);
  }
  return resp.data;
}
