/**
 * DOL Form 5500 row → PlanInsert mapper.
 *
 * We reuse the streaming CSV parser primitives from lib/irs-bmf/parser.ts
 * (consumeCsvChunk / finishCsvStream / newStreamState) — the format is the
 * same RFC-4180-ish quoted CSV.
 */

import type { PlanInsert } from "../db/schema";
import {
  buildHeaderIndex,
  field,
  fieldBigInt,
  fieldBool,
  fieldDate,
  fieldInt,
} from "./columns";
import type { HeaderKey } from "./columns";

export function planRowToRecord(
  row: string[],
  headerIndex: Record<string, number>
): PlanInsert | null {
  const ackId = field(row, headerIndex, "ACK_ID");
  if (!ackId) return null;

  const beginDate = fieldDate(row, headerIndex, "FORM_PLAN_YEAR_BEGIN_DATE");
  const planYear = beginDate ? Number(beginDate.slice(0, 4)) : null;

  return {
    ackId,
    formPlanYearBeginDate: beginDate,
    formTaxPrd: field(row, headerIndex, "FORM_TAX_PRD"),
    typePlanEntityCd: fieldInt(row, headerIndex, "TYPE_PLAN_ENTITY_CD"),
    typeDfePlanEntityCd: fieldInt(row, headerIndex, "TYPE_DFE_PLAN_ENTITY_CD"),
    initialFilingInd: fieldBool(row, headerIndex, "INITIAL_FILING_IND"),
    amendedInd: fieldBool(row, headerIndex, "AMENDED_IND"),
    finalFilingInd: fieldBool(row, headerIndex, "FINAL_FILING_IND"),
    shortPlanYrInd: fieldBool(row, headerIndex, "SHORT_PLAN_YR_IND"),
    collectiveBargainInd: fieldBool(row, headerIndex, "COLLECTIVE_BARGAIN_IND"),
    planYear,
    planName: field(row, headerIndex, "PLAN_NAME"),
    sponsDfePn: field(row, headerIndex, "SPONS_DFE_PN"),
    sponsDfeEin: normalizeEin(field(row, headerIndex, "SPONS_DFE_EIN")),
    sponsDfeName: field(row, headerIndex, "SPONS_DFE_NAME"),
    sponsDfeDbaName: field(row, headerIndex, "SPONS_DFE_DBA_NAME"),
    sponsDfeMailAddr1: field(row, headerIndex, "SPONS_DFE_MAIL_US_ADDRESS1"),
    sponsDfeMailCity: field(row, headerIndex, "SPONS_DFE_MAIL_US_CITY"),
    sponsDfeMailState: field(row, headerIndex, "SPONS_DFE_MAIL_US_STATE")?.toUpperCase() ?? null,
    sponsDfeMailZip: field(row, headerIndex, "SPONS_DFE_MAIL_US_ZIP"),
    sponsDfePhone: field(row, headerIndex, "SPONS_DFE_PHONE_NUM"),
    adminName: field(row, headerIndex, "ADMIN_NAME"),
    adminEin: normalizeEin(field(row, headerIndex, "ADMIN_EIN")),
    adminPhone: field(row, headerIndex, "ADMIN_PHONE_NUM"),
    adminAddr1: field(row, headerIndex, "ADMIN_US_ADDRESS1"),
    adminCity: field(row, headerIndex, "ADMIN_US_CITY"),
    adminState: field(row, headerIndex, "ADMIN_US_STATE")?.toUpperCase() ?? null,
    adminZip: field(row, headerIndex, "ADMIN_US_ZIP"),
    totActivePartcpCnt: fieldInt(row, headerIndex, "TOT_ACTIVE_PARTCP_CNT"),
    totPartcpBoyCnt: fieldInt(row, headerIndex, "TOT_PARTCP_BOY_CNT"),
    rtrdSepPartcpRcvgCnt: fieldInt(row, headerIndex, "RTRD_SEP_PARTCP_RCVG_CNT"),
    rtrdSepPartcpFutCnt: fieldInt(row, headerIndex, "RTRD_SEP_PARTCP_FUT_CNT"),
    pensionPlanFeatureCodes: field(row, headerIndex, "PENSION_PLAN_FEATURE_CODES"),
    welfarePlanFeatureCodes: field(row, headerIndex, "WELFARE_PLAN_FEATURE_CODES"),
    schAAttachedInd: fieldBool(row, headerIndex, "SCH_A_ATTACHED_IND"),
    schCAttachedInd: fieldBool(row, headerIndex, "SCH_C_ATTACHED_IND"),
    schDAttachedInd: fieldBool(row, headerIndex, "SCH_D_ATTACHED_IND"),
    schGAttachedInd: fieldBool(row, headerIndex, "SCH_G_ATTACHED_IND"),
    schHAttachedInd: fieldBool(row, headerIndex, "SCH_H_ATTACHED_IND"),
    schIAttachedInd: fieldBool(row, headerIndex, "SCH_I_ATTACHED_IND"),
    schRAttachedInd: fieldBool(row, headerIndex, "SCH_R_ATTACHED_IND"),
    schMbAttachedInd: fieldBool(row, headerIndex, "SCH_MB_ATTACHED_IND"),
    schSbAttachedInd: fieldBool(row, headerIndex, "SCH_SB_ATTACHED_IND"),
    totAssetsBoyAmt: fieldBigInt(row, headerIndex, "TOT_ASSETS_BOY_AMT"),
    totAssetsEoyAmt: fieldBigInt(row, headerIndex, "TOT_ASSETS_EOY_AMT"),
    netAssetsBoyAmt: fieldBigInt(row, headerIndex, "NET_ASSETS_BOY_AMT"),
    netAssetsEoyAmt: fieldBigInt(row, headerIndex, "NET_ASSETS_EOY_AMT"),
    dateReceived: fieldDate(row, headerIndex, "DATE_RECEIVED"),
  };
}

function normalizeEin(s: string | null): string | null {
  if (s == null) return null;
  const digits = s.replace(/\D/g, "");
  return digits === "" ? null : digits;
}

export { newStreamState, consumeCsvChunk, finishCsvStream } from "../irs-bmf/parser";
export type { CsvStreamState } from "../irs-bmf/parser";
export { buildHeaderIndex } from "./columns";
