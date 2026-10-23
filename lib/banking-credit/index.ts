/**
 * Mortgage, Credit Unions & Consumer Finance family — all live, keyless.
 *
 *   hmda_aggregations        — HMDA origination counts / $ volume by county, state, MSA or lender
 *   hmda_jumbo_lenders       — who writes the jumbo mortgages in a county (lender share table)
 *   hmda_lender_lookup       — LEI -> HMDA respondent name, regulator, HQ (+ volume in a geography)
 *   ncua_credit_union_search — NCUA credit unions by name / state / city / ZIP radius, with assets & members
 *   ncua_call_report         — NCUA 5300 call-report financial summary for one credit union, or state ranking
 *   cfpb_complaints          — CFPB Consumer Complaint Database search + aggregations
 *   cfpb_complaint_trends    — monthly / quarterly complaint counts for a company or product
 *
 * Endpoint notes live at the top of each module; see README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { hmdaAggregations, hmdaJumboLenders, hmdaLenderLookup } from "./hmda";
import { ncuaCreditUnionSearch, ncuaCallReport } from "./ncua";
import { cfpbComplaints, cfpbComplaintTrends } from "./cfpb";

const listOrCsv = (desc: string) => ({ type: ["string", "array"], items: { type: "string" }, description: desc });

export const BANKCREDIT_TOOLS: ToolDef[] = [
  {
    name: "hmda_aggregations",
    description:
      "Home Mortgage Disclosure Act (HMDA) aggregate counts and dollar volume from the CFPB/FFIEC Data Browser API (live, keyless; annual 2018–2024 complete, 2025 partial; loan amounts in USD, $10k-bucket midpoints). Scope by ONE geography family — counties (5-digit FIPS, e.g. 17043 DuPage, 17031 Cook, 17097 Lake), states (IL) or msamds (16984 Chicago-Naperville-Evanston MD) — and/or leis (lenders). Add up to TWO data filters (API limit): actions_taken (1 originated — default, 3 denied), loan_purposes (1 purchase, 31 refi, 32 cash-out refi, 2 home improvement), loan_types (1 conventional, 2 FHA, 3 VA), lien_statuses, total_units (1, 2, 3, 4, 5-24…), dwelling_categories, construction_methods, loan_products, races/sexes/ethnicities. Multi-valued filters (e.g. loan_purposes=1,31,32) return one row per value; multiple years return one row per year — good for market-size and trend questions ('how many purchase mortgages were originated in DuPage in 2022 vs 2024 and the average loan size?'). Returns count, sumLoanAmount, avgLoanAmount per row plus totals. For jumbo share and lender rankings use hmda_jumbo_lenders.",
    inputSchema: {
      type: "object",
      properties: {
        years: listOrCsv("HMDA activity year(s) 2018–2025, e.g. 2024 or '2022,2023,2024' (default 2024)"),
        counties: listOrCsv("5-digit county FIPS code(s), e.g. 17043"),
        states: listOrCsv("2-letter state code(s), e.g. IL"),
        msamds: listOrCsv("5-digit MSA/MD code(s), e.g. 16984"),
        leis: listOrCsv("lender LEI(s); may be combined with a geography"),
        actions_taken: listOrCsv("1 originated (default), 2 approved not accepted, 3 denied, 4 withdrawn, 5 incomplete, 6 purchased"),
        loan_purposes: listOrCsv("1 purchase, 2 home improvement, 31 refinance, 32 cash-out refinance, 4 other"),
        loan_types: listOrCsv("1 conventional, 2 FHA, 3 VA, 4 USDA"),
        lien_statuses: listOrCsv("1 first lien, 2 subordinate"),
        total_units: listOrCsv("1,2,3,4,5-24,25-49,50-99,100-149,>149"),
        dwelling_categories: listOrCsv("'Single Family (1-4 Units):Site-Built', 'Multifamily:Site-Built', 'Single Family (1-4 Units):Manufactured'"),
        loan_products: listOrCsv("e.g. 'Conventional:First Lien', 'FHA:First Lien'"),
        construction_methods: listOrCsv("1 site-built, 2 manufactured"),
        races: listOrCsv("e.g. White, Asian, 'Black or African American'"),
        sexes: listOrCsv("Male, Female, Joint"),
        ethnicities: listOrCsv("'Hispanic or Latino', 'Not Hispanic or Latino'"),
      },
    },
    handler: hmdaAggregations,
  },
  {
    name: "hmda_jumbo_lenders",
    description:
      "Ranks mortgage lenders by JUMBO (above the FHFA conforming limit) origination volume in a county or MSA from HMDA loan-level data (CFPB/FFIEC, live, keyless; latest full year 2024). Answers 'who do affluent households in DuPage/Hinsdale get their mortgages from?' — e.g. county 17043 (DuPage), 17031 (Cook), 17097 (Lake IL). Streams the county's public LAR file (1–30 MB), keeps originated 1-4 unit first-lien non-business loans for purchase + refinance + cash-out by default, flags jumbo via HMDA's conforming_loan_limit=NC (2024 baseline $766,550; override with min_loan_amount, e.g. 1500000 for super-jumbo), and returns market totals (jumbo share of count/volume, average jumbo loan), top-N lenders with jumbo loans, volume, share, average rate, and jumbo mix of their own book, plus concentration. Optional: census_tracts to isolate Hinsdale-area tracts, include_top_loans for the largest individual loans (amount, property value, income band), include_tracts for the tracts with most jumbo activity, segment='all' to rank by total (not just jumbo) volume. First call per county/year takes 3–10 s, then cached 24 h. Lender names come from HMDA filers; follow up with hmda_lender_lookup or gleif_entity_profile.",
    inputSchema: {
      type: "object",
      properties: {
        year: { type: "number", default: 2024, description: "HMDA activity year 2018–2024 (2025 partial)" },
        county: { type: "string", description: "5-digit county FIPS (e.g. 17043 DuPage). Provide county or msamd." },
        msamd: { type: "string", description: "5-digit MSA/MD code (e.g. 16984). Large MSAs can exceed the time budget — prefer county." },
        loan_purposes: listOrCsv("default '1,31,32' (purchase, refi, cash-out); 'all' for every purpose"),
        loan_types: listOrCsv("1 conventional, 2 FHA, 3 VA, 4 USDA (default all; jumbo is effectively conventional)"),
        occupancy_types: listOrCsv("1 principal residence, 2 second residence, 3 investment (default all)"),
        first_lien_only: { type: "boolean", default: true },
        census_tracts: listOrCsv("11-digit census tract GEOIDs to restrict to (e.g. Hinsdale-area tracts in 17043/17031)"),
        min_loan_amount: { type: "number", description: "override jumbo threshold in USD (e.g. 1000000)" },
        segment: { type: "string", enum: ["jumbo", "all"], default: "jumbo", description: "rank lenders by jumbo volume (default) or all volume" },
        limit: { type: "number", default: 15, maximum: 25 },
        include_top_loans: { type: "boolean", default: false, description: "include the 15 largest jumbo loans" },
        include_tracts: { type: "boolean", default: false, description: "include the 15 tracts with the most jumbo originations" },
      },
      required: [],
    },
    handler: hmdaJumboLenders,
  },
  {
    name: "hmda_lender_lookup",
    description:
      "Resolve HMDA lender identities: LEI(s) → HMDA respondent name, filing regulator (CFPB/OCC/Fed/FDIC/NCUA/HUD), HQ city/state, RSSD, email domain, parent/top holder when reported, and nationwide HMDA record count for the year; or search by name fragment ('huntington', 'guaranteed rate', 'wintrust') across the ~5,000 HMDA filers (CFPB/FFIEC filers list + institutions API, live, keyless, cached daily). Pass counties or states to also get each lender's originated count and $ volume in that geography for the year (one aggregation call per lender) — useful for 'how big is lender X in DuPage?'. Use after hmda_jumbo_lenders to annotate LEIs, before gleif_entity_profile for corporate hierarchy, or fdic tools for bank financials.",
    inputSchema: {
      type: "object",
      properties: {
        lei: listOrCsv("one or more 20-character LEIs"),
        name: { type: "string", description: "name fragment(s) matched against HMDA filer names (all words must appear)" },
        year: { type: "number", default: 2024 },
        counties: listOrCsv("optional 5-digit FIPS to compute the lender's volume there"),
        states: listOrCsv("optional 2-letter state(s) (ignored if counties given)"),
        limit: { type: "number", default: 10, maximum: 25 },
      },
    },
    handler: hmdaLenderLookup,
  },
  {
    name: "ncua_credit_union_search",
    description:
      "Find federally insured credit unions via NCUA's Credit Union Locator / Research API (mapping.ncua.gov, live, keyless; profile figures from the latest 5300 call report). Three modes: zip + radius_miles (2/5/10/15/25/50) lists credit unions with a BRANCH near a ZIP — e.g. zip 60521 for Hinsdale competitors — with distance and nearest branch; name/state/city searches the charter register (city = HQ mailing city, uppercase matched); charter looks up one number. Each row carries charter #, name, type (FCU/FISCU), status, chartered year, field of membership, peer group, total assets (USD), members, HQ address, phone, website and CEO (include_profile=false for a bare list). Sort by assets (default for register searches), members, distance (default for radius) or name. Use ncua_call_report for net-worth, ROA, loan mix and mortgage book; use fdic_* tools for banks.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "credit-union name fragment (also filters radius results)" },
        charter: { type: "number", description: "NCUA charter number (e.g. 67955 Alliant)" },
        state: { type: "string", description: "2-letter state" },
        city: { type: "string", description: "HQ city (register search)" },
        zip: { type: "string", description: "5-digit ZIP for a branch-radius search" },
        radius_miles: { type: "number", default: 10, description: "2, 5, 10, 15, 25 or 50" },
        type: { type: "string", enum: ["FCU", "FISCU"], description: "federal vs federally insured state charter (register search only)" },
        active_only: { type: "boolean", default: true },
        include_profile: { type: "boolean", default: true, description: "fetch assets/members/website per result (≤25 profile calls, ~0.3 s each, parallel)" },
        sort_by: { type: "string", enum: ["assets", "members", "distance", "name"] },
        limit: { type: "number", default: 15, maximum: 25 },
      },
    },
    handler: ncuaCreditUnionSearch,
  },
  {
    name: "ncua_call_report",
    description:
      "NCUA 5300 Call Report financial summary for a credit union (quarterly zip from ncua.gov, keyless; latest cycle auto-detected, data final ~8 weeks after quarter-end; USD). Pass charter (preferred, from ncua_credit_union_search) or name (+state); returns balance sheet (assets, loans, shares/deposits, net worth, borrowings, uninsured shares, members), ratios (net worth ratio and PCA class, loans/shares, delinquency, annualized ROA, operating expense/assets, cost of funds, net charge-offs, assets per member, first-mortgage share of loans), YTD income (interest income, fee/other income, provision, expenses, dividends, net income, loans granted YTD), the residential real-estate book (1st-lien and junior-lien 1-4 family balances and average first-lien rate), and the credit union's asset rank in its state. compare_prior_year adds the same quarter a year earlier with YoY growth (one extra ~8 MB download). Pass state alone (or rank_state=true) to rank a state's credit unions by assets with key ratios. First call per cycle downloads ~8 MB (3–6 s), then cached 24 h. For banks use fdic tools; for lenders' mortgage share use hmda_jumbo_lenders.",
    inputSchema: {
      type: "object",
      properties: {
        charter: { type: "number", description: "NCUA charter number" },
        name: { type: "string", description: "name fragment; largest asset match wins (others listed)" },
        state: { type: "string", description: "2-letter state — narrows name matches, or alone ranks the state" },
        cycle: { type: "string", description: "quarter-end YYYY-MM (03/06/09/12), default latest published" },
        compare_prior_year: { type: "boolean", default: false },
        rank_state: { type: "boolean", default: false },
        limit: { type: "number", default: 15, maximum: 25, description: "rows in ranking mode" },
      },
    },
    handler: ncuaCallReport,
  },
  {
    name: "cfpb_complaints",
    description:
      "CFPB Consumer Complaint Database search (consumerfinance.gov API, live, keyless, CC0; ~18.6M complaints since 2011, refreshed daily, ~15-day publication lag). Reputational screen on custodians, banks, lenders, servicers and credit bureaus: filter by company (free text auto-resolved to CCDB's exact names, e.g. 'Schwab' → 'CHARLES SCHWAB CORPORATION, THE'; 'A|B' for several), product (Mortgage, 'Checking or savings account', 'Credit card', 'Debt collection', 'Credit reporting or other personal consumer reports', 'Money transfer, virtual currency, or money service', 'Vehicle loan or lease', 'Student loan'), issue, state, zip_code (e.g. 60521), search_term (full text), company_response, timely, and a date window (default last 12 months; date_received_min=2019 for history). Returns total, relief/untimely shares, breakdowns by product→sub-product, issue→sub-issue, company response, company, state and channel, plus the most recent complaints (id, date, product, issue, sub-issue, state, response). Complaint narratives are not exposed by the public API. Compare rates not raw counts — large banks have more complaints. Use cfpb_complaint_trends for time series.",
    inputSchema: {
      type: "object",
      properties: {
        company: listOrCsv("company name(s); free text is resolved via CCDB suggest. Separate several with '|'"),
        exact_company: { type: "boolean", default: false, description: "treat company as the exact CCDB string (skip resolution)" },
        search_term: { type: "string", description: "full-text search across complaint fields" },
        product: listOrCsv("CCDB product name(s)"),
        issue: listOrCsv("CCDB issue name(s)"),
        state: listOrCsv("2-letter state(s)"),
        zip_code: listOrCsv("5-digit ZIP(s)"),
        date_received_min: { type: "string", description: "YYYY, YYYY-MM or YYYY-MM-DD (default 12 months ago)" },
        date_received_max: { type: "string" },
        company_response: listOrCsv("e.g. 'Closed with monetary relief', 'Closed with explanation', 'In progress'"),
        timely: { type: "string", enum: ["Yes", "No"] },
        limit: { type: "number", default: 10, maximum: 25, description: "recent complaints to list (0 for aggregates only)" },
        include_recent: { type: "boolean", default: true },
      },
    },
    handler: cfpbComplaints,
  },
  {
    name: "cfpb_complaint_trends",
    description:
      "Monthly, quarterly or annual CFPB complaint counts for a company, product, issue, state or ZIP (Consumer Complaint Database, live, keyless; built from per-period count queries because the documented /trends endpoint is not deployed). Default: last 12 months for the given filters; interval='quarter' (default 8) or 'year' (default 5), periods up to 36/20/12; end=YYYY-MM-DD to anchor historically. Returns the period labels, counts, total, latest vs prior-period average (spike detector), and peak period; compare_companies=true with 'Schwab|Fidelity|Pershing' yields one series per company (max 5). Company names are auto-resolved to CCDB's exact strings. The last period is partial. Use for 'are complaints about X rising?' before an onboarding or custodian review; use cfpb_complaints for the mix and recent cases.",
    inputSchema: {
      type: "object",
      properties: {
        company: listOrCsv("company name(s), '|' separated"),
        exact_company: { type: "boolean", default: false },
        compare_companies: { type: "boolean", default: false },
        product: listOrCsv("CCDB product name(s)"),
        issue: listOrCsv("CCDB issue name(s)"),
        state: listOrCsv("2-letter state(s)"),
        zip_code: listOrCsv("5-digit ZIP(s)"),
        search_term: { type: "string" },
        interval: { type: "string", enum: ["month", "quarter", "year"], default: "month" },
        periods: { type: "number", description: "number of periods (default 12 months / 8 quarters / 5 years)" },
        end: { type: "string", description: "last period end date YYYY-MM-DD (default today)" },
      },
    },
    handler: cfpbComplaintTrends,
  },
];

export const BANKCREDIT_DOMAIN: CatalogDomain = {
  id: "bankcredit",
  label: "Mortgage, Credit Unions & Consumer Finance (HMDA · NCUA · CFPB)",
  source: "CFPB/FFIEC HMDA Data Browser + institutions API; NCUA Credit Union Locator API and 5300 call-report quarterly files; CFPB Consumer Complaint Database API. All live and keyless.",
  tools: [
    { name: "hmda_aggregations", backing: "live-api", probe: "unprobed", note: "county/state/MSA/LEI counts + $; ≤2 data filters per call" },
    { name: "hmda_jumbo_lenders", backing: "live-api", probe: "unprobed", note: "streams county LAR CSV (1–30 MB), reduces by LEI; cached 24h" },
    { name: "hmda_lender_lookup", backing: "live-api", probe: "unprobed", note: "filers list (120 KB/yr) + institutions API" },
    { name: "ncua_credit_union_search", backing: "live-api", probe: "unprobed", note: "SPA JSON API; ZIP-radius branch search + charter register" },
    { name: "ncua_call_report", backing: "live-api", probe: "unprobed", note: "~8 MB quarterly zip parsed in-memory; cached 24h" },
    { name: "cfpb_complaints", backing: "live-api", probe: "unprobed", note: "ES-style API; company auto-resolved via _suggest_company" },
    { name: "cfpb_complaint_trends", backing: "live-api", probe: "unprobed", note: "per-period counts, 6 parallel; /trends not deployed upstream" },
  ],
};

export const BANKCREDIT_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "bankcredit: HMDA DuPage 2024 purchase originations", tool: "hmda_aggregations", args: { years: 2024, counties: "17043", actions_taken: "1", loan_purposes: "1" }, note: "single cached aggregation (~1 s); expect ~9-10k loans, avg ~$400k" },
  { name: "bankcredit: NCUA profile Alliant (charter 67955)", tool: "ncua_credit_union_search", args: { charter: 67955, limit: 1 }, note: "quick search + profile; expect ~$20B assets, ~950k members" },
  { name: "bankcredit: CFPB complaints Schwab 90d", tool: "cfpb_complaints", args: { company: "Charles Schwab", limit: 2, date_received_min: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10) }, note: "suggest + search; expect CHARLES SCHWAB CORPORATION, THE with product mix" },
];
