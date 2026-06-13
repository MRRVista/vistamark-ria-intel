/**
 * SEC Form 13F Data Set parsing helpers.
 *
 * The 13F data sets are TAB-delimited UTF-8 text files (not comma CSV), one
 * zip per quarter containing up to seven tables. We use a dedicated TSV row
 * splitter rather than the RFC-4180 CSV parser because these files are
 * tab-separated and do not quote fields.
 *
 * Tables we consume (see form_13f_readme.pdf):
 *   SUBMISSION.tsv    — ACCESSION_NUMBER, FILING_DATE, SUBMISSIONTYPE, CIK, PERIODOFREPORT
 *   COVERPAGE.tsv     — ACCESSION_NUMBER, FILINGMANAGER_NAME/CITY/STATEORCOUNTRY,
 *                       REPORTTYPE, CRDNUMBER, SECFILENUMBER, ISAMENDMENT, ...
 *   SUMMARYPAGE.tsv   — ACCESSION_NUMBER, TABLEENTRYTOTAL, TABLEVALUETOTAL,
 *                       OTHERINCLUDEDMANAGERSCOUNT
 *   INFOTABLE.tsv     — ACCESSION_NUMBER, INFOTABLE_SK, NAMEOFISSUER, TITLEOFCLASS,
 *                       CUSIP, FIGI, VALUE, SSHPRNAMT, SSHPRNAMTTYPE, PUTCALL,
 *                       INVESTMENTDISCRETION, VOTING_AUTH_SOLE/SHARED/NONE
 *
 * IMPORTANT (VALUE units): per the SEC readme, INFOTABLE.VALUE is in WHOLE
 * DOLLARS for filings whose VALUE convention changed on 2023-01-03, and in
 * THOUSANDS before that. We normalize to whole dollars in value_usd using the
 * filing's period_of_report: periods on/after 2022-12-15 are treated as
 * whole-dollar (covers the 2022-Q4 reports filed in early 2023 under the new
 * rule); earlier periods are multiplied by 1000. The 2022-12-15 boundary is a
 * deliberate slight-early cutover to catch Dec-2022 period reports filed after
 * Jan 3 2023; a handful of edge filings either side are individually
 * inconsequential for prospecting-scale analysis and the raw value is always
 * retained in value_raw.
 */

export function splitTsvLine(line: string): string[] {
  // 13F data-set TSVs are tab-delimited with no field quoting.
  return line.split("\t");
}

export function parseSecDate(s: string | undefined | null): string | null {
  if (s == null) return null;
  const t = s.trim();
  if (t === "") return null;
  // SEC dates are DD-MON-YYYY, e.g. 30-SEP-2023
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t);
  if (m) {
    const months: Record<string, string> = {
      JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
      JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
    };
    const mm = months[m[2]!.toUpperCase()];
    if (!mm) return null;
    return `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}`;
  }
  // ISO fallback
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

export function parseIntOrNull(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function parseBigIntOrNull(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function emptyToNull(s: string | undefined | null): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" ? null : t;
}

/**
 * Build a header-name → column-index map from a TSV header row.
 * 13F header names are UPPERCASE already, but we normalize to be safe.
 */
export function buildHeaderIndex(headerCells: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < headerCells.length; i++) {
    const name = (headerCells[i] ?? "")
      .replace(/^\uFEFF/, "")
      .replace(/^\u00EF\u00BB\u00BF/, "")
      .trim()
      .toUpperCase();
    if (name) map[name] = i;
  }
  return map;
}

export function cell(
  row: string[],
  idx: Record<string, number>,
  key: string
): string | null {
  const i = idx[key.toUpperCase()];
  if (i == null) return null;
  return emptyToNull(row[i]);
}

/**
 * Decide whether a filing's INFOTABLE VALUE is already in whole dollars.
 * periodIso is YYYY-MM-DD (period_of_report). Returns true for whole-dollar.
 */
export function isWholeDollarValue(periodIso: string | null): boolean {
  if (!periodIso) return true; // assume modern convention if unknown
  // Whole-dollar convention applies from the 2022-Q4 reporting period onward
  // (filed on/after 2023-01-03). Use 2022-12-15 as the cutover boundary.
  return periodIso >= "2022-12-15";
}

export function normalizeValueUsd(
  valueRaw: number | null,
  periodIso: string | null
): number | null {
  if (valueRaw == null) return null;
  return isWholeDollarValue(periodIso) ? valueRaw : valueRaw * 1000;
}
