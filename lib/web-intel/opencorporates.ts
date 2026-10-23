/**
 * OpenCorporates API v0.4 — https://api.opencorporates.com/v0.4/
 *   companies/search?q=..&jurisdiction_code=us_il&api_token=..
 *   officers/search?q=..&jurisdiction_code=us_il&api_token=..
 * KEYED ONLY. Verified 2026-10-22 from the sandbox: every keyless request
 * (with or without a browser UA) returns HTTP 401 {"error":{"message":"Invalid
 * Api Token..."}} — OpenCorporates withdrew its anonymous tier in 2025, so the
 * tool requires OPENCORPORATES_API_TOKEN and fails fast without it. Response
 * shape below follows the public v0.4 docs (results.companies[].company /
 * results.officers[].officer); it could not be exercised live. Cached 6 h.
 */
import { cached, clampInt, HOUR, jsonWithBackoff, trim } from "./common";

const BASE = "https://api.opencorporates.com/v0.4";

function token(): string {
  const t = process.env.OPENCORPORATES_API_TOKEN?.trim();
  if (!t) throw new Error("OPENCORPORATES_API_TOKEN not configured — OpenCorporates no longer serves anonymous API calls (HTTP 401). Request a key at https://opencorporates.com/api_accounts/new (free for public-benefit / low volume; paid otherwise), then set OPENCORPORATES_API_TOKEN in Vercel.");
  return t;
}

function normJurisdiction(j: unknown): string | undefined {
  if (!j) return undefined;
  const s = String(j).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s) && s !== "us" && s !== "gb") return `us_${s}`; // bare US state code
  return s;
}

export async function opencorporatesSearch(args: any) {
  const q = String(args?.query ?? "").trim();
  if (!q) throw new Error("opencorporates_search: `query` (company name) is required");
  const key = token();
  const limit = clampInt(args?.limit, 10, 1, 25);
  const params = new URLSearchParams({ q, per_page: String(limit), order: "score" });
  const jur = normJurisdiction(args?.jurisdiction);
  if (jur) params.set("jurisdiction_code", jur);
  if (args?.inactive === false) params.set("inactive", "false");
  const url = `${BASE}/companies/search?${params.toString()}`;
  const data = await cached(`oc:companies:${url}`, 6 * HOUR, () =>
    jsonWithBackoff<any>(`${url}&api_token=${encodeURIComponent(key)}`, { source: "OpenCorporates", retryAfterMs: 2000 })
  );
  const res = data?.results ?? {};
  const companies = (res.companies ?? []).map((w: any) => {
    const c = w.company ?? w;
    return {
      name: c.name,
      companyNumber: c.company_number,
      jurisdiction: c.jurisdiction_code,
      status: c.current_status ?? null,
      inactive: c.inactive ?? null,
      type: c.company_type ?? null,
      incorporated: c.incorporation_date ?? null,
      dissolved: c.dissolution_date ?? null,
      registeredAddress: trim(c.registered_address_in_full, 160),
      registryUrl: c.registry_url ?? null,
      url: c.opencorporates_url ?? null,
      officersUrl: c.opencorporates_url ? `${c.opencorporates_url}#officers` : null,
      officersApi: `${BASE}/companies/${c.jurisdiction_code}/${c.company_number}`,
    };
  });
  return {
    source: "OpenCorporates API v0.4 (companies/search)",
    fetchedAt: new Date().toISOString(),
    query: q,
    jurisdiction: jur ?? "all",
    totalMatches: res.total_count ?? null,
    returned: companies.length,
    companies,
  };
}

export async function opencorporatesOfficers(args: any) {
  const q = String(args?.name ?? args?.query ?? "").trim();
  if (!q) throw new Error("opencorporates_officers: `name` (person name) is required");
  const key = token();
  const limit = clampInt(args?.limit, 10, 1, 25);
  const params = new URLSearchParams({ q, per_page: String(limit) });
  const jur = normJurisdiction(args?.jurisdiction);
  if (jur) params.set("jurisdiction_code", jur);
  if (args?.position) params.set("position", String(args.position));
  const url = `${BASE}/officers/search?${params.toString()}`;
  const data = await cached(`oc:officers:${url}`, 6 * HOUR, () =>
    jsonWithBackoff<any>(`${url}&api_token=${encodeURIComponent(key)}`, { source: "OpenCorporates", retryAfterMs: 2000 })
  );
  const res = data?.results ?? {};
  const officers = (res.officers ?? []).map((w: any) => {
    const o = w.officer ?? w;
    return {
      name: o.name,
      position: o.position ?? null,
      startDate: o.start_date ?? null,
      endDate: o.end_date ?? null,
      jurisdiction: o.jurisdiction_code ?? o.company?.jurisdiction_code ?? null,
      company: o.company?.name ?? null,
      companyNumber: o.company?.company_number ?? null,
      companyUrl: o.company?.opencorporates_url ?? null,
      url: o.opencorporates_url ?? null,
    };
  });
  return {
    source: "OpenCorporates API v0.4 (officers/search)",
    fetchedAt: new Date().toISOString(),
    query: q,
    jurisdiction: jur ?? "all",
    totalMatches: res.total_count ?? null,
    returned: officers.length,
    officers,
  };
}
