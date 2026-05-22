/**
 * Federal Reserve Economic Data (FRED) API v3 client.
 *
 * Docs: https://fred.stlouisfed.org/docs/api/fred/
 * Base: https://api.stlouisfed.org/fred/
 * Auth: API key required (free, register at https://fred.stlouisfed.org/docs/api/api_key.html)
 */

import { jsonFetch } from "../data/http";

const BASE = "https://api.stlouisfed.org/fred";

export function fredKey(): string {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    throw new Error(
      "FRED_API_KEY not configured. Register a free key at https://fred.stlouisfed.org/docs/api/api_key.html and set it as FRED_API_KEY in Vercel environment variables (redeploy required)."
    );
  }
  return key;
}

export interface FredSeries {
  id: string;
  realtime_start?: string;
  realtime_end?: string;
  title: string;
  observation_start: string;
  observation_end: string;
  frequency: string;
  frequency_short: string;
  units: string;
  units_short: string;
  seasonal_adjustment: string;
  seasonal_adjustment_short: string;
  last_updated: string;
  popularity: number;
  notes?: string;
}

export interface FredSearchResponse {
  count: number;
  offset: number;
  limit: number;
  order_by?: string;
  sort_order?: string;
  seriess: FredSeries[];
}

export interface FredObservation {
  realtime_start: string;
  realtime_end: string;
  date: string;
  value: string;
}

export interface FredObservationsResponse {
  observation_start: string;
  observation_end: string;
  units: string;
  count: number;
  offset: number;
  limit: number;
  observations: FredObservation[];
}

export async function searchSeries(query: string, limit = 25): Promise<FredSearchResponse> {
  const url = new URL(`${BASE}/series/search`);
  url.searchParams.set("api_key", fredKey());
  url.searchParams.set("file_type", "json");
  url.searchParams.set("search_text", query);
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 1000)));
  url.searchParams.set("order_by", "popularity");
  url.searchParams.set("sort_order", "desc");
  return jsonFetch<FredSearchResponse>(url.toString());
}

export async function getSeries(seriesId: string): Promise<FredSeries | null> {
  const url = new URL(`${BASE}/series`);
  url.searchParams.set("api_key", fredKey());
  url.searchParams.set("file_type", "json");
  url.searchParams.set("series_id", seriesId);
  const resp = await jsonFetch<{ seriess: FredSeries[] }>(url.toString());
  return resp.seriess?.[0] ?? null;
}

export interface ObservationsParams {
  observationStart?: string;
  observationEnd?: string;
  frequency?: "d" | "w" | "bw" | "m" | "q" | "sa" | "a";
  units?: "lin" | "chg" | "ch1" | "pch" | "pc1" | "pca" | "cch" | "cca" | "log";
  limit?: number;
  sortOrder?: "asc" | "desc";
}

export async function getObservations(
  seriesId: string,
  opts: ObservationsParams = {}
): Promise<FredObservationsResponse> {
  const url = new URL(`${BASE}/series/observations`);
  url.searchParams.set("api_key", fredKey());
  url.searchParams.set("file_type", "json");
  url.searchParams.set("series_id", seriesId);
  if (opts.observationStart) url.searchParams.set("observation_start", opts.observationStart);
  if (opts.observationEnd) url.searchParams.set("observation_end", opts.observationEnd);
  if (opts.frequency) url.searchParams.set("frequency", opts.frequency);
  if (opts.units) url.searchParams.set("units", opts.units);
  url.searchParams.set("limit", String(Math.min(opts.limit ?? 1000, 100000)));
  url.searchParams.set("sort_order", opts.sortOrder ?? "desc");
  return jsonFetch<FredObservationsResponse>(url.toString());
}
