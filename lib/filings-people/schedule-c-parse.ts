/**
 * Pure parsing for DOL Form 5500 Schedule C Part I Item 2 files (no DB).
 *
 * Verified against the live 2024 files (published 2026-09-25):
 *   F_SCH_C_PART1_ITEM2_2024_latest.csv  — 264,744 rows, columns:
 *     ACK_ID, ROW_ORDER, PROVIDER_OTHER_NAME, PROVIDER_OTHER_EIN,
 *     PROVIDER_OTHER_US_ADDRESS1/2, PROVIDER_OTHER_US_CITY/STATE/ZIP,
 *     PROV_OTHER_FOREIGN_*, PROVIDER_OTHER_SRVC_CODES (always empty — codes
 *     live in the CODES file), PROVIDER_OTHER_RELATION,
 *     PROVIDER_OTHER_DIRECT_COMP_AMT, PROV_OTHER_INDIRECT_COMP_IND ('1'/'2'),
 *     PROV_OTHER_ELIG_IND_COMP_IND, PROV_OTHER_TOT_IND_COMP_AMT,
 *     PROVIDER_OTHER_AMT_FORMULA_IND
 *   F_SCH_C_PART1_ITEM2_CODES_2024_latest.csv — ACK_ID, ROW_ORDER, CODE_ORDER, SERVICE_CODE
 * Indicator convention in DOL FOIA files: '1' = yes, '2' = no.
 */
import { consumeCsvChunk, finishCsvStream, newStreamState } from "../irs-bmf/parser";

export const SCH_C_SERVICE_CODES: Record<string, string> = {
  "10": "Accounting (including auditing)",
  "11": "Actuarial",
  "12": "Claims processing",
  "13": "Contract administrator",
  "14": "Plan administrator",
  "15": "Recordkeeping and information management",
  "16": "Consulting (general)",
  "17": "Consulting (pension)",
  "18": "Custodial (other than securities)",
  "19": "Custodial (securities)",
  "20": "Trustee (individual)",
  "21": "Trustee (bank, trust company, or similar)",
  "22": "Insurance agents and brokers",
  "23": "Insurance services",
  "24": "Trustee (discretionary)",
  "25": "Trustee (directed)",
  "26": "Investment advisory (participants)",
  "27": "Investment advisory (plan)",
  "28": "Investment management",
  "29": "Legal",
  "30": "Employee (plan)",
  "31": "Named fiduciary",
  "32": "Real estate brokerage",
  "33": "Securities brokerage",
  "34": "Valuation (appraisals, etc.)",
  "35": "Employee (plan sponsor)",
  "36": "Copying and duplicating",
  "37": "Participant loan processing",
  "38": "Participant communication",
  "40": "Foreign entity",
  "49": "Other services",
  "50": "Direct payment from the plan",
  "51": "Investment management fees paid directly by plan",
  "52": "Investment management fees paid indirectly by plan",
  "53": "Insurance brokerage commissions and fees",
  "54": "Sales loads (front end and deferred)",
  "55": "Other commissions",
  "56": "Non-monetary compensation",
  "57": "Redemption fees",
  "58": "Product termination fees (surrender charges)",
  "59": "Shareholder servicing fees",
  "60": "Sub-transfer agency fees",
  "61": "Finders' fees/placement fees",
  "62": "Float revenue",
  "63": "Distribution (12b-1) fees",
  "64": "Recordkeeping fees",
  "65": "Account maintenance fees",
  "66": "Insurance mortality and expense charge",
  "67": "Other insurance wrap fees",
  "68": "Soft dollars commissions",
  "70": "Consulting fees",
  "71": "Securities brokerage commissions and fees",
  "72": "Other investment fees and expenses",
  "73": "Other insurance fees and expenses",
  "99": "Other fees",
};

/** Service-code groups useful as filters. */
export const SCH_C_ROLE_CODES: Record<string, string[]> = {
  adviser: ["26", "27", "28", "16", "17", "70"],
  recordkeeper: ["15", "64", "13", "14"],
  broker: ["22", "33", "53", "55", "71"],
  trustee: ["18", "19", "20", "21", "24", "25"],
  auditor: ["10"],
  actuary: ["11"],
  legal: ["29"],
};

export interface SchCProviderRow {
  ackId: string;
  rowOrder: number;
  filingYear: number;
  providerName: string | null;
  providerNameNorm: string | null;
  providerEin: string | null;
  providerCity: string | null;
  providerState: string | null;
  providerZip: string | null;
  relation: string | null;
  serviceCodes: string | null;
  directComp: number | null;
  indirectCompInd: boolean | null;
  eligIndirectCompInd: boolean | null;
  indirectComp: number | null;
  formulaInd: boolean | null;
}

const SUFFIX = /\b(THE|INC|INCORPORATED|LLC|L L C|LLP|LP|L P|LTD|CORP|CORPORATION|CO|COMPANY|NA|N A|PLLC|PC|P C)\b/g;

export function normalizeProviderName(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = s
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n || null;
}

function clamp(s: string | null, max: number): string | null {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) : s;
}
function nz(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function money(v: string | undefined): number | null {
  const t = nz(v);
  if (t == null) return null;
  const n = Number(t.replace(/[,$]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}
function ind(v: string | undefined): boolean | null {
  const t = nz(v);
  if (t == null) return null;
  if (t === "1" || /^y/i.test(t) || /^t/i.test(t)) return true;
  if (t === "2" || t === "0" || /^n/i.test(t) || /^f/i.test(t)) return false;
  return null;
}

export function headerIndex(row: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  row.forEach((h, i) => {
    idx[h.replace(/^﻿/, "").trim().toUpperCase()] = i;
  });
  return idx;
}

/** Iterate CSV rows (header first) from a Buffer in 4MB chunks. */
export function forEachCsvRow(buf: Buffer, onRow: (row: string[]) => void): void {
  const state = newStreamState();
  const decoder = new TextDecoder("utf-8");
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < buf.length; off += CHUNK) {
    const text = decoder.decode(buf.subarray(off, Math.min(off + CHUNK, buf.length)), { stream: true });
    consumeCsvChunk(state, text, onRow);
  }
  const tail = decoder.decode();
  if (tail) consumeCsvChunk(state, tail, onRow);
  finishCsvStream(state, onRow);
}

/** CODES file → Map("ACK|ROW" → "27,50") preserving CODE_ORDER. */
export function buildCodeMap(codesCsv: Buffer): Map<string, string> {
  const tmp = new Map<string, Array<[number, string]>>();
  let idx: Record<string, number> | null = null;
  forEachCsvRow(codesCsv, (row) => {
    if (!idx) {
      idx = headerIndex(row);
      return;
    }
    const ack = nz(row[idx["ACK_ID"]!]);
    const ro = nz(row[idx["ROW_ORDER"]!]);
    const code = nz(row[idx["SERVICE_CODE"]!]);
    if (!ack || !ro || !code) return;
    const k = `${ack}|${ro}`;
    const co = Number(row[idx["CODE_ORDER"]!] ?? 0) || 0;
    const arr = tmp.get(k);
    if (arr) arr.push([co, code]);
    else tmp.set(k, [[co, code]]);
  });
  const out = new Map<string, string>();
  for (const [k, arr] of tmp) out.set(k, arr.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(","));
  return out;
}

export function item2RowToRecord(
  row: string[],
  idx: Record<string, number>,
  year: number,
  codes?: Map<string, string>
): SchCProviderRow | null {
  const g = (k: string) => (idx[k] != null ? row[idx[k]!] : undefined);
  const ackId = clamp(nz(g("ACK_ID")), 40);
  const ro = Number(nz(g("ROW_ORDER")));
  if (!ackId || !Number.isFinite(ro)) return null;
  const name = nz(g("PROVIDER_OTHER_NAME"));
  const einDigits = (nz(g("PROVIDER_OTHER_EIN")) ?? "").replace(/\D/g, "");
  const inlineCodes = nz(g("PROVIDER_OTHER_SRVC_CODES"));
  return {
    ackId,
    rowOrder: ro,
    filingYear: year,
    providerName: name,
    providerNameNorm: normalizeProviderName(name),
    providerEin: clamp(einDigits || null, 12),
    providerCity: clamp(nz(g("PROVIDER_OTHER_US_CITY")) ?? nz(g("PROV_OTHER_FOREIGN_CITY")), 64),
    providerState: clamp(nz(g("PROVIDER_OTHER_US_STATE"))?.toUpperCase() ?? nz(g("PROV_OTHER_FOREIGN_CNTRY")), 4),
    providerZip: clamp(nz(g("PROVIDER_OTHER_US_ZIP")), 16),
    relation: nz(g("PROVIDER_OTHER_RELATION")),
    serviceCodes: codes?.get(`${ackId}|${ro}`) ?? (inlineCodes ? inlineCodes.replace(/\s+/g, "") : null),
    directComp: money(g("PROVIDER_OTHER_DIRECT_COMP_AMT")),
    indirectCompInd: ind(g("PROV_OTHER_INDIRECT_COMP_IND")),
    eligIndirectCompInd: ind(g("PROV_OTHER_ELIG_IND_COMP_IND")),
    indirectComp: money(g("PROV_OTHER_TOT_IND_COMP_AMT")),
    formulaInd: ind(g("PROVIDER_OTHER_AMT_FORMULA_IND")),
  };
}

export function describeCodes(codes: string | null | undefined): string[] {
  if (!codes) return [];
  return codes
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `${c} ${SCH_C_SERVICE_CODES[c] ?? "?"}`);
}
