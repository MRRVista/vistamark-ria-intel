/**
 * Apollo.io API client — B2B contact + company enrichment.
 *
 * Docs: https://docs.apollo.io/reference
 * Base: https://api.apollo.io/api/v1
 * Auth: `x-api-key` header (APOLLO_API_KEY). API access is included on the
 *       Free plan with per-plan throttles (Free: ~50 req/min, 200/hr,
 *       600/day on enrichment); paid tiers raise the limits.
 *
 * Endpoints used:
 *   POST /mixed_people/search     — people search (no credits; emails locked)
 *   POST /people/match            — enrich ONE person (1 credit per email found,
 *                                   8 per phone when revealed)
 *   POST /people/bulk_match       — enrich up to 10 people in one call
 *   POST /mixed_companies/search  — organization search (no credits)
 *   GET  /organizations/enrich    — organization profile by domain
 *
 * CREDIT DISCIPLINE: search endpoints never spend credits; only the match
 * endpoints do, and only when Apollo actually returns an email/phone. Phone
 * reveal is OFF by default everywhere (8 credits each, and a mobile number is
 * the wrong channel for first-touch outreach anyway). Personal-email reveal
 * is also OFF by default — the outreach stack only ever uses published
 * PROFESSIONAL addresses (see lib/prospects/append.ts), so matching Apollo's
 * default keeps that rule intact.
 *
 * CREDENTIAL SAFETY: the key rides in a header, never the URL, so redactUrl()
 * has nothing to scrub — but every call still goes through lib/data/http.ts
 * for the User-Agent, retry/backoff (429 is common on the free tier), and the
 * status guard. Do not fetch() Apollo directly.
 */

import { jsonFetch } from "../data/http";

const BASE = "https://api.apollo.io/api/v1";

export function apolloKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    throw new Error(
      "APOLLO_API_KEY not configured. Create an API key at app.apollo.io -> Settings -> Integrations -> API and set it as APOLLO_API_KEY in Vercel environment variables (redeploy required)."
    );
  }
  return key;
}

function headers(): Record<string, string> {
  return {
    "x-api-key": apolloKey(),
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  };
}

/** POST a JSON body to an Apollo endpoint. Undefined/null/empty values are dropped. */
export async function apolloPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = v;
  }
  return jsonFetch<T>(`${BASE}/${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(clean),
    // Apollo's free tier 429s readily; politeFetch already backs off on 429.
    retries: 3,
    timeoutMs: 25000,
  });
}

/** GET an Apollo endpoint with query params. */
export async function apolloGet<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return jsonFetch<T>(url.toString(), { method: "GET", headers: headers(), retries: 3, timeoutMs: 25000 });
}

// ---------- response shapes (fields we actually surface) ----------

export interface ApolloOrgLite {
  id?: string;
  name?: string;
  website_url?: string | null;
  primary_domain?: string | null;
  linkedin_url?: string | null;
  industry?: string | null;
  estimated_num_employees?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface ApolloPhone {
  raw_number?: string;
  sanitized_number?: string;
  type?: string | null; // mobile | work_hq | other
  status?: string | null;
}

export interface ApolloPerson {
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  headline?: string | null;
  seniority?: string | null;
  departments?: string[];
  email?: string | null;
  email_status?: string | null; // verified | guessed | unavailable | bounced | pending_manual_fulfillment
  personal_emails?: string[];
  phone_numbers?: ApolloPhone[];
  linkedin_url?: string | null;
  twitter_url?: string | null;
  photo_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  organization?: ApolloOrgLite | null;
  organization_name?: string | null;
  employment_history?: Array<{
    organization_name?: string | null;
    title?: string | null;
    start_date?: string | null;
    end_date?: string | null;
    current?: boolean | null;
  }>;
}

export interface ApolloPagination {
  page?: number;
  per_page?: number;
  total_entries?: number;
  total_pages?: number;
}

export interface ApolloPeopleSearchResponse {
  people?: ApolloPerson[];
  contacts?: ApolloPerson[];
  pagination?: ApolloPagination;
  /** mixed_people/api_search returns a flat total instead of a pagination block */
  total_entries?: number;
}

export interface ApolloMatchResponse {
  person?: ApolloPerson | null;
}

export interface ApolloBulkMatchResponse {
  matches?: Array<ApolloPerson | null>;
  status?: string;
  total_requested_enrichments?: number;
  unique_enriched_records?: number;
  missing_records?: number;
  credits_consumed?: number;
}

export interface ApolloOrganization extends ApolloOrgLite {
  short_description?: string | null;
  founded_year?: number | null;
  annual_revenue?: number | null;
  annual_revenue_printed?: string | null;
  total_funding?: number | null;
  publicly_traded_symbol?: string | null;
  publicly_traded_exchange?: string | null;
  phone?: string | null;
  raw_address?: string | null;
  street_address?: string | null;
  postal_code?: string | null;
  keywords?: string[];
  technology_names?: string[];
  retail_location_count?: number | null;
}

export interface ApolloOrgSearchResponse {
  organizations?: ApolloOrganization[];
  accounts?: ApolloOrganization[];
  pagination?: ApolloPagination;
}

export interface ApolloOrgEnrichResponse {
  organization?: ApolloOrganization | null;
}

/** Apollo returns a placeholder for locked emails in search results. */
export function isLockedEmail(email: string | null | undefined): boolean {
  return !!email && /email_not_unlocked/i.test(email);
}
