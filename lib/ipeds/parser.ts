/**
 * IPEDS row → record mappers. We reuse the streaming CSV primitives from
 * lib/irs-bmf/parser.ts; IPEDS uses standard quoted CSV with a header row.
 *
 * Two record types here:
 *   - hdRowToRecord:       HD{YYYY}.csv → IpedsInstitutionInsert
 *   - financeRowToRecord:  F{YY}{YY}_F2 or _F1A → EndowmentInsert (or null if
 *                          no endowment value is reported)
 */

import {
  buildHeaderIndex,
  field,
  fieldBigInt,
  fieldInt,
} from "./columns";
import type { IpedsFinanceFile } from "./columns";
import type { IpedsInstitutionInsert, EndowmentInsert } from "../db/schema";

export function hdRowToRecord(
  row: string[],
  idx: Record<string, number>
): IpedsInstitutionInsert | null {
  const unitid = fieldInt(row, idx, "UNITID");
  if (unitid == null) return null;
  const instnm = field(row, idx, "INSTNM");
  if (!instnm) return null;
  return {
    unitid,
    instnm,
    city: field(row, idx, "CITY"),
    state: field(row, idx, "STABBR")?.toUpperCase() ?? null,
    zip: field(row, idx, "ZIP"),
    sector: fieldInt(row, idx, "SECTOR"),
    control: fieldInt(row, idx, "CONTROL"),
    iclevel: fieldInt(row, idx, "ICLEVEL"),
    obereg: fieldInt(row, idx, "OBEREG"),
    webaddr: field(row, idx, "WEBADDR"),
    closedDate: field(row, idx, "CLOSEDAT"),
  };
}

export function financeRowToRecord(
  row: string[],
  idx: Record<string, number>,
  fyear: number,
  fileType: IpedsFinanceFile
): EndowmentInsert | null {
  const unitid = fieldInt(row, idx, "UNITID");
  if (unitid == null) return null;

  let boy: number | null = null;
  let eoy: number | null = null;
  let contrib: number | null = null;
  let netReturn: number | null = null;
  let withdrawn: number | null = null;
  let otherAdj: number | null = null;

  if (fileType === "F2") {
    boy = fieldBigInt(row, idx, "F2H01");
    eoy = fieldBigInt(row, idx, "F2H02");
    contrib = fieldBigInt(row, idx, "F2H03");
    netReturn = fieldBigInt(row, idx, "F2H04");
    withdrawn = fieldBigInt(row, idx, "F2H05");
    otherAdj = fieldBigInt(row, idx, "F2H06");
  } else if (fileType === "F1A") {
    boy = fieldBigInt(row, idx, "F1H01", "F1H01A");
    eoy = fieldBigInt(row, idx, "F1H02", "F1H02A");
    contrib = fieldBigInt(row, idx, "F1H03");
    netReturn = fieldBigInt(row, idx, "F1H04");
    withdrawn = fieldBigInt(row, idx, "F1H05");
    otherAdj = fieldBigInt(row, idx, "F1H06");
  } else if (fileType === "F3") {
    // Private for-profit institutions rarely report endowments. Try F3 part-H
    // analogue, but most rows will be null and filtered out below.
    boy = fieldBigInt(row, idx, "F3H01");
    eoy = fieldBigInt(row, idx, "F3H02");
  }

  // Skip rows that have no endowment data at all.
  if (boy == null && eoy == null && contrib == null && withdrawn == null) {
    return null;
  }

  return {
    unitid,
    fyear,
    fileType,
    marketValueBoy: boy,
    marketValueEoy: eoy,
    contributions: contrib,
    netInvestmentReturn: netReturn,
    withdrawals: withdrawn,
    otherAdjustments: otherAdj,
  };
}

export { newStreamState, consumeCsvChunk, finishCsvStream } from "../irs-bmf/parser";
export type { CsvStreamState } from "../irs-bmf/parser";
export { buildHeaderIndex };
