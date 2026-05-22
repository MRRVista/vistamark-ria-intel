/**
 * MCP tool handlers for U.S. Treasury Fiscal Data.
 */

import { avgInterestRates, securitiesOutstanding } from "./client";

export interface TreasuryAvgRatesArgs {
  asOfDate?: string;
}

export async function treasuryAvgRates(args: TreasuryAvgRatesArgs) {
  const rows = await avgInterestRates(args.asOfDate);
  if (rows.length === 0) {
    return {
      asOfDate: args.asOfDate ?? null,
      rates: [],
      dataSource: "U.S. Treasury Fiscal Data API",
      note: "No rows returned. The Treasury publishes monthly — try omitting asOfDate for the latest available period.",
    };
  }
  return {
    asOfDate: rows[0]!.record_date,
    rates: rows.map((r) => ({
      securityType: r.security_type_desc,
      securityDesc: r.security_desc,
      avgInterestRate: parseFloat(r.avg_interest_rate_amt),
    })),
    dataSource: "U.S. Treasury Fiscal Data API",
  };
}

export interface TreasuryDebtOutstandingArgs {
  asOfDate?: string;
}

export async function treasuryDebtOutstanding(args: TreasuryDebtOutstandingArgs) {
  const rows = await securitiesOutstanding(args.asOfDate);
  if (rows.length === 0) {
    return {
      asOfDate: args.asOfDate ?? null,
      securities: [],
      dataSource: "U.S. Treasury Fiscal Data API",
      note: "No rows returned. The Treasury publishes monthly — try omitting asOfDate for the latest available period.",
    };
  }
  const total = rows.reduce((sum, r) => sum + (parseFloat(r.total_mil_amt) || 0), 0);
  return {
    asOfDate: rows[0]!.record_date,
    totalDebtMillions: total,
    totalDebtTrillions: +(total / 1e6).toFixed(3),
    securities: rows.map((r) => ({
      securityType: r.security_type_desc,
      securityClass: r.security_class_desc,
      amountMillions: parseFloat(r.total_mil_amt),
    })),
    dataSource: "U.S. Treasury Fiscal Data API",
  };
}
