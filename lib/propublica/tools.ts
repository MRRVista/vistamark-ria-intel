/**
 * MCP tool handlers for ProPublica Nonprofit Explorer.
 *
 * Two tools:
 *   propublica_org_search — keyword search with optional state / NTEE / subsection filters
 *   propublica_org_990    — full org profile + filing history time series
 */

import { searchOrganizations, getOrganization } from "./client";
import type { PpFiling, PpSearchOrg } from "./client";

const SUBSECTION_LABELS: Record<number, string> = {
  3: "501(c)(3) — Charitable / Religious / Educational",
  4: "501(c)(4) — Social Welfare",
  5: "501(c)(5) — Labor / Agricultural",
  6: "501(c)(6) — Business League / Chamber",
  7: "501(c)(7) — Social / Recreational Club",
  8: "501(c)(8) — Fraternal Beneficiary",
  9: "501(c)(9) — Voluntary Employees' Beneficiary",
  10: "501(c)(10) — Domestic Fraternal",
  11: "501(c)(11) — Teachers' Retirement Fund",
  12: "501(c)(12) — Local Benevolent Life Insurance",
  13: "501(c)(13) — Cemetery Company",
  14: "501(c)(14) — Credit Union",
  15: "501(c)(15) — Mutual Insurance",
  19: "501(c)(19) — Veterans Organization",
  92: "Section 4947(a)(1) trust",
};

const NTEE_MAJOR_GROUPS: Record<number, string> = {
  1: "Arts, Culture & Humanities",
  2: "Education",
  3: "Environment & Animals",
  4: "Health",
  5: "Human Services",
  6: "International",
  7: "Public & Societal Benefit",
  8: "Religion",
  9: "Mutual Membership / Benefit",
  10: "Unknown / Unclassified",
};

function describeSubsection(code: number | undefined): string | null {
  if (code == null) return null;
  return SUBSECTION_LABELS[code] ?? `IRC subsection ${code}`;
}

function summarizeSearchOrg(o: PpSearchOrg) {
  return {
    ein: padEin(o.ein),
    name: o.name,
    location: [o.city, o.state].filter(Boolean).join(", ") || null,
    nteeCode: o.ntee_code ?? null,
    subsection: o.subseccd ?? null,
    subsectionLabel: describeSubsection(o.subseccd),
    haveFilings: o.have_filings ?? false,
  };
}

function summarizeFiling(f: PpFiling) {
  return {
    taxPeriod: f.tax_prd ?? null,
    taxYear: f.tax_prd_yr ?? null,
    formType: filingFormLabel(f.formtype),
    totalRevenue: f.totrevenue ?? null,
    totalExpenses: f.totfuncexpns ?? null,
    totalAssetsEnd: f.totassetsend ?? null,
    totalLiabilitiesEnd: f.totliabend ?? null,
    netAssetsEnd: f.totnetassetend ?? null,
    investmentIncome: f.invstmntinc ?? null,
    netInvestmentIncome: f.netinvinc ?? null,
    netGainOnSales: f.netgnls ?? null,
    pdfUrl: f.pdf_url ?? null,
  };
}

function filingFormLabel(code: number | undefined): string | null {
  if (code == null) return null;
  return { 0: "Form 990", 1: "Form 990-EZ", 2: "Form 990-PF" }[code] ?? `formtype ${code}`;
}

function padEin(ein: number | string): string {
  return String(ein).padStart(9, "0");
}

export interface PropublicaOrgSearchArgs {
  q: string;
  state?: string;
  ntee?: number;
  cCode?: number;
  page?: number;
}

export async function propublicaOrgSearch(args: PropublicaOrgSearchArgs) {
  if (!args.q || typeof args.q !== "string") {
    throw new Error("propublica_org_search requires `q` (search query string)");
  }
  const resp = await searchOrganizations({
    q: args.q,
    state: args.state,
    ntee: args.ntee,
    cCode: args.cCode,
    page: args.page ?? 0,
  });
  return {
    totalResults: resp.total_results,
    page: resp.cur_page,
    numPages: resp.num_pages,
    perPage: resp.per_page,
    filters: {
      state: args.state ?? null,
      ntee: args.ntee != null
        ? { code: args.ntee, label: NTEE_MAJOR_GROUPS[args.ntee] ?? null }
        : null,
      subsection: args.cCode != null
        ? { code: args.cCode, label: describeSubsection(args.cCode) }
        : null,
    },
    organizations: resp.organizations.map(summarizeSearchOrg),
    dataSource: resp.data_source ?? "ProPublica Nonprofit Explorer",
  };
}

export interface PropublicaOrg990Args {
  ein: string | number;
}

export async function propublicaOrg990(args: PropublicaOrg990Args) {
  if (args.ein == null) {
    throw new Error("propublica_org_990 requires `ein`");
  }
  const resp = await getOrganization(args.ein);
  const o = resp.organization;
  const filings = (resp.filings_with_data ?? [])
    .slice()
    .sort((a, b) => (b.tax_prd ?? 0) - (a.tax_prd ?? 0))
    .map(summarizeFiling);
  const latestRev = resp.filings_with_data?.[0]?.totrevenue ?? null;
  const latestExpenses = resp.filings_with_data?.[0]?.totfuncexpns ?? null;
  const latestAssets = resp.filings_with_data?.[0]?.totassetsend ?? null;
  return {
    organization: {
      ein: padEin(o.ein),
      name: o.name,
      careOf: o.careofname ?? null,
      address: o.address ?? null,
      location: [o.city, o.state].filter(Boolean).join(", ") || null,
      zip: o.zipcode ?? null,
      subsection: o.subseccd ?? null,
      subsectionLabel: describeSubsection(o.subseccd),
      foundationCode: o.foundation_code ?? null,
      nteeCode: o.ntee_code ?? null,
      rulingDate: o.ruling_date ?? null,
      latestTaxPeriod: o.tax_period ?? null,
    },
    latestSnapshot: {
      revenue: latestRev,
      expenses: latestExpenses,
      assets: latestAssets,
    },
    filings,
    filingsWithoutData: (resp.filings_without_data ?? []).length,
    dataSource: resp.data_source ?? "ProPublica Nonprofit Explorer",
  };
}
