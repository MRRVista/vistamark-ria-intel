/**
 * IRS Exempt Organizations Business Master File (EO BMF) — column definitions,
 * region URLs, and lookup tables for the various codes the IRS uses.
 *
 * Spec: https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf
 * Layout (pre-2022 format, still used): row of comma-separated quoted fields.
 *
 * Column order in BMF CSV (case-sensitive header names from IRS):
 *   EIN, NAME, ICO, STREET, CITY, STATE, ZIP, GROUP, SUBSECTION, AFFILIATION,
 *   CLASSIFICATION, RULING, DEDUCTIBILITY, FOUNDATION, ACTIVITY, ORGANIZATION,
 *   STATUS, TAX_PERIOD, ASSET_CD, INCOME_CD, FILING_REQ_CD, PF_FILING_REQ_CD,
 *   ACCT_PD, ASSET_AMT, INCOME_AMT, REVENUE_AMT, NTEE_CD, SORT_NAME
 */

export const BMF_REGIONS = ["eo1", "eo2", "eo3", "eo4", "eo_pr", "eo_xx"] as const;
export type BmfRegion = typeof BMF_REGIONS[number];

const BMF_BASE_URL = process.env.IRS_BMF_BASE_URL ?? "https://www.irs.gov/pub/irs-soi";

export function bmfUrl(region: BmfRegion): string {
  return `${BMF_BASE_URL}/${region}.csv`;
}

export const REGION_DESCRIPTIONS: Record<BmfRegion, string> = {
  eo1: "Northeast (CT, ME, MA, NH, NJ, NY, PA, RI, VT)",
  eo2: "Mid-Atlantic & Southeast (DE, DC, FL, GA, MD, NC, SC, VA, WV)",
  eo3: "Central / Midwest (AL, IL, IN, KY, MI, MS, OH, TN, WI)",
  eo4: "South & West (AK, AZ, AR, CA, CO, HI, ID, IA, KS, LA, MN, MO, MT, NE, NV, NM, ND, OK, OR, SD, TX, UT, WA, WY)",
  eo_pr: "Puerto Rico",
  eo_xx: "Foreign / International",
};

export const BMF_COLS = {
  EIN: 0, NAME: 1, ICO: 2, STREET: 3, CITY: 4, STATE: 5, ZIP: 6,
  GROUP: 7, SUBSECTION: 8, AFFILIATION: 9, CLASSIFICATION: 10,
  RULING: 11, DEDUCTIBILITY: 12, FOUNDATION: 13, ACTIVITY: 14,
  ORGANIZATION: 15, STATUS: 16, TAX_PERIOD: 17, ASSET_CD: 18,
  INCOME_CD: 19, FILING_REQ_CD: 20, PF_FILING_REQ_CD: 21, ACCT_PD: 22,
  ASSET_AMT: 23, INCOME_AMT: 24, REVENUE_AMT: 25, NTEE_CD: 26, SORT_NAME: 27,
} as const;

export const ASSET_INCOME_RANGE: Record<number, string> = {
  0: "$0", 1: "$1 – $9,999", 2: "$10,000 – $24,999", 3: "$25,000 – $99,999",
  4: "$100,000 – $499,999", 5: "$500,000 – $999,999", 6: "$1M – $4,999,999",
  7: "$5M – $9,999,999", 8: "$10M – $49,999,999", 9: "$50M+",
};

export const FOUNDATION_CODE: Record<number, string> = {
  0: "Not a private foundation",
  2: "Church 170(b)(1)(A)(i)",
  3: "School 170(b)(1)(A)(ii)",
  4: "Hospital 170(b)(1)(A)(iii)",
  5: "Medical research org 170(b)(1)(A)(iii)",
  6: "Gov-supported 170(b)(1)(A)(iv)",
  7: "Publicly supported 170(b)(1)(A)(vi)",
  8: "Community trust 170(b)(1)(A)(vi)",
  9: "Agricultural research 170(b)(1)(A)(ix)",
  10: "Publicly supported 509(a)(2)",
  11: "Supporting org 509(a)(3)",
  12: "Testing for public safety 509(a)(4)",
  13: "Private operating foundation",
  14: "Private non-operating foundation",
  15: "Trust treated as private foundation",
  16: "Private foundation w/ unknown 509(a) status",
  17: "Section 4947(a)(1) trust",
  21: "Private operating foundation (4940(d)(2))",
  22: "Private operating foundation",
};

export const DEDUCTIBILITY_CODE: Record<number, string> = {
  1: "Contributions deductible",
  2: "Contributions NOT deductible",
  4: "Contributions deductible by treaty (foreign orgs)",
};

export const SUBSECTION_LABEL: Record<number, string> = {
  3: "501(c)(3)", 4: "501(c)(4)", 5: "501(c)(5)", 6: "501(c)(6)",
  7: "501(c)(7)", 8: "501(c)(8)", 9: "501(c)(9)", 10: "501(c)(10)",
  11: "501(c)(11)", 12: "501(c)(12)", 13: "501(c)(13)", 14: "501(c)(14)",
  15: "501(c)(15)", 17: "501(c)(17)", 19: "501(c)(19)", 20: "501(c)(20)",
  92: "Section 4947(a)(1) trust",
};

export const STATUS_CODE: Record<number, string> = {
  1: "Unconditional exemption",
  2: "Conditional exemption",
  12: "Trust, exemption conditional",
  25: "Group ruling member organization",
};

export function parseIntOrNull(s: string | undefined): number | null {
  if (s == null) return null;
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}
