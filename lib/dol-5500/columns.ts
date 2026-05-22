/**
 * DOL Form 5500 — column index map for the main filing CSV (F_5500_YYYY_Latest).
 *
 * DOL publishes annual bulk ZIPs at:
 *   https://askebsa.dol.gov/FOIA%20Files/{YYYY}/Latest/F_5500_{YYYY}_Latest.zip
 *
 * The CSV header row uses the field names below (case-sensitive). DOL keeps the
 * header order stable across years; if they ever change it, the parser detects
 * via header row and rebuilds the index map at runtime.
 */

const HEADER_KEYS = [
  "ACK_ID",
  "FORM_PLAN_YEAR_BEGIN_DATE",
  "FORM_TAX_PRD",
  "TYPE_PLAN_ENTITY_CD",
  "TYPE_DFE_PLAN_ENTITY_CD",
  "INITIAL_FILING_IND",
  "AMENDED_IND",
  "FINAL_FILING_IND",
  "SHORT_PLAN_YR_IND",
  "COLLECTIVE_BARGAIN_IND",
  "F5500_PLAN_NUM_BEGIN_DATE",
  "PLAN_NAME",
  "SPONS_DFE_PN",
  "SPONS_DFE_EIN",
  "SPONS_DFE_DBA_NAME",
  "SPONS_DFE_NAME",
  "SPONS_DFE_MAIL_US_ADDRESS1",
  "SPONS_DFE_MAIL_US_CITY",
  "SPONS_DFE_MAIL_US_STATE",
  "SPONS_DFE_MAIL_US_ZIP",
  "SPONS_DFE_PHONE_NUM",
  "ADMIN_NAME",
  "ADMIN_EIN",
  "ADMIN_PHONE_NUM",
  "ADMIN_US_ADDRESS1",
  "ADMIN_US_CITY",
  "ADMIN_US_STATE",
  "ADMIN_US_ZIP",
  "TOT_ACTIVE_PARTCP_CNT",
  "TOT_PARTCP_BOY_CNT",
  "RTRD_SEP_PARTCP_RCVG_CNT",
  "RTRD_SEP_PARTCP_FUT_CNT",
  "PENSION_PLAN_FEATURE_CODES",
  "WELFARE_PLAN_FEATURE_CODES",
  "SCH_A_ATTACHED_IND",
  "SCH_C_ATTACHED_IND",
  "SCH_D_ATTACHED_IND",
  "SCH_G_ATTACHED_IND",
  "SCH_H_ATTACHED_IND",
  "SCH_I_ATTACHED_IND",
  "SCH_R_ATTACHED_IND",
  "SCH_MB_ATTACHED_IND",
  "SCH_SB_ATTACHED_IND",
  "TOT_ASSETS_BOY_AMT",
  "TOT_ASSETS_EOY_AMT",
  "NET_ASSETS_BOY_AMT",
  "NET_ASSETS_EOY_AMT",
  "DATE_RECEIVED",
] as const;

export type HeaderKey = typeof HEADER_KEYS[number];

export function buildHeaderIndex(headerRow: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < headerRow.length; i++) {
    const name = headerRow[i]!.trim().toUpperCase();
    map[name] = i;
  }
  return map;
}

export function field(row: string[], idx: Record<string, number>, key: HeaderKey): string | null {
  const i = idx[key];
  if (i == null) return null;
  const v = row[i];
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function fieldInt(row: string[], idx: Record<string, number>, key: HeaderKey): number | null {
  const s = field(row, idx, key);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function fieldBigInt(row: string[], idx: Record<string, number>, key: HeaderKey): number | null {
  const s = field(row, idx, key);
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function fieldBool(row: string[], idx: Record<string, number>, key: HeaderKey): boolean | null {
  const s = field(row, idx, key);
  if (s == null) return null;
  const u = s.toUpperCase();
  if (u === "1" || u === "Y" || u === "T" || u === "TRUE") return true;
  if (u === "0" || u === "N" || u === "F" || u === "FALSE") return false;
  return null;
}

export function fieldDate(row: string[], idx: Record<string, number>, key: HeaderKey): string | null {
  const s = field(row, idx, key);
  if (s == null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2} /.test(s)) return s.slice(0, 10);
  return null;
}

export const PLAN_ENTITY_TYPE: Record<number, string> = {
  1: "Single-employer",
  2: "Multiple-employer (other than multiemployer)",
  3: "Multiemployer (collectively bargained)",
  4: "Direct Filing Entity (DFE)",
};

export const PENSION_PLAN_FEATURE: Record<string, string> = {
  "1A": "Benefits provided under group insurance arrangement",
  "2A": "Age/service requirements",
  "2C": "401(k) cash or deferred arrangement",
  "2D": "Plan covers self-employed individuals",
  "2E": "Profit-sharing",
  "2F": "ERISA Section 404(c)",
  "2G": "Total or partial participant-directed account plan",
  "2H": "Stock bonus / ESOP",
  "2I": "Plan covers union members",
  "2K": "Leveraged ESOP",
  "2M": "Plan invested in employer securities",
  "2R": "Multiemployer plan",
  "3B": "Section 401(m) arrangement",
  "3C": "Money purchase pension plan",
  "3D": "Target benefit",
  "3E": "Defined benefit / pension equity",
  "3F": "Cash balance",
  "3G": "Hybrid plan",
};
