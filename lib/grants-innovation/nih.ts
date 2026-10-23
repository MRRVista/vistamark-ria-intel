/**
 * NIH RePORTER v2 — https://api.reporter.nih.gov/v2/projects/search (POST JSON)
 * and /v2/publications/search. Keyless. GET on these paths returns 405.
 * Covers NIH (plus CDC/FDA/AHRQ/VA-administered) awards FY1985+; refreshed weekly.
 *
 * Criteria verified live: org_names (substring, case-insensitive), org_cities,
 * org_states, fiscal_years, pi_names [{any_name|first_name|last_name}],
 * award_amount_range {min_amount,max_amount}, advanced_text_search.
 * Sorting: sort_field=award_amount|fiscal_year|project_start_date, sort_order.
 * Max limit 500/call, offset ≤ 14,999.
 */
import { cached, clampInt, HOUR, iso, postJson, sumBy, trunc } from "./common";

const BASE = "https://api.reporter.nih.gov/v2";

const FIELDS = [
  "ProjectNum", "CoreProjectNum", "PrincipalInvestigators", "Organization", "FiscalYear",
  "AwardAmount", "ProjectTitle", "AgencyIcAdmin", "ProjectStartDate", "ProjectEndDate",
  "ActivityCode", "ContactPiName", "ProjectDetailUrl",
];

export async function nihReporterSearch(args: any) {
  const limit = clampInt(args?.limit, 15, 1, 50);
  const offset = clampInt(args?.offset, 0, 0, 14999);
  const criteria: Record<string, unknown> = {};

  const pi = String(args?.pi_name ?? "").trim();
  const piFirst = String(args?.pi_first_name ?? "").trim();
  const piLast = String(args?.pi_last_name ?? "").trim();
  if (piFirst || piLast) criteria.pi_names = [{ ...(piFirst ? { first_name: piFirst } : {}), ...(piLast ? { last_name: piLast } : {}) }];
  else if (pi) criteria.pi_names = [{ any_name: pi }];

  if (args?.org_name) criteria.org_names = [String(args.org_name)];
  if (args?.city) criteria.org_cities = [String(args.city)];
  if (args?.state) criteria.org_states = [String(args.state).toUpperCase()];
  if (args?.fiscal_years) {
    const fy = (Array.isArray(args.fiscal_years) ? args.fiscal_years : String(args.fiscal_years).split(/[,\s]+/))
      .map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 1980 && n < 2100);
    if (fy.length) criteria.fiscal_years = fy;
  }
  if (args?.min_award != null || args?.max_award != null) {
    criteria.award_amount_range = { min_amount: Number(args?.min_award ?? 0), max_amount: Number(args?.max_award ?? 999_999_999) };
  }
  if (args?.keyword) criteria.advanced_text_search = { operator: "and", search_field: "projecttitle,terms,abstracttext", search_text: String(args.keyword) };
  if (args?.activity_codes) criteria.activity_codes = String(args.activity_codes).split(/[,\s]+/).filter(Boolean);
  if (args?.active_only) criteria.is_active = true;

  if (!Object.keys(criteria).length) throw new Error("nih_reporter_search needs at least one of pi_name, org_name, city+state, keyword, fiscal_years");

  const sort = String(args?.sort ?? "award_amount");
  const body = { criteria, limit, offset, include_fields: FIELDS, sort_field: sort, sort_order: "desc" };
  const key = `nih:${JSON.stringify(body)}`;
  const data = await cached(key, 12 * HOUR, () => postJson<any>(`${BASE}/projects/search`, body));

  const rows = (data?.results ?? []).map((r: any) => ({
    projectNum: r.project_num,
    coreProjectNum: r.core_project_num,
    fiscalYear: r.fiscal_year,
    awardAmount: r.award_amount ?? null,
    activity: r.activity_code,
    institute: r.agency_ic_admin?.abbreviation ?? null,
    title: trunc(r.project_title, 140),
    pis: (r.principal_investigators ?? []).map((p: any) => `${p.full_name?.replace(/\s+/g, " ").trim()}${p.is_contact_pi ? " (contact)" : ""}`),
    org: r.organization?.org_name ?? null,
    dept: r.organization?.dept_type ?? null,
    city: r.organization?.org_city ?? null,
    state: r.organization?.org_state ?? null,
    uei: r.organization?.primary_uei ?? null,
    start: iso(r.project_start_date),
    end: iso(r.project_end_date),
  }));

  return {
    source: "NIH RePORTER v2 (api.reporter.nih.gov)",
    fetchedAt: new Date().toISOString(),
    criteria,
    total: data?.meta?.total ?? rows.length,
    returned: rows.length,
    offset,
    sortedBy: `${sort} desc`,
    pageTotalAwarded: Math.round(rows.reduce((s: number, r: any) => s + (r.awardAmount ?? 0), 0)),
    totalsByOrg: sumBy(rows, (r: any) => r.org, (r: any) => r.awardAmount, 8),
    totalsByPi: sumBy(rows, (r: any) => r.pis?.[0] ?? null, (r: any) => r.awardAmount, 8),
    totalsByFiscalYear: sumBy(rows, (r: any) => String(r.fiscalYear), (r: any) => r.awardAmount, 12).sort((a, b) => b.name.localeCompare(a.name)),
    projects: rows,
    reporterUrl: data?.meta?.properties?.URL?.replace("https:/r", "https://r") ?? null,
    note: "Amounts are whole USD per fiscal-year award record (the same core project appears once per FY). totals* summarize this page only; raise limit/offset for full totals.",
  };
}

export async function nihReporterPublications(args: any) {
  const core = String(args?.core_project_num ?? "").trim().toUpperCase();
  const pmids = args?.pmids ? String(args.pmids).split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n)) : [];
  if (!core && !pmids.length) throw new Error("nih_reporter_publications needs core_project_num (e.g. R01DK130963) or pmids");
  const limit = clampInt(args?.limit, 25, 1, 100);
  const criteria: Record<string, unknown> = {};
  if (core) criteria.core_project_nums = [core];
  if (pmids.length) criteria.pmids = pmids;
  const body = { criteria, limit, offset: 0 };
  const data = await cached(`nihpub:${JSON.stringify(body)}`, 24 * HOUR, () => postJson<any>(`${BASE}/publications/search`, body));
  const rows = (data?.results ?? []).map((r: any) => ({ coreProjectNum: r.coreproject, pmid: r.pmid, applId: r.applid, pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` }));
  return {
    source: "NIH RePORTER v2 publications (api.reporter.nih.gov)",
    fetchedAt: new Date().toISOString(),
    coreProjectNum: core || null,
    total: data?.meta?.total ?? rows.length,
    returned: rows.length,
    publications: rows,
    note: "RePORTER links grants to PubMed IDs only (no titles). Follow pubmedUrl for the paper. Productivity signal: total linked publications per core project.",
  };
}
