/**
 * IPEDS Finance Survey + Directory — column conventions, URL builders, helpers.
 *
 * NCES publishes annual zipped CSVs at:
 *   http://nces.ed.gov/ipeds/datacenter/data/{FILENAME}.zip
 *
 * Finance files (one per institutional sector):
 *   F{YY}{YY}_F2   — Private nonprofit, FASB         (workhorse for endowments)
 *   F{YY}{YY}_F1A  — Public, FASB                    (some endowment data)
 *   F{YY}{YY}_F3   — Private for-profit              (rarely has endowment data)
 *
 * Directory file:
 *   HD{YYYY}       — Institution metadata, keyed by UNITID
 *
 * Year naming: "2022-23" -> F2223; FY ends June 30 of second year (FY23).
 *
 * Provisional FY 2023-24 data is currently available; final FY 2022-23 and back
 * through FY 2003-04 are also available. Earlier finance files use a different
 * format (F0001_F1/F2/F3, F9899_F1/F2/F3, etc.) and are not yet handled.
 *
 * Endowment fields — IPEDS variable names (header lowercase, parser maps
 * case-insensitively):
 *   F2 file:
 *     f2h01 = Endowment assets at the beginning of the fiscal year
 *     f2h02 = Endowment assets at the end of the fiscal year
 *     f2h03 = Contributions to endowment (FY 2018-19+)
 *     f2h04 = Net total investment return (FY 2018-19+)
 *     f2h05 = Withdrawals from endowment for operations (FY 2018-19+)
 *     f2h06 = Other adjustments (FY 2018-19+)
 *   F1A file (public FASB):
 *     f1h01 = Endowment assets at the beginning of the fiscal year
 *     f1h02 = Endowment assets at the end of the fiscal year
 */

const IPEDS_BASE_URL =
  process.env.IPEDS_BASE_URL ?? "https://nces.ed.gov/ipeds/datacenter/data";

export type IpedsFinanceFile = "F2" | "F1A" | "F3";

export function financeUrl(fyear: number, fileType: IpedsFinanceFile): string {
  // fyear = the calendar year the FY ENDS in (e.g. 2023 -> academic year 2022-23 -> F2223)
  const yy1 = String((fyear - 1) % 100).padStart(2, "0");
  const yy2 = String(fyear % 100).padStart(2, "0");
  return `${IPEDS_BASE_URL}/F${yy1}${yy2}_${fileType}.zip`;
}

export function directoryUrl(year: number): string {
  // year is the calendar year (e.g. 2023 -> HD2023.zip)
  return `${IPEDS_BASE_URL}/HD${year}.zip`;
}

export const SECTOR_LABEL: Record<number, string> = {
  0: "Administrative Unit",
  1: "Public, 4-year or above",
  2: "Private not-for-profit, 4-year or above",
  3: "Private for-profit, 4-year or above",
  4: "Public, 2-year",
  5: "Private not-for-profit, 2-year",
  6: "Private for-profit, 2-year",
  7: "Public, less-than-2-year",
  8: "Private not-for-profit, less-than-2-year",
  9: "Private for-profit, less-than-2-year",
};

export const CONTROL_LABEL: Record<number, string> = {
  1: "Public",
  2: "Private not-for-profit",
  3: "Private for-profit",
};

export const ICLEVEL_LABEL: Record<number, string> = {
  1: "4-year or above",
  2: "At least 2 but less than 4-year",
  3: "Less than 2-year",
};

/**
 * Normalize a header field name by stripping BOM/zero-width chars, quotes,
 * surrounding whitespace, and upper-casing. IPEDS files have historically
 * been Windows-1252/Latin1 but recent provisional files have shown UTF-8
 * BOM bytes (0xEF 0xBB 0xBF) at the start which, after Latin1 decoding,
 * appear as the three Latin-1 chars 0xEF 0xBB 0xBF (U+00EF U+00BB U+00BF).
 * If we don't strip those, the first column (UNITID) gets indexed under
 * the wrong key and every record-mapper call returns null.
 */
function normalizeHeader(s: string): string {
  return s
    // UTF-8 BOM read as native UTF-16 char
    .replace(/^\uFEFF/, "")
    // UTF-8 BOM read as three Latin-1 chars (very common with this decoder)
    .replace(/^\u00EF\u00BB\u00BF/, "")
    // Stray surrounding double quotes (some IPEDS years quote the header row)
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

export function field(
  row: string[],
  idx: Record<string, number>,
  ...keys: string[]
): string | null {
  // Returns the first non-empty value among the given keys (case-insensitive).
  for (const k of keys) {
    const i = idx[k.toUpperCase()];
    if (i == null) continue;
    const v = row[i];
    if (v == null) continue;
    const t = v.trim().replace(/^"+|"+$/g, "");
    if (t !== "" && t !== ".") return t;
  }
  return null;
}

export function fieldInt(
  row: string[],
  idx: Record<string, number>,
  ...keys: string[]
): number | null {
  const s = field(row, idx, ...keys);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function fieldBigInt(
  row: string[],
  idx: Record<string, number>,
  ...keys: string[]
): number | null {
  const s = field(row, idx, ...keys);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Default IPEDS years to backfill — covers final data 2003-04 through 2022-23
  * plus provisional 2023-24. fyear = calendar year FY ends. */
export const DEFAULT_FINANCE_YEARS = [
  2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013,
  2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024,
] as const;

export const DEFAULT_DIRECTORY_YEAR = 2023;
