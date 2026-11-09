/**
 * USDA NASS Quick Stats API client.
 *
 * Docs: https://quickstats.nass.usda.gov/api
 * Base: https://quickstats.nass.usda.gov/api/
 * Auth: free API key (register at the docs URL), passed as `key=`.
 *
 * Quick Stats is a flat denormalised table: every observation carries the
 * full set of descriptor columns (sector_desc, commodity_desc, class_desc,
 * statisticcat_desc, unit_desc, short_desc, agg_level_desc, state_alpha,
 * region_desc, year, reference_period_desc, Value, ...). Filtering is by
 * exact match on any of those columns. A single api_GET call is capped at
 * 50,000 records; the land-value and cash-rent series are a few thousand
 * rows at most even at STATE level, so one call per query is always enough.
 *
 * `Value` arrives as a formatted string ("4,500", "(D)" for disclosure-
 * suppressed, "(NA)", "(Z)" for <0.5). parseValue() returns null for every
 * non-numeric marker rather than coercing to 0 — same rule as the FRED
 * client ("." -> null).
 */

import { jsonFetch } from "../data/http";

const BASE = "https://quickstats.nass.usda.gov/api";

export function nassKey(): string {
  const key = process.env.NASS_API_KEY;
  if (!key) {
    throw new Error(
      "NASS_API_KEY not configured. Request a free key at https://quickstats.nass.usda.gov/api and set it as NASS_API_KEY in Vercel environment variables (redeploy required)."
    );
  }
  return key;
}

/** One Quick Stats record. Only the columns this codebase reads are typed. */
export interface NassRecord {
  source_desc: string;
  sector_desc: string;
  group_desc: string;
  commodity_desc: string;
  class_desc: string;
  prodn_practice_desc: string;
  util_practice_desc: string;
  statisticcat_desc: string;
  unit_desc: string;
  short_desc: string;
  domain_desc: string;
  domaincat_desc: string;
  agg_level_desc: string;
  state_alpha: string;
  state_name: string;
  region_desc: string;
  year: number | string;
  freq_desc: string;
  reference_period_desc: string;
  load_time: string;
  Value: string;
  CV: string;
}

export type NassFilters = Record<string, string | number | undefined>;

/**
 * GET /api_GET — rows matching every supplied filter (exact match).
 * Operator suffixes are supported by Quick Stats: `year__GE`, `year__LE`,
 * `year__LIKE`, etc. Pass them as literal keys.
 */
export async function getQuickStats(filters: NassFilters): Promise<NassRecord[]> {
  const url = new URL(`${BASE}/api_GET/`);
  url.searchParams.set("key", nassKey());
  url.searchParams.set("format", "JSON");
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  // Quick Stats returns {"data":[...]} on success and
  // {"error":["exceeds limit=50000"]} / {"error":["bad request - invalid query"]} on failure.
  const resp = await jsonFetch<{ data?: NassRecord[]; error?: string[] }>(url.toString(), {
    timeoutMs: 55000,
  });
  if (resp.error?.length) throw new Error(`NASS Quick Stats: ${resp.error.join("; ")}`);
  return resp.data ?? [];
}

/** GET /get_param_values — distinct values of one descriptor column, optionally narrowed by other filters. */
export async function getParamValues(param: string, filters: NassFilters = {}): Promise<string[]> {
  const url = new URL(`${BASE}/get_param_values/`);
  url.searchParams.set("key", nassKey());
  url.searchParams.set("param", param);
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const resp = await jsonFetch<Record<string, string[]>>(url.toString(), { timeoutMs: 55000 });
  return resp[param] ?? [];
}

/** "4,500" -> 4500; "(D)" / "(NA)" / "(Z)" / "" -> null. Never 0 for a marker. */
export function parseValue(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = v.trim();
  if (!t || t.startsWith("(")) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
