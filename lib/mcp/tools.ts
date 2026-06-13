import {
  searchRias,
  getRiaProfile,
  searchAdvisors,
  findAlumni,
  getAumHistory,
  firmsUsingCustodian,
  topRiasBy,
  databaseStatus,
} from "../queries";
import {
  propublicaOrgSearch,
  propublicaOrg990,
} from "../propublica/tools";
import {
  irsEoLookup,
  irsEoSearch,
} from "../irs-bmf/queries";
import {
  fredSeriesSearch,
  fredGetSeries,
  fredYieldCurve,
} from "../fred/tools";
import {
  treasuryAvgRates,
  treasuryDebtOutstanding,
} from "../treasury/tools";
import {
  dolPlanSearch,
  dolPlanLookup,
} from "../dol-5500/queries";
import {
  endowmentLookup,
  endowmentSearch,
  endowmentPeerSet,
  endowmentPercentileRank,
  endowmentGrowthHistory,
  endowmentDecadeComparison,
} from "../ipeds/queries";
import {
  nacuboBenchmarkLookup,
} from "../nacubo/queries";
import {
  pppSearch,
  pppLookup,
} from "../sba-ppp/queries";
import {
  holdingsByManager,
  holdersOfSecurity,
} from "../sec-13f/queries";
import {
  fdicBankSearch,
  fdicBankFinancials,
  fdicFailedBanks,
} from "../fdic/tools";
import {
  ofrFinancialStressIndex,
  ofrSeriesSearch,
  ofrSeries,
} from "../ofr/tools";
import {
  edgarCompanyLookup,
  edgarCompanyFilings,
  edgarFinancialConcept,
} from "../edgar/tools";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => Promise<any>;
}

const RIA_TOOLS: ToolDef[] = [
  {
    name: "search_rias",
    description: "Search SEC-registered investment advisers (RIAs) by state, AUM range, accounts, client mix (HNW, pension, charitable), services offered, custody, and name. Returns up to 500 firms with key stats.",
    inputSchema: { type: "object", properties: { state: { type: "string" }, city: { type: "string" }, minAum: { type: "number" }, maxAum: { type: "number" }, minAccounts: { type: "number" }, hasCustody: { type: "boolean" }, isLargeAdviser: { type: "boolean" }, minPctPensionPlans: { type: "number" }, minPctCharitableOrgs: { type: "number" }, minPctHighNetWorth: { type: "number" }, minPctGovernmentEntities: { type: "number" }, minPctIndividualNonHnw: { type: "number" }, offersPensionConsulting: { type: "boolean" }, offersFinancialPlanning: { type: "boolean" }, offersAdvisorSelection: { type: "boolean" }, nameContains: { type: "string" }, sortBy: { type: "string", enum: ["aum", "accounts", "employees", "name"], default: "aum" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 50, maximum: 500 }, offset: { type: "number", default: 0 } } },
    handler: searchRias,
  },
  { name: "get_ria_profile", description: "Get the full Form ADV profile for a single RIA, including AUM history, key advisors, custodians, and private funds. Specify by CRD number or by name (best fuzzy match wins).", inputSchema: { type: "object", properties: { crdNumber: { type: "number" }, legalName: { type: "string" } } }, handler: getRiaProfile },
  { name: "search_advisors", description: "Search individual investment adviser representatives (IARs) by name or current firm.", inputSchema: { type: "object", properties: { name: { type: "string" }, currentFirmName: { type: "string" }, limit: { type: "number", default: 50, maximum: 200 } } }, handler: searchAdvisors },
  { name: "find_alumni", description: "Find advisors who previously worked at a specific firm and have since moved elsewhere. Useful for tracking diaspora from firms like Fiducient Advisors. Returns where each alum currently works.", inputSchema: { type: "object", properties: { priorFirmName: { type: "string" }, limit: { type: "number", default: 100, maximum: 500 } }, required: ["priorFirmName"] }, handler: findAlumni },
  { name: "get_aum_history", description: "Get the time series of AUM, accounts, and employees for a given firm across all ingested ADV filings.", inputSchema: { type: "object", properties: { crdNumber: { type: "number" }, limit: { type: "number", default: 50, maximum: 200 } }, required: ["crdNumber"] }, handler: getAumHistory },
  { name: "firms_using_custodian", description: "List firms reporting a specific qualified custodian (e.g., 'Schwab', 'Fidelity', 'Pershing'). Returns assets and accounts held with that custodian.", inputSchema: { type: "object", properties: { custodianName: { type: "string" }, limit: { type: "number", default: 100, maximum: 500 } }, required: ["custodianName"] }, handler: firmsUsingCustodian },
  { name: "top_rias_by", description: "Rank firms by AUM, accounts, employees, or registered IAR count. Optionally scoped to a single state.", inputSchema: { type: "object", properties: { metric: { type: "string", enum: ["aum", "accounts", "employees", "iars"], default: "aum" }, state: { type: "string" }, limit: { type: "number", default: 25, maximum: 100 } }, required: ["metric"] }, handler: topRiasBy },
  { name: "database_status", description: "Get the health and freshness of the database: firm count, latest SEC feed, last successful ingest run across all DB-backed data sources (ADV, BMF, DOL 5500, IPEDS, NACUBO, SBA PPP, SEC 13F). Note: FDIC, OFR, and SEC EDGAR are live-API sources with no local ingest, so they do not appear here.", inputSchema: { type: "object", properties: {} }, handler: databaseStatus },
];

const NONPROFIT_TOOLS: ToolDef[] = [
  { name: "propublica_org_search", description: "Search ProPublica's Nonprofit Explorer (live API, no caching) for tax-exempt organizations by keyword. Filter by state (2-letter code), NTEE major group (1=Arts, 2=Education, 3=Environment & Animals, 4=Health, 5=Human Services, 6=International, 7=Public Benefit, 8=Religion, 9=Mutual Benefit, 10=Unknown), or IRC subsection (3=501(c)(3), 4=501(c)(4), 6=501(c)(6), etc.). Returns paginated results with EIN, name, location, and subsection classification.", inputSchema: { type: "object", properties: { q: { type: "string" }, state: { type: "string" }, ntee: { type: "number" }, cCode: { type: "number" }, page: { type: "number", default: 0 } }, required: ["q"] }, handler: propublicaOrgSearch },
  { name: "propublica_org_990", description: "Pull a tax-exempt organization's complete 990 filing history from ProPublica. Returns the org profile plus a time series of annual financials (revenue, expenses, total assets, net assets, investment income) for every year on file. Accepts EIN as 9-digit number or 'XX-XXXXXXX' hyphenated string.", inputSchema: { type: "object", properties: { ein: { oneOf: [{ type: "string" }, { type: "number" }] } }, required: ["ein"] }, handler: propublicaOrg990 },
  { name: "irs_eo_lookup", description: "Fast EIN-based lookup of any tax-exempt organization in the IRS Exempt Organizations Business Master File. Returns the org's IRS-registered name, address, IRC subsection (501(c)(?)), foundation classification, NTEE code, latest tax period, and asset/income/revenue bands. Refreshed monthly from IRS bulk feed.", inputSchema: { type: "object", properties: { ein: { oneOf: [{ type: "string" }, { type: "number" }] } }, required: ["ein"] }, handler: irsEoLookup },
  { name: "irs_eo_search", description: "Search the IRS Business Master File of all 1.7M+ tax-exempt organizations. Powerful prospecting filter: state, IRC subsection (3=501(c)(3), 4=501(c)(4)), NTEE major group code prefix (e.g. 'B' for Education), asset/income class buckets (0-9, where 9 = $50M+), or hard-dollar minimums on assets/revenue. Sort by largest assets, income, or revenue.", inputSchema: { type: "object", properties: { name: { type: "string" }, state: { type: "string" }, city: { type: "string" }, subsection: { type: "number" }, nteeCodePrefix: { type: "string" }, minAssetCode: { type: "number" }, minIncomeCode: { type: "number" }, minAssetAmt: { type: "number" }, maxAssetAmt: { type: "number" }, minRevenueAmt: { type: "number" }, foundationCode: { type: "number" }, sortBy: { type: "string", enum: ["asset_amt", "income_amt", "revenue_amt", "name"], default: "asset_amt" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 50, maximum: 500 }, offset: { type: "number", default: 0 } } }, handler: irsEoSearch },
];

const MACRO_TOOLS: ToolDef[] = [
  { name: "fred_series_search", description: "Search FRED (Federal Reserve Economic Data) for time-series by keyword. Returns ranked results with series ID, title, frequency, units, and last update. Common rate series: DGS10 (10Y Treasury), DFF (effective fed funds), DPRIME (bank prime), CPIAUCSL (CPI), UNRATE, VIXCLS, SP500.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 25, maximum: 1000 } }, required: ["query"] }, handler: fredSeriesSearch },
  { name: "fred_get_series", description: "Fetch observations + metadata for a FRED series. Optional date filter (YYYY-MM-DD), frequency aggregation, or unit transformation (lin=raw, chg=change, pch=% change, pc1=% change YoY, pca=% change annualized).", inputSchema: { type: "object", properties: { seriesId: { type: "string" }, observationStart: { type: "string" }, observationEnd: { type: "string" }, frequency: { type: "string", enum: ["d", "w", "bw", "m", "q", "sa", "a"] }, units: { type: "string", enum: ["lin", "chg", "ch1", "pch", "pc1", "pca", "cch", "cca", "log"] }, limit: { type: "number", default: 100, maximum: 100000 } }, required: ["seriesId"] }, handler: fredGetSeries },
  { name: "fred_yield_curve", description: "Fetch the full U.S. Treasury yield curve (1M, 3M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y, 20Y, 30Y constant maturities) for a given date. Defaults to most recent business day. Includes computed 10Y-2Y and 10Y-3M spreads and inversion flags. Source: FRED DGS* series.", inputSchema: { type: "object", properties: { asOfDate: { type: "string" } } }, handler: fredYieldCurve },
  { name: "treasury_avg_rates", description: "Average interest rate paid on outstanding U.S. Treasury debt, broken out by security type (Bills, Notes, Bonds, TIPS, FRNs, etc.) and security description. Published monthly. Defaults to most recent available month.", inputSchema: { type: "object", properties: { asOfDate: { type: "string" } } }, handler: treasuryAvgRates },
  { name: "treasury_debt_outstanding", description: "Total U.S. Treasury debt outstanding by security class. Includes notes, bonds, bills, TIPS, FRNs, savings bonds, GAS, and intragovernmental holdings. Returns per-security amounts in millions plus a top-line total in trillions.", inputSchema: { type: "object", properties: { asOfDate: { type: "string" } } }, handler: treasuryDebtOutstanding },
];

const RETIREMENT_TOOLS: ToolDef[] = [
  { name: "dol_plan_search", description: "Search DOL Form 5500 ERISA plan filings. Prospecting filter: sponsor name, EIN, state, plan year, plan type (1=Single-employer, 2=Multiple-employer, 3=Multiemployer, 4=DFE), 401(k) flag, defined-benefit flag, total-assets range, active-participant minimum. Sort by assets EOY, participants, or plan year.", inputSchema: { type: "object", properties: { sponsorName: { type: "string" }, sponsorEin: { type: "string" }, state: { type: "string" }, city: { type: "string" }, planYear: { type: "number" }, planType: { type: "number" }, is401k: { type: "boolean" }, isDefinedBenefit: { type: "boolean" }, minAssetsEoy: { type: "number" }, maxAssetsEoy: { type: "number" }, minActiveParticipants: { type: "number" }, hasScheduleH: { type: "boolean" }, hasScheduleC: { type: "boolean" }, sortBy: { type: "string", enum: ["assets_eoy", "assets_boy", "active_participants", "plan_year", "sponsor_name"], default: "assets_eoy" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 50, maximum: 500 }, offset: { type: "number", default: 0 } } }, handler: dolPlanSearch },
  { name: "dol_plan_lookup", description: "Look up a specific DOL Form 5500 plan filing. Provide ackId (DOL's filing identifier) for a single filing, or (sponsorEin + planNumber) for that plan's full filing history across years.", inputSchema: { type: "object", properties: { ackId: { type: "string" }, sponsorEin: { type: "string" }, planNumber: { type: "string" }, planYear: { type: "number" } } }, handler: dolPlanLookup },
];

const ENDOWMENT_TOOLS: ToolDef[] = [
  {
    name: "endowment_search",
    description: "Search U.S. higher education endowments by state, control (1=Public, 2=Private nonprofit, 3=Private for-profit), sector (1-9), endowment size range, and institution name. Returns institutions ranked by end-of-year endowment market value. Source: IPEDS Finance Survey Part H — covers all ~6,400 Title IV institutions back to FY 2003-04. Defaults to most recent FY available.",
    inputSchema: { type: "object", properties: { state: { type: "string" }, control: { type: "number" }, sector: { type: "number" }, minEndowment: { type: "number" }, maxEndowment: { type: "number" }, fyear: { type: "number" }, nameContains: { type: "string" }, sortBy: { type: "string", enum: ["market_value_eoy", "market_value_boy", "name", "fyear"], default: "market_value_eoy" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 50, maximum: 500 }, offset: { type: "number", default: 0 } } },
    handler: endowmentSearch,
  },
  {
    name: "endowment_lookup",
    description: "Look up a single institution's endowment history. Provide unitid (IPEDS unique identifier) or instnm (best fuzzy match wins). Returns full institution metadata plus time series of endowment market value beginning-of-year, end-of-year, net change in endowment (IPEDS f2h03 = EOY minus BOY), net investment return, withdrawals, and other adjustments. Optional fyear filter to scope to one year.",
    inputSchema: { type: "object", properties: { unitid: { type: "number" }, instnm: { type: "string" }, fyear: { type: "number" } } },
    handler: endowmentLookup,
  },
  {
    name: "endowment_peer_set",
    description: "Given a target institution (unitid or instnm), find peer institutions with similar-sized endowments in the same fiscal year. Default size band is ±25% of target endowment. Optional sameControl=true restricts peers to the same sector (public, private nonprofit, etc.). Useful for OCIO benchmarking.",
    inputSchema: { type: "object", properties: { unitid: { type: "number" }, instnm: { type: "string" }, fyear: { type: "number" }, sizeBandPct: { type: "number", default: 25 }, sameControl: { type: "boolean" }, limit: { type: "number", default: 25, maximum: 100 } } },
    handler: endowmentPeerSet,
  },
  {
    name: "endowment_percentile_rank",
    description: "Given a target institution (unitid or instnm) and fiscal year, return where its end-of-year endowment ranks among ALL institutions reporting that year: the target value, its percentile (0-100, higher = larger), absolute rank (1 = largest), the size of the reporting universe, and distribution breakpoints (p10/p25/p50/p75/p90/p99). Defaults to the institution's latest reported FY. Useful for positioning a client institution against the national field.",
    inputSchema: { type: "object", properties: { unitid: { type: "number" }, instnm: { type: "string" }, fyear: { type: "number" } } },
    handler: endowmentPercentileRank,
  },
  {
    name: "endowment_growth_history",
    description: "Full growth analytics for one institution (unitid or instnm): compound annual growth rate (CAGR) over 1-year, 3-year, 5-year, 10-year, and all-time windows using end-of-year market values; the best and worst single-year percentage moves; count of declining years; and the underlying year-by-year series. CAGR figures are percentages.",
    inputSchema: { type: "object", properties: { unitid: { type: "number" }, instnm: { type: "string" } } },
    handler: endowmentGrowthHistory,
  },
  {
    name: "endowment_decade_comparison",
    description: "Compare two consecutive multi-year windows for one institution (unitid or instnm): the most recent N years vs the N years before that (default N=10). Returns start/end endowment values, total growth %, and CAGR for each window, plus the change in CAGR between windows (positive = growth accelerating). Useful for spotting whether an endowment's trajectory is improving or fading.",
    inputSchema: { type: "object", properties: { unitid: { type: "number" }, instnm: { type: "string" }, windowYears: { type: "number", default: 10 } } },
    handler: endowmentDecadeComparison,
  },
  {
    name: "nacubo_benchmark_lookup",
    description: "Return NACUBO public NCSE/NTSE/NES benchmark aggregates for a given fiscal year and cohort. Cohorts: 'all' (default), 'over_5b', '1b_5b', '500m_1b', '250m_500m', '100m_250m', '50m_100m', 'under_50m', 'public', 'private_indep'. Returns 1-yr/3-yr/5-yr/10-yr average returns, asset allocation, spending rate, total assets, and median endowment value. Source: NACUBO public press releases — institution-specific data is paywalled by NACUBO.",
    inputSchema: { type: "object", properties: { fyear: { type: "number" }, cohort: { type: "string" }, minFyear: { type: "number" }, maxFyear: { type: "number" }, limit: { type: "number", default: 50, maximum: 500 } } },
    handler: nacuboBenchmarkLookup,
  },
];

const PPP_TOOLS: ToolDef[] = [
  {
    name: "ppp_search",
    description: "Search SBA Paycheck Protection Program (PPP) loans (FOIA loan-level data, >=$150K loans and per-state files when ingested). Prospecting filter: borrower state, name, loan amount range, NAICS code or NAICS prefix, business type (e.g. 'Corporation', 'Non-Profit Organization', 'Limited Liability Company'), nonprofit-only flag, loan status, and city. Sorted by current approval amount by default. Returns borrower, amounts, forgiveness, jobs reported, lender, and location.",
    inputSchema: { type: "object", properties: { state: { type: "string" }, nameContains: { type: "string" }, minAmount: { type: "number" }, maxAmount: { type: "number" }, naicsCode: { type: "string" }, naicsPrefix: { type: "string" }, businessType: { type: "string" }, nonprofitOnly: { type: "boolean" }, loanStatus: { type: "string" }, city: { type: "string" }, sortBy: { type: "string", enum: ["current_approval_amount", "initial_approval_amount", "forgiveness_amount", "jobs_reported", "name", "date_approved"], default: "current_approval_amount" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 50, maximum: 500 }, offset: { type: "number", default: 0 } } },
    handler: pppSearch,
  },
  {
    name: "ppp_lookup",
    description: "Look up SBA PPP loans for a specific borrower. Provide loanNumber for a single loan, or borrowerName (fuzzy match, optionally scoped by state) to return all matching loans sorted by amount. Useful for checking whether a prospect, client, or counterparty took PPP money and how much was forgiven.",
    inputSchema: { type: "object", properties: { loanNumber: { type: "string" }, borrowerName: { type: "string" }, state: { type: "string" }, limit: { type: "number", default: 25, maximum: 200 } } },
    handler: pppLookup,
  },
];

const F13F_TOOLS: ToolDef[] = [
  {
    name: "holdings_by_manager",
    description: "Show an institutional investment manager's reported equity holdings from SEC Form 13F. Provide managerName (fuzzy substring, e.g. 'stepstone', 'cambridge associates') or cik. Returns the manager's most recent ingested filing's positions sorted by market value (or a specific period via periodOfReport YYYY-MM-DD), plus the filing's total reported value and position count. Answers 'what does institution X hold?' for OCIO competitive intelligence. NOTE: 13F covers 13(f) securities (US-listed equities, ETFs, options, convertible debt) over the $100M reporting threshold — not private funds, fixed income, or non-US listings. Holdings are only available for managers that have been ingested into the database.",
    inputSchema: { type: "object", properties: { managerName: { type: "string" }, cik: { type: "string" }, periodOfReport: { type: "string" }, minValueUsd: { type: "number" }, limit: { type: "number", default: 100, maximum: 1000 } } },
    handler: holdingsByManager,
  },
  {
    name: "holders_of_security",
    description: "Show which institutional managers hold a given security, from SEC Form 13F filings. Provide cusip (9-char) or issuerContains (fuzzy issuer-name substring, e.g. 'NVIDIA', 'Apple'). Returns each holder's position value and share count, sorted by value, plus aggregate stats (distinct holder count, total positions, aggregate value) — the crowding / 'smart money' view. Optional periodOfReport (YYYY-MM-DD) and minValueUsd. Operates over ingested 13F filings only, so coverage depends on which managers have been loaded.",
    inputSchema: { type: "object", properties: { cusip: { type: "string" }, issuerContains: { type: "string" }, periodOfReport: { type: "string" }, minValueUsd: { type: "number" }, limit: { type: "number", default: 100, maximum: 1000 } } },
    handler: holdersOfSecurity,
  },
];

const FDIC_TOOLS: ToolDef[] = [
  {
    name: "fdic_bank_search",
    description: "Search FDIC-insured banks and thrifts (BankFind Suite API, live). Prospecting filter: state, name, total-asset range (whole USD), bank class (N=national/OCC, NM=state non-member, SM=state member/Fed, SB=state savings, SA=savings association, OI=insured branch of foreign bank), and community-bank flag. Defaults to active institutions, sorted by total assets descending. Returns name, FDIC cert #, location, total assets, deposits, net income, equity, ROA, ROE, offices, established date, and class. Useful for bank/trust prospecting and the institutional/OCIO bank channel.",
    inputSchema: { type: "object", properties: { state: { type: "string" }, nameContains: { type: "string" }, minAssets: { type: "number" }, maxAssets: { type: "number" }, activeOnly: { type: "boolean", default: true }, bankClass: { type: "string" }, communityBankOnly: { type: "boolean" }, sortBy: { type: "string", enum: ["assets", "deposits", "netIncome", "roa", "roe", "name"], default: "assets" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 25, maximum: 500 }, offset: { type: "number", default: 0 } } },
    handler: fdicBankSearch,
  },
  {
    name: "fdic_bank_financials",
    description: "Get a single bank's quarterly financial time series from the FDIC. Provide cert (FDIC certificate number) or name (best asset-weighted match resolves to a cert). Returns one row per quarterly call-report date (newest first): total assets, deposits, net income, equity (whole USD), plus ROA, ROE, net interest margin, efficiency ratio (percentages), and employee count. Useful for diligence on a bank prospect or counterparty trend.",
    inputSchema: { type: "object", properties: { cert: { type: "number" }, name: { type: "string" }, limit: { type: "number", default: 20, maximum: 100 } } },
    handler: fdicBankFinancials,
  },
  {
    name: "fdic_failed_banks",
    description: "Search historical FDIC bank/thrift failures. Filter by state, year range (fromYear/toYear), and name. Returns name, FDIC cert #, fail date, resolution type, deposits and assets at failure, and the FDIC's estimated resolution cost (whole USD), newest first. Useful for historical context and risk framing.",
    inputSchema: { type: "object", properties: { state: { type: "string" }, fromYear: { type: "number" }, toYear: { type: "number" }, nameContains: { type: "string" }, limit: { type: "number", default: 25, maximum: 500 } } },
    handler: fdicFailedBanks,
  },
];

const OFR_TOOLS: ToolDef[] = [
  {
    name: "ofr_financial_stress_index",
    description: "Get the OFR Financial Stress Index (FSI) — a daily, zero-centered index of global financial stress published by the U.S. Office of Financial Research. Positive = above-average stress, negative = below-average, 0 = historical average. Returns the latest reading, recent history (lookback days, default 30), and the latest category (credit, equity valuation, funding, safe assets, volatility) and region (US, other advanced economies, emerging markets) subindex contributions. A clean systemic-risk gauge to pair with the FRED/Treasury rate tools.",
    inputSchema: { type: "object", properties: { lookback: { type: "number", default: 30, maximum: 1000 } } },
    handler: ofrFinancialStressIndex,
  },
  {
    name: "ofr_series_search",
    description: "Search the OFR Data API catalog (data.financialresearch.gov) for a series mnemonic by keyword. The OFR Short-Term Funding Monitor covers repo markets (tri-party, DVP, GCF), money-market funds, and commercial paper. Returns the provider's catalog results; use a returned mnemonic with ofr_series. For the daily Financial Stress Index, use ofr_financial_stress_index instead.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: ofrSeriesSearch,
  },
  {
    name: "ofr_series",
    description: "Fetch an OFR Data API time series by mnemonic (find one with ofr_series_search). Returns the observations (date/value), the latest reading, and the observation count; optional lookback caps to the most recent N points. Covers OFR Short-Term Funding Monitor series (repo rates and volumes, money-market fund data, commercial paper).",
    inputSchema: { type: "object", properties: { mnemonic: { type: "string" }, lookback: { type: "number" } }, required: ["mnemonic"] },
    handler: ofrSeries,
  },
];

const EDGAR_TOOLS: ToolDef[] = [
  {
    name: "edgar_company_lookup",
    description: "Resolve a public company to its SEC CIK by ticker or name (SEC EDGAR company_tickers.json, live). Returns scored matches with the 10-digit zero-padded cik, numeric cik, ticker, and SEC-registered name. Only companies with a listed ticker appear (private companies and non-ticker filers are excluded). Use a returned cik with edgar_company_filings or edgar_financial_concept.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 10, maximum: 100 } }, required: ["query"] },
    handler: edgarCompanyLookup,
  },
  {
    name: "edgar_company_filings",
    description: "Recent SEC filing history for a public company (EDGAR submissions API, live). Resolve the company by cik, ticker, or name. Optional formType filter (e.g. 10-K, 10-Q, 8-K, DEF 14A, 13F-HR, SC 13D, SC 13G, 4). Returns company metadata (name, tickers, exchanges, SIC, former names) plus the most recent filings (form, filing/report dates, accession number, primary document, and a direct EDGAR document URL). Covers the submissions 'recent' block (~1000 latest filings).",
    inputSchema: { type: "object", properties: { cik: { type: "string" }, ticker: { type: "string" }, name: { type: "string" }, formType: { type: "string" }, limit: { type: "number", default: 25, maximum: 200 } } },
    handler: edgarCompanyFilings,
  },
  {
    name: "edgar_financial_concept",
    description: "Fetch a public company's reported financial concept as a time series from SEC XBRL data (companyconcept API, live). Resolve the company by cik, ticker, or name; concept is a us-gaap taxonomy tag (e.g. Revenues, RevenueFromContractWithCustomerExcludingAssessedTax, Assets, Liabilities, NetIncomeLoss, StockholdersEquity, CashAndCashEquivalentsAtCarryingValue). Optional taxonomy (default us-gaap), unit (default first available, usually USD), annualOnly (10-K / full-year facts only), and limit. Returns the value time series with fiscal year/period, form, and filing date. A company may tag the same line item under different concepts across years.",
    inputSchema: { type: "object", properties: { cik: { type: "string" }, ticker: { type: "string" }, name: { type: "string" }, concept: { type: "string" }, taxonomy: { type: "string" }, unit: { type: "string" }, annualOnly: { type: "boolean" }, limit: { type: "number", default: 40, maximum: 500 } }, required: ["concept"] },
    handler: edgarFinancialConcept,
  },
];

export const TOOLS: ToolDef[] = [
  ...RIA_TOOLS,
  ...NONPROFIT_TOOLS,
  ...MACRO_TOOLS,
  ...RETIREMENT_TOOLS,
  ...ENDOWMENT_TOOLS,
  ...PPP_TOOLS,
  ...F13F_TOOLS,
  ...FDIC_TOOLS,
  ...OFR_TOOLS,
  ...EDGAR_TOOLS,
];
export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
