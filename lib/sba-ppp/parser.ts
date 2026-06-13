/**
 * SBA PPP row → PppLoanInsert mapper. Reuses the streaming CSV primitives from
 * lib/irs-bmf/parser.ts (RFC-4180 quoted CSV with header row).
 */

import {
  buildHeaderIndex,
  field,
  parseMoneyOrNull,
  parseIntOrNull,
  parseDateOrNull,
  parseBoolNonprofit,
} from "./columns";
import type { PppLoanInsert } from "../db/schema";

export function pppRowToRecord(
  row: string[],
  idx: Record<string, number>
): PppLoanInsert | null {
  const loanNumber = field(row, idx, "LoanNumber", "Loan_Number");
  if (!loanNumber) return null;
  const borrowerName = field(row, idx, "BorrowerName", "Borrower_Name");
  if (!borrowerName) return null;

  return {
    loanNumber: loanNumber.slice(0, 20),
    dateApproved: parseDateOrNull(field(row, idx, "DateApproved")),
    borrowerName,
    borrowerAddress: field(row, idx, "BorrowerAddress"),
    borrowerCity: field(row, idx, "BorrowerCity"),
    borrowerState: field(row, idx, "BorrowerState")?.toUpperCase() ?? null,
    borrowerZip: field(row, idx, "BorrowerZip"),
    loanStatus: field(row, idx, "LoanStatus"),
    loanStatusDate: parseDateOrNull(field(row, idx, "LoanStatusDate")),
    initialApprovalAmount: parseMoneyOrNull(field(row, idx, "InitialApprovalAmount")),
    currentApprovalAmount: parseMoneyOrNull(field(row, idx, "CurrentApprovalAmount")),
    undisbursedAmount: parseMoneyOrNull(field(row, idx, "UndisbursedAmount")),
    businessType: field(row, idx, "BusinessType"),
    nonprofitFlag: parseBoolNonprofit(field(row, idx, "NonProfit")),
    naicsCode: field(row, idx, "NAICSCode"),
    jobsReported: parseIntOrNull(field(row, idx, "JobsReported")),
    originatingLender: field(row, idx, "OriginatingLender"),
    servicingLenderName: field(row, idx, "ServicingLenderName"),
    forgivenessAmount: parseMoneyOrNull(field(row, idx, "ForgivenessAmount")),
    forgivenessDate: parseDateOrNull(field(row, idx, "ForgivenessDate")),
    ruralUrbanIndicator: field(row, idx, "RuralUrbanIndicator")?.slice(0, 2) ?? null,
    hubzoneIndicator: field(row, idx, "HubzoneIndicator")?.slice(0, 2) ?? null,
    lmiIndicator: field(row, idx, "LMIIndicator")?.slice(0, 2) ?? null,
  };
}

export { buildHeaderIndex };
export { newStreamState, consumeCsvChunk, finishCsvStream } from "../irs-bmf/parser";
export type { CsvStreamState } from "../irs-bmf/parser";
