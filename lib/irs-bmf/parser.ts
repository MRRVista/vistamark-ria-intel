/**
 * Streaming CSV reader for IRS EO BMF files.
 *
 * The BMF files are simple CSVs (~150 MB each, ~250K–500K rows), but we stream
 * them because a single Vercel function can't hold all six regions in memory.
 *
 * We implement a small RFC-4180-compliant streaming parser inline rather than
 * pulling in csv-parse, to keep the deploy lean and avoid an extra dependency.
 * BMF has quoted fields with embedded commas; embedded newlines/quotes are
 * extremely rare but handled.
 */

import { BMF_COLS, parseIntOrNull } from "./columns";
import type { BmfRegion } from "./columns";
import type { NonprofitInsert } from "../db/schema";

export function bmfRowToRecord(row: string[], region: BmfRegion): NonprofitInsert | null {
  // EIN must be present and 9 digits when zero-padded; rows without are unusable.
  const rawEin = row[BMF_COLS.EIN]?.trim();
  if (!rawEin) return null;
  const ein = rawEin.padStart(9, "0");
  if (!/^\d{9}$/.test(ein)) return null;

  const name = row[BMF_COLS.NAME]?.trim();
  if (!name) return null;

  return {
    ein,
    name,
    inCareOf: emptyToNull(row[BMF_COLS.ICO]),
    street: emptyToNull(row[BMF_COLS.STREET]),
    city: emptyToNull(row[BMF_COLS.CITY]),
    state: emptyToNull(row[BMF_COLS.STATE]?.toUpperCase()),
    zip: emptyToNull(row[BMF_COLS.ZIP]),
    groupCode: emptyToNull(row[BMF_COLS.GROUP]),
    subsection: parseIntOrNull(row[BMF_COLS.SUBSECTION]),
    affiliation: parseIntOrNull(row[BMF_COLS.AFFILIATION]),
    classification: emptyToNull(row[BMF_COLS.CLASSIFICATION]),
    rulingDate: emptyToNull(row[BMF_COLS.RULING]),
    deductibility: parseIntOrNull(row[BMF_COLS.DEDUCTIBILITY]),
    foundation: parseIntOrNull(row[BMF_COLS.FOUNDATION]),
    activityCodes: emptyToNull(row[BMF_COLS.ACTIVITY]),
    organizationCode: parseIntOrNull(row[BMF_COLS.ORGANIZATION]),
    statusCode: parseIntOrNull(row[BMF_COLS.STATUS]),
    taxPeriod: emptyToNull(row[BMF_COLS.TAX_PERIOD]),
    assetCode: parseIntOrNull(row[BMF_COLS.ASSET_CD]),
    incomeCode: parseIntOrNull(row[BMF_COLS.INCOME_CD]),
    filingReqCode: emptyToNull(row[BMF_COLS.FILING_REQ_CD]),
    pfFilingReqCode: emptyToNull(row[BMF_COLS.PF_FILING_REQ_CD]),
    acctPeriod: emptyToNull(row[BMF_COLS.ACCT_PD]),
    assetAmt: parseIntOrNull(row[BMF_COLS.ASSET_AMT]),
    incomeAmt: parseIntOrNull(row[BMF_COLS.INCOME_AMT]),
    revenueAmt: parseIntOrNull(row[BMF_COLS.REVENUE_AMT]),
    nteeCode: emptyToNull(row[BMF_COLS.NTEE_CD]),
    sortName: emptyToNull(row[BMF_COLS.SORT_NAME]),
    region,
  };
}

function emptyToNull(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

// State machine: reads chunks of UTF-8 text and yields complete rows.
// Handles RFC 4180 quoting: "field with, comma" and ""escaped-quote"".
export interface CsvStreamState {
  buf: string;
  field: string;
  row: string[];
  inQuotes: boolean;
  pendingCR: boolean;
}

export function newStreamState(): CsvStreamState {
  return { buf: "", field: "", row: [], inQuotes: false, pendingCR: false };
}

export function consumeCsvChunk(
  state: CsvStreamState,
  chunk: string,
  onRow: (row: string[]) => void
): void {
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (state.inQuotes) {
      if (ch === '"') {
        if (i + 1 < chunk.length && chunk[i + 1] === '"') {
          state.field += '"';
          i++;
        } else {
          state.inQuotes = false;
        }
      } else {
        state.field += ch;
      }
      continue;
    }

    if (ch === '"') {
      state.inQuotes = true;
      continue;
    }
    if (ch === ",") {
      state.row.push(state.field);
      state.field = "";
      continue;
    }
    if (ch === "\r") {
      state.pendingCR = true;
      continue;
    }
    if (ch === "\n") {
      state.row.push(state.field);
      state.field = "";
      onRow(state.row);
      state.row = [];
      state.pendingCR = false;
      continue;
    }
    if (state.pendingCR) {
      state.row.push(state.field);
      state.field = "";
      onRow(state.row);
      state.row = [];
      state.pendingCR = false;
    }
    state.field += ch;
  }
}

export function finishCsvStream(
  state: CsvStreamState,
  onRow: (row: string[]) => void
): void {
  if (state.inQuotes) {
    state.inQuotes = false;
  }
  if (state.field !== "" || state.row.length > 0) {
    state.row.push(state.field);
    state.field = "";
    onRow(state.row);
    state.row = [];
  }
}
