/**
 * MCP tool handlers for FDIC bank data (BankFind Suite API).
 *
 * Tools:
 *   fdic_bank_search      — search FDIC-insured institutions (prospecting filter)
 *   fdic_bank_financials  — quarterly financial time series for one bank (by CERT or name)
 *   fdic_failed_banks     — historical bank/thrift failures
 *
 * All dollar outputs are whole USD (the FDIC reports thousands; converted here).
 */
import {
  searchInstitutions,
  institutionFinancials,
  bankFailures,
  num,
  type FdicQuery,
} from "./client";

function dollarsK(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : n * 1000;
}

function ymd(s?: string): string | null {
  if (!s) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(s));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s);
}

const SORT_MAP: Record<string, string> = {
  assets: "ASSET", deposits: "DEP", netIncome: "NETINC", roa: "ROA", roe: "ROE", name: "NAME",
};

export interface FdicBankSearchArgs {
  state?: string;
  nameContains?: string;
  minAssets?: number;
  maxAssets?: number;
  activeOnly?: boolean;
  bankClass?: string;
  communityBankOnly?: boolean;
  sortBy?: "assets" | "deposits" | "netIncome" | "roa" | "roe" | "name";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function fdicBankSearch(args: FdicBankSearchArgs) {
  const clauses: string[] = [];
  if (args.state) clauses.push(`STALP:${args.state.toUpperCase()}`);
  if (args.activeOnly !== false) clauses.push("ACTIVE:1"); // default to active institutions
  if (args.bankClass) clauses.push(`BKCLASS:${args.bankClass.toUpperCase()}`);
  if (args.communityBankOnly) clauses.push("CB:1");
  // ASSET filter is in $000s; accept whole-dollar inputs and convert.
  const minK = args.minAssets != null ? Math.round(args.minAssets / 1000) : null;
  const maxK = args.maxAssets != null ? Math.round(args.maxAssets / 1000) : null;
  if (minK != null || maxK != null) {
    clauses.push(`ASSET:[${minK ?? "*"} TO ${maxK ?? "*"}]`);
  }
  const q: FdicQuery = {
    filters: clauses.length ? clauses.join(" AND ") : undefined,
    search: args.nameContains ? `NAME:${args.nameContains}` : undefined,
    fields: ["NAME", "CERT", "CITY", "STALP", "ASSET", "DEP", "NETINC", "ROA", "ROE", "EQ", "OFFICES", "ESTYMD", "ACTIVE", "BKCLASS", "CB", "WEBADDR", "REPDTE"],
    sortBy: SORT_MAP[args.sortBy ?? "assets"] ?? "ASSET",
    sortOrder: (args.sortDir ?? "desc").toUpperCase() === "ASC" ? "ASC" : "DESC",
    limit: Math.min(args.limit ?? 25, 500),
    offset: args.offset ?? 0,
  };
  const { rows, total } = await searchInstitutions(q);
  return {
    dataSource: "FDIC BankFind Suite API",
    totalMatching: total,
    note: "Dollar figures are whole USD (converted from FDIC thousands). Balance-sheet values are as of REPDTE (last call report).",
    banks: rows.map((r) => ({
      name: r.NAME ?? null,
      cert: num(r.CERT),
      city: r.CITY ?? null,
      state: r.STALP ?? null,
      totalAssets: dollarsK(r.ASSET),
      totalDeposits: dollarsK(r.DEP),
      netIncome: dollarsK(r.NETINC),
      totalEquity: dollarsK(r.EQ),
      roa: num(r.ROA),
      roe: num(r.ROE),
      offices: num(r.OFFICES),
      established: ymd(r.ESTYMD),
      active: num(r.ACTIVE) === 1,
      bankClass: r.BKCLASS ?? null,
      communityBank: num(r.CB) === 1,
      website: r.WEBADDR ?? null,
      asOf: ymd(r.REPDTE),
    })),
  };
}

export interface FdicBankFinancialsArgs {
  cert?: number;
  name?: string;
  limit?: number;
}

export async function fdicBankFinancials(args: FdicBankFinancialsArgs) {
  let cert = args.cert ?? null;
  let resolvedName: string | null = null;
  if (cert == null && args.name) {
    const { rows } = await searchInstitutions({
      search: `NAME:${args.name}`,
      fields: ["NAME", "CERT", "STALP", "CITY"],
      sortBy: "ASSET",
      sortOrder: "DESC",
      limit: 1,
    });
    if (rows.length) {
      cert = num(rows[0]!.CERT);
      resolvedName = rows[0]!.NAME ?? null;
    }
  }
  if (cert == null) {
    return {
      dataSource: "FDIC BankFind Suite API",
      error: "Provide cert, or a name that matches an FDIC-insured institution.",
      financials: [],
    };
  }
  const limit = Math.min(args.limit ?? 20, 100);
  const { rows } = await institutionFinancials({
    filters: `CERT:${cert}`,
    fields: ["CERT", "REPDTE", "ASSET", "DEP", "NETINC", "ROA", "ROE", "EQ", "NIMY", "EEFFR", "NUMEMP"],
    sortBy: "REPDTE",
    sortOrder: "DESC",
    limit,
  });
  return {
    dataSource: "FDIC BankFind Suite API",
    cert,
    resolvedName,
    note: "Dollar figures whole USD. ROA/ROE/NIM/efficiency are percentages as reported by the FDIC. One row per quarterly call-report date (REPDTE), newest first.",
    financials: rows.map((r) => ({
      reportDate: ymd(r.REPDTE),
      totalAssets: dollarsK(r.ASSET),
      totalDeposits: dollarsK(r.DEP),
      netIncome: dollarsK(r.NETINC),
      totalEquity: dollarsK(r.EQ),
      roa: num(r.ROA),
      roe: num(r.ROE),
      netInterestMargin: num(r.NIMY),
      efficiencyRatio: num(r.EEFFR),
      employees: num(r.NUMEMP),
    })),
  };
}

export interface FdicFailedBanksArgs {
  state?: string;
  fromYear?: number;
  toYear?: number;
  nameContains?: string;
  limit?: number;
}

export async function fdicFailedBanks(args: FdicFailedBanksArgs) {
  const clauses: string[] = [];
  if (args.state) clauses.push(`PSTALP:${args.state.toUpperCase()}`);
  if (args.fromYear != null || args.toYear != null) {
    clauses.push(`FAILYR:[${args.fromYear ?? "*"} TO ${args.toYear ?? "*"}]`);
  }
  const { rows, total } = await bankFailures({
    filters: clauses.length ? clauses.join(" AND ") : undefined,
    search: args.nameContains ? `NAME:${args.nameContains}` : undefined,
    fields: ["NAME", "CERT", "FAILDATE", "FAILYR", "PSTALP", "CITYST", "RESTYPE", "QBFDEP", "QBFASSET", "COST"],
    sortBy: "FAILDATE",
    sortOrder: "DESC",
    limit: Math.min(args.limit ?? 25, 500),
  });
  return {
    dataSource: "FDIC BankFind Suite API (failures)",
    totalMatching: total,
    note: "Deposits/assets/cost in whole USD (converted from FDIC thousands). COST is the FDIC's estimated resolution cost.",
    failures: rows.map((r) => ({
      name: r.NAME ?? null,
      cert: num(r.CERT),
      failDate: ymd(r.FAILDATE),
      failYear: num(r.FAILYR),
      state: r.PSTALP ?? null,
      cityState: r.CITYST ?? null,
      resolutionType: r.RESTYPE ?? null,
      depositsAtFailure: dollarsK(r.QBFDEP),
      assetsAtFailure: dollarsK(r.QBFASSET),
      estimatedCost: dollarsK(r.COST),
    })),
  };
}
