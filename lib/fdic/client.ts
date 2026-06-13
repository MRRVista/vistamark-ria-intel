/**
 * FDIC BankFind Suite API client.
 *
 * Docs: https://banks.data.fdic.gov/docs/
 * Base: https://banks.data.fdic.gov/api
 * Auth: none required (public API).
 *
 * Endpoints used:
 *   /institutions  — FDIC-insured institutions, current snapshot (one row per bank)
 *   /financials    — quarterly financial time series (one row per bank per report date)
 *   /failures      — historical bank/thrift failures
 *
 * Response envelope: { data: [ { data: { <FIELD>: value }, score }, ... ], meta, totals }
 * IMPORTANT: dollar fields (ASSET, DEP, EQ, NETINC, QBFDEP, QBFASSET, COST) are reported
 * in THOUSANDS of dollars by the FDIC. The tools layer converts to whole USD.
 */
import { jsonFetch } from "../data/http";

const BASE = "https://banks.data.fdic.gov/api";

export interface FdicEnvelope<T> {
  data: Array<{ data: T; score?: number }>;
  meta?: { total?: number; parameters?: Record<string, unknown> };
  totals?: { count?: number };
}

export interface FdicQuery {
  filters?: string;   // Lucene-style, e.g. "STALP:IL AND ACTIVE:1 AND ASSET:[1000000 TO *]"
  search?: string;    // full-text, e.g. "NAME:first business"
  fields?: string[];  // field allowlist
  sortBy?: string;    // e.g. "ASSET"
  sortOrder?: "ASC" | "DESC";
  limit?: number;
  offset?: number;
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function fdicFetch<T>(endpoint: string, q: FdicQuery): Promise<{ rows: T[]; total: number }> {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("format", "json");
  if (q.filters) url.searchParams.set("filters", q.filters);
  if (q.search) url.searchParams.set("search", q.search);
  if (q.fields && q.fields.length) url.searchParams.set("fields", q.fields.join(","));
  if (q.sortBy) url.searchParams.set("sort_by", q.sortBy);
  if (q.sortOrder) url.searchParams.set("sort_order", q.sortOrder);
  url.searchParams.set("limit", String(q.limit ?? 25));
  url.searchParams.set("offset", String(q.offset ?? 0));
  const resp = await jsonFetch<FdicEnvelope<T>>(url.toString());
  const rows = (resp.data ?? []).map((d) => d.data);
  const total = resp.totals?.count ?? resp.meta?.total ?? rows.length;
  return { rows, total };
}

export interface FdicInstitution {
  NAME?: string; CERT?: string | number; CITY?: string; STALP?: string; STNAME?: string;
  ZIP?: string | number; ASSET?: string | number; DEP?: string | number; NETINC?: string | number;
  ROA?: string | number; ROE?: string | number; EQ?: string | number; OFFICES?: string | number;
  ESTYMD?: string; ACTIVE?: string | number; BKCLASS?: string; CB?: string | number;
  WEBADDR?: string; REPDTE?: string; NUMEMP?: string | number;
}

export async function searchInstitutions(q: FdicQuery) {
  return fdicFetch<FdicInstitution>("institutions", q);
}

export interface FdicFinancial {
  CERT?: string | number; REPDTE?: string; ASSET?: string | number; DEP?: string | number;
  NETINC?: string | number; ROA?: string | number; ROE?: string | number; EQ?: string | number;
  NIMY?: string | number; EEFFR?: string | number; NUMEMP?: string | number; DEPDOM?: string | number;
}

export async function institutionFinancials(q: FdicQuery) {
  return fdicFetch<FdicFinancial>("financials", q);
}

export interface FdicFailure {
  NAME?: string; CERT?: string | number; FAILDATE?: string; FAILYR?: string | number;
  PSTALP?: string; CITYST?: string; RESTYPE?: string; SAVR?: string;
  QBFDEP?: string | number; QBFASSET?: string | number; COST?: string | number;
}

export async function bankFailures(q: FdicQuery) {
  return fdicFetch<FdicFailure>("failures", q);
}
