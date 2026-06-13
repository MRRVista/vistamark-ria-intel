/**
 * SBA PPP (Paycheck Protection Program) FOIA dataset — column conventions.
 *
 * The SBA publishes the full loan-level PPP data via FOIA at
 * https://data.sba.gov/dataset/ppp-foia. The ">=$150k" file and the various
 * "<$150k" state files share a common header schema. We key on LoanNumber.
 *
 * Header names below match the public CSV exactly (case-insensitive lookup via
 * buildHeaderIndex). Not every column is retained — we keep the fields useful
 * for prospecting and cross-referencing against RIA / nonprofit / plan data.
 *
 * Canonical headers (post-2021 unified schema):
 *   LoanNumber, DateApproved, SBAOfficeCode, ProcessingMethod, BorrowerName,
 *   BorrowerAddress, BorrowerCity, BorrowerState, BorrowerZip, LoanStatusDate,
 *   LoanStatus, Term, SBAGuarantyPercentage, InitialApprovalAmount,
 *   CurrentApprovalAmount, UndisbursedAmount, FranchiseName, ServicingLenderLocationID,
 *   ServicingLenderName, ServicingLenderAddress, ServicingLenderCity,
 *   ServicingLenderState, ServicingLenderZip, RuralUrbanIndicator, HubzoneIndicator,
 *   LMIIndicator, BusinessAgeDescription, ProjectCity, ProjectCountyName,
 *   ProjectState, ProjectZip, CD, JobsReported, NAICSCode, RaceEthnicity,
 *   UTILITIES_PROCEED, PAYROLL_PROCEED, MORTGAGE_INTEREST_PROCEED, RENT_PROCEED,
 *   REFINANCE_EIDL_PROCEED, HEALTH_CARE_PROCEED, DEBT_INTEREST_PROCEED,
 *   BusinessType, OriginatingLenderLocationID, OriginatingLender,
 *   OriginatingLenderCity, OriginatingLenderState, Gender, Veteran, NonProfit,
 *   ForgivenessAmount, ForgivenessDate
 */

export function parseMoneyOrNull(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = String(s).trim().replace(/[$,]/g, "");
  if (t === "" || t === "." || /^n\/?a$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function parseIntOrNull(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * SBA dates come as either "MM/DD/YYYY" or ISO. Normalize to YYYY-MM-DD or
 * null. Postgres `date` columns accept YYYY-MM-DD cleanly.
 */
export function parseDateOrNull(s: string | undefined | null): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  // ISO already
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // MM/DD/YYYY
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (us) {
    const mm = us[1]!.padStart(2, "0");
    const dd = us[2]!.padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

export function parseBoolNonprofit(s: string | undefined | null): boolean | null {
  if (s == null) return null;
  const t = String(s).trim().toUpperCase();
  if (t === "") return null;
  // SBA uses "Y" in the NonProfit column for nonprofits; blank otherwise.
  return t === "Y" || t === "YES" || t === "TRUE" || t === "1";
}

export function field(
  row: string[],
  idx: Record<string, number>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const i = idx[k.toUpperCase()];
    if (i == null) continue;
    const v = row[i];
    if (v == null) continue;
    const t = v.trim().replace(/^"+|"+$/g, "");
    if (t !== "") return t;
  }
  return null;
}

function normalizeHeader(s: string): string {
  return s
    .replace(/^\uFEFF/, "")
    .replace(/^\u00EF\u00BB\u00BF/, "")
    .replace(/^"+|"+$/g, "")
    .trim()
    .toUpperCase();
}

export function buildHeaderIndex(headerRow: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const name = normalizeHeader(headerRow[i] ?? "");
    if (name) map[name] = i;
  }
  return map;
}
