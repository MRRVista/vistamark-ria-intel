/**
 * Query handlers for the IRS Form 990 e-file family.
 *
 * Tools:
 *   irs990_filing_get      — one EIN's filings (latest first) with financial summary
 *   irs990_board           — current officers / directors / trustees for an EIN
 *   irs990_people_search   — fuzzy name search across every filer's Part VII
 *   irs990_boards_of_person — every board / officer seat a person holds
 *   irs990_filing_search   — filings by org name / state / city / type / assets
 *
 * All read the irs990_* tables loaded by scripts/irs990-ingest.ts. The
 * "current board" means the latest return per EIN (irs990_latest_filings).
 */

import { sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { normalizeName } from "./parse";

const EIN_NOTE = "EIN as 9 digits or 'XX-XXXXXXX'.";

function cleanEin(ein: string | number): string {
  const d = String(ein).replace(/\D/g, "").padStart(9, "0");
  if (d.length !== 9) throw new Error(`Invalid EIN: ${ein}`);
  return d;
}

function rows<T = any>(r: any): T[] {
  return (r?.rows ?? r ?? []) as T[];
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const PERSON_SELECT = sql`
  p.id::float8 AS id, p.object_id AS "objectId", p.ein, p.tax_year AS "taxYear", p.seq,
  p.name_raw AS "name", p.name_norm AS "nameNorm", p.title, p.is_business AS "isBusiness",
  p.avg_hours::float AS "avgHours", p.avg_hours_related::float AS "avgHoursRelated",
  p.is_individual_trustee AS "isIndividualTrustee", p.is_institutional_trustee AS "isInstitutionalTrustee",
  p.is_officer AS "isOfficer", p.is_key_employee AS "isKeyEmployee",
  p.is_highest_comp AS "isHighestComp", p.is_former AS "isFormer",
  p.comp_org::float8 AS "compOrg", p.comp_related::float8 AS "compRelated", p.comp_other::float8 AS "compOther",
  p.address_line1 AS "addressLine1", p.city AS "personCity", p.state AS "personState", p.zip AS "personZip"`;

const FILING_SELECT = sql`
  f.object_id AS "objectId", f.ein, f.return_type AS "returnType", f.tax_year AS "taxYear",
  f.tax_period_begin::text AS "taxPeriodBegin", f.tax_period_end::text AS "taxPeriodEnd",
  f.return_ts AS "returnTs", f.amended_return AS "amendedReturn", f.final_return AS "finalReturn",
  f.org_name AS "orgName", f.in_care_of AS "inCareOf", f.address_line1 AS "addressLine1",
  f.city, f.state, f.zip, f.website, f.formation_year AS "formationYear", f.mission,
  f.gross_receipts::float8 AS "grossReceipts", f.total_revenue::float8 AS "totalRevenue", f.total_expenses::float8 AS "totalExpenses",
  f.total_assets_eoy::float8 AS "totalAssetsEoy", f.total_liabilities_eoy::float8 AS "totalLiabilitiesEoy",
  f.net_assets_eoy::float8 AS "netAssetsEoy", f.contributions::float8 AS contributions, f.investment_income::float8 AS "investmentIncome",
  f.investments_public::float8 AS "investmentsPublic", f.investments_other::float8 AS "investmentsOther",
  f.investments_program::float8 AS "investmentsProgram", f.endowment_eoy::float8 AS "endowmentEoy", f.invest_mgmt_fees::float8 AS "investMgmtFees",
  f.voting_members AS "votingMembers", f.independent_members AS "independentMembers",
  f.employees, f.volunteers, f.officer_count AS "officerCount",
  f.signer_name AS "signerName", f.signer_title AS "signerTitle"`;

// ---------------------------------------------------------------------------

export interface Irs990FilingGetArgs {
  ein: string | number;
  limit?: number;
  includePeople?: boolean;
}

export async function irs990FilingGet(args: Irs990FilingGetArgs) {
  if (!isDbReady()) return { dbReady: false, filings: [] };
  if (args.ein == null) throw new Error(`irs990_filing_get requires \`ein\`. ${EIN_NOTE}`);
  const ein = cleanEin(args.ein);
  const limit = Math.min(Math.max(num(args.limit) ?? 10, 1), 50);
  const filings = rows(await db.execute(sql`
    SELECT ${FILING_SELECT} FROM irs990_filings f
    WHERE f.ein = ${ein}
    ORDER BY f.tax_period_end DESC NULLS LAST, f.return_ts DESC NULLS LAST
    LIMIT ${limit}`));
  let people: any[] = [];
  if (args.includePeople !== false && filings.length) {
    people = rows(await db.execute(sql`
      SELECT ${PERSON_SELECT} FROM irs990_persons p
      WHERE p.object_id = ${filings[0].objectId}
      ORDER BY p.seq`));
  }
  return {
    dbReady: true,
    ein,
    orgName: filings[0]?.orgName ?? null,
    filingCount: filings.length,
    filings,
    latestBoard: people,
    note: filings.length
      ? "filings newest-first; latestBoard = Part VII people on the newest return. Compensation in whole USD; avgHours per week. 990-PF people carry an address; 990/990-EZ people do not."
      : "No e-filed 990/990-EZ/990-PF on record for this EIN in the loaded index years. Small orgs file 990-N (no people table) — check irs_eo_lookup for filing requirement codes.",
  };
}

// ---------------------------------------------------------------------------

export interface Irs990BoardArgs {
  ein: string | number;
  includeFormer?: boolean;
  includeEmployees?: boolean;
}

export async function irs990Board(args: Irs990BoardArgs) {
  if (!isDbReady()) return { dbReady: false, people: [] };
  if (args.ein == null) throw new Error(`irs990_board requires \`ein\`. ${EIN_NOTE}`);
  const ein = cleanEin(args.ein);
  const latest = rows(await db.execute(sql`
    SELECT ${FILING_SELECT} FROM irs990_latest_filings f WHERE f.ein = ${ein}`))[0] ?? null;
  if (!latest) return { dbReady: true, ein, filing: null, people: [], note: "No e-filed return loaded for this EIN." };
  const conds = [sql`p.object_id = ${latest.objectId}`];
  if (!args.includeFormer) conds.push(sql`p.is_former = FALSE`);
  // drop rows that are ONLY "highest compensated employee" (staff, not governance)
  if (!args.includeEmployees) conds.push(sql`NOT (p.is_highest_comp AND NOT p.is_officer AND NOT p.is_key_employee AND NOT p.is_individual_trustee AND NOT p.is_institutional_trustee)`);
  const people = rows(await db.execute(sql`
    SELECT ${PERSON_SELECT} FROM irs990_persons p
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY p.is_officer DESC, p.is_individual_trustee DESC, p.seq`));
  return {
    dbReady: true,
    ein,
    filing: latest,
    people,
    counts: {
      listed: people.length,
      officers: people.filter((p) => p.isOfficer).length,
      directorsOrTrustees: people.filter((p) => p.isIndividualTrustee || p.isInstitutionalTrustee).length,
      votingMembersReported: latest.votingMembers,
      independentReported: latest.independentMembers,
    },
    note: "People from the newest return on file (tax period end " + latest.taxPeriodEnd + "). Role flags are the form's own checkboxes on 990; inferred from title on 990-EZ/990-PF. Set includeFormer / includeEmployees to widen.",
  };
}

// ---------------------------------------------------------------------------

export interface Irs990PeopleSearchArgs {
  name?: string;
  surname?: string;
  orgName?: string;
  orgState?: string;
  orgCity?: string;
  personZip?: string;
  title?: string;
  role?: "officer" | "director" | "key_employee" | "highest_comp" | "any";
  minHours?: number;
  minCompOrg?: number;
  latestOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function irs990PeopleSearch(args: Irs990PeopleSearchArgs) {
  if (!isDbReady()) return { dbReady: false, total: 0, people: [] };
  const limit = Math.min(Math.max(num(args.limit) ?? 50, 1), 500);
  const offset = Math.max(num(args.offset) ?? 0, 0);
  const conds: any[] = [sql`p.is_business = FALSE`];
  let orderBy = sql`f.tax_period_end DESC, f.total_assets_eoy DESC NULLS LAST`;

  if (args.name) {
    const { norm, surname } = normalizeName(args.name);
    if (norm.length < 3) throw new Error("name must be at least 3 characters after normalization");
    if (surname) {
      // Full name: trigram index scan (%) narrowed to a real similarity floor,
      // OR same surname + same leading token (handles middle initials).
      const firstTok = norm.split(" ")[0]!;
      conds.push(sql`((p.name_norm % ${norm} AND similarity(p.name_norm, ${norm}) >= 0.5) OR (p.surname = ${surname} AND p.name_norm LIKE ${firstTok + " %"}))`);
    } else {
      // Single token: treat as a surname, with a contains fallback.
      conds.push(sql`(p.surname = ${norm} OR p.name_norm LIKE ${"% " + norm + "%"})`);
    }
    orderBy = sql`similarity(p.name_norm, ${norm}) DESC, f.tax_period_end DESC`;
  }
  if (args.surname) conds.push(sql`p.surname = ${args.surname.toUpperCase().replace(/[^A-Z0-9\-&]/g, "")}`);
  if (args.orgName) conds.push(sql`f.org_name ILIKE ${"%" + args.orgName + "%"}`);
  if (args.orgState) conds.push(sql`f.state = ${args.orgState.toUpperCase()}`);
  if (args.orgCity) conds.push(sql`f.city ILIKE ${args.orgCity}`);
  if (args.personZip) conds.push(sql`p.zip LIKE ${String(args.personZip).slice(0, 5) + "%"}`);
  if (args.title) conds.push(sql`p.title ILIKE ${"%" + args.title + "%"}`);
  switch (args.role) {
    case "officer": conds.push(sql`p.is_officer`); break;
    case "director": conds.push(sql`(p.is_individual_trustee OR p.is_institutional_trustee)`); break;
    case "key_employee": conds.push(sql`p.is_key_employee`); break;
    case "highest_comp": conds.push(sql`p.is_highest_comp`); break;
  }
  if (num(args.minHours) != null) conds.push(sql`p.avg_hours >= ${num(args.minHours)}`);
  if (num(args.minCompOrg) != null) conds.push(sql`p.comp_org >= ${num(args.minCompOrg)}`);
  if (conds.length === 1) throw new Error("irs990_people_search needs at least one filter (name, surname, orgName, orgState+title, personZip…)");

  const filingTable = args.latestOnly === false ? sql`irs990_filings` : sql`irs990_latest_filings`;
  const where = sql.join(conds, sql` AND `);
  const [countRes, listRes] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS total FROM irs990_persons p JOIN ${filingTable} f ON f.object_id = p.object_id WHERE ${where}`),
    db.execute(sql`
      SELECT ${PERSON_SELECT},
        f.org_name AS "orgName", f.return_type AS "returnType", f.tax_period_end::text AS "taxPeriodEnd",
        f.city AS "orgCity", f.state AS "orgState", f.zip AS "orgZip",
        f.total_assets_eoy::float8 AS "orgTotalAssets", f.total_revenue::float8 AS "orgTotalRevenue"
      FROM irs990_persons p
      JOIN ${filingTable} f ON f.object_id = p.object_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}`),
  ]);
  return {
    dbReady: true,
    total: rows(countRes)[0]?.total ?? 0,
    limit,
    offset,
    people: rows(listRes),
    note: "Default latestOnly=true searches each org's newest return only (current seats). Set latestOnly=false for history. Common surnames return many unrelated people — add orgState/orgCity or personZip (990-PF only) to disambiguate.",
  };
}

// ---------------------------------------------------------------------------

export interface Irs990BoardsOfPersonArgs {
  name: string;
  state?: string;
  latestOnly?: boolean;
  limit?: number;
}

export async function irs990BoardsOfPerson(args: Irs990BoardsOfPersonArgs) {
  if (!isDbReady()) return { dbReady: false, seats: [] };
  if (!args.name) throw new Error("irs990_boards_of_person requires `name`");
  const { norm, surname } = normalizeName(args.name);
  if (norm.length < 5 || !surname) throw new Error("name should be a full name (first + last)");
  const limit = Math.min(Math.max(num(args.limit) ?? 50, 1), 200);
  const filingTable = args.latestOnly === false ? sql`irs990_filings` : sql`irs990_latest_filings`;
  const conds: any[] = [sql`p.surname = ${surname}`, sql`p.name_norm % ${norm}`, sql`p.is_business = FALSE`];
  if (args.state) conds.push(sql`f.state = ${args.state.toUpperCase()}`);
  const seats = rows(await db.execute(sql`
    SELECT ${PERSON_SELECT},
      similarity(p.name_norm, ${norm})::float AS score,
      f.org_name AS "orgName", f.return_type AS "returnType", f.tax_year AS "orgTaxYear", f.tax_period_end::text AS "taxPeriodEnd",
      f.city AS "orgCity", f.state AS "orgState", f.zip AS "orgZip", f.website AS "orgWebsite",
      f.total_assets_eoy::float8 AS "orgTotalAssets", f.total_revenue::float8 AS "orgTotalRevenue", f.mission AS "orgMission"
    FROM irs990_persons p
    JOIN ${filingTable} f ON f.object_id = p.object_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY score DESC, f.total_assets_eoy DESC NULLS LAST
    LIMIT ${limit}`));
  const exact = seats.filter((s) => s.nameNorm === norm);
  return {
    dbReady: true,
    query: { name: args.name, normalized: norm, surname },
    exactMatches: exact.length,
    seats,
    note: "score = trigram similarity to the normalized query (1.0 = identical). Exact-name rows are the safe set; lower scores are middle-initial / nickname variants and should be reviewed. Org city/state help confirm it is the same person.",
  };
}

// ---------------------------------------------------------------------------

export interface Irs990FilingSearchArgs {
  orgName?: string;
  state?: string;
  city?: string;
  zip?: string;
  returnType?: "990" | "990EZ" | "990PF";
  taxYear?: number;
  minTotalAssets?: number;
  maxTotalAssets?: number;
  minTotalRevenue?: number;
  minInvestments?: number;
  minEndowment?: number;
  minVotingMembers?: number;
  sortBy?: "total_assets_eoy" | "total_revenue" | "net_assets_eoy" | "org_name" | "tax_period_end" | "endowment_eoy" | "invest_mgmt_fees";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function irs990FilingSearch(args: Irs990FilingSearchArgs) {
  if (!isDbReady()) return { dbReady: false, total: 0, filings: [] };
  const limit = Math.min(Math.max(num(args.limit) ?? 50, 1), 500);
  const offset = Math.max(num(args.offset) ?? 0, 0);
  const conds: any[] = [sql`TRUE`];
  if (args.orgName) conds.push(sql`f.org_name ILIKE ${"%" + args.orgName + "%"}`);
  if (args.state) conds.push(sql`f.state = ${args.state.toUpperCase()}`);
  if (args.city) conds.push(sql`f.city ILIKE ${args.city}`);
  if (args.zip) conds.push(sql`f.zip LIKE ${String(args.zip).slice(0, 5) + "%"}`);
  if (args.returnType) conds.push(sql`f.return_type = ${args.returnType}`);
  if (num(args.taxYear) != null) conds.push(sql`f.tax_year = ${num(args.taxYear)}`);
  if (num(args.minTotalAssets) != null) conds.push(sql`f.total_assets_eoy >= ${num(args.minTotalAssets)}`);
  if (num(args.maxTotalAssets) != null) conds.push(sql`f.total_assets_eoy <= ${num(args.maxTotalAssets)}`);
  if (num(args.minTotalRevenue) != null) conds.push(sql`f.total_revenue >= ${num(args.minTotalRevenue)}`);
  if (num(args.minInvestments) != null) conds.push(sql`(COALESCE(f.investments_public,0) + COALESCE(f.investments_other,0) + COALESCE(f.investments_program,0)) >= ${num(args.minInvestments)}`);
  if (num(args.minEndowment) != null) conds.push(sql`f.endowment_eoy >= ${num(args.minEndowment)}`);
  if (num(args.minVotingMembers) != null) conds.push(sql`f.voting_members >= ${num(args.minVotingMembers)}`);
  const sortCol = ["total_assets_eoy", "total_revenue", "net_assets_eoy", "org_name", "tax_period_end", "endowment_eoy", "invest_mgmt_fees"].includes(args.sortBy ?? "")
    ? sql.raw(`f.${args.sortBy}`)
    : sql.raw("f.total_assets_eoy");
  const dir = args.sortDir === "asc" ? sql.raw("ASC NULLS LAST") : sql.raw("DESC NULLS LAST");
  const table = num(args.taxYear) != null ? sql`irs990_filings` : sql`irs990_latest_filings`;
  const where = sql.join(conds, sql` AND `);
  const [countRes, listRes] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS total FROM ${table} f WHERE ${where}`),
    db.execute(sql`SELECT ${FILING_SELECT} FROM ${table} f WHERE ${where} ORDER BY ${sortCol} ${dir} LIMIT ${limit} OFFSET ${offset}`),
  ]);
  return {
    dbReady: true,
    total: rows(countRes)[0]?.total ?? 0,
    limit,
    offset,
    filings: rows(listRes),
    note: "Without taxYear this searches each org's newest return (one row per EIN). Pair with irs990_board to pull the people, or irs_eo_lookup for the BMF registration record.",
  };
}

// ---------------------------------------------------------------------------

/** Status for /api/admin/irs990 and the console. */
export async function irs990Status() {
  if (!isDbReady()) return { dbReady: false };
  const [totals, batches, byYear] = await Promise.all([
    db.execute(sql`
      SELECT (SELECT count(*)::int FROM irs990_filings) AS filings,
             (SELECT count(*)::int FROM irs990_persons) AS persons,
             (SELECT count(DISTINCT ein)::int FROM irs990_filings) AS orgs,
             (SELECT max(finished_at) FROM irs990_batches WHERE status='ok') AS "lastLoadedAt"`),
    db.execute(sql`SELECT * FROM irs990_batches ORDER BY batch_id DESC LIMIT 60`),
    db.execute(sql`SELECT tax_year AS "taxYear", return_type AS "returnType", count(*)::int AS filings FROM irs990_filings GROUP BY 1,2 ORDER BY 1 DESC, 2`),
  ]);
  return { dbReady: true, totals: rows(totals)[0] ?? null, batches: rows(batches), byYear: rows(byYear) };
}
