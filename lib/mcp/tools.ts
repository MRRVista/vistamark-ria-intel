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
  macroMarketSignals,
  fredBatchLatest,
} from "../macro/signals";
import {
  treasuryAvgRates,
  treasuryDebtOutstanding,
} from "../treasury/tools";
import {
  treasuryDailyCash,
  treasuryDailyFlows,
} from "../treasury/dts";
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
  usaspendingAwardsSearch,
  usaspendingTopRecipients,
} from "../usaspending/tools";
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
import {
  edgarFullTextSearch,
  formdSearch,
} from "../edgar/fulltext";
import {
  edgarConceptFrame,
} from "../edgar/frames";
import {
  gleifEntitySearch,
  gleifEntityProfile,
} from "../gleif/tools";
import {
  bdcList,
  bdcProfile,
  bdcScreen,
} from "../bdc/tools";
import {
  ppdPlanSearch,
  ppdPlanProfile,
  ppdListVariables,
} from "../pensions/tools";

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
  { name: "database_status", description: "Get the health and freshness of the database: firm count, latest SEC feed, last successful ingest run across all DB-backed data sources (ADV, BMF, DOL 5500, IPEDS, NACUBO, SBA PPP, SEC 13F). Note: FDIC, OFR, SEC EDGAR (incl. full-text/Form D/frames), GLEIF LEI, BDC, public-pension (PPD), USAspending, Treasury DTS, and the macro signals layer are live-API sources with no local ingest, so they do not appear here.", inputSchema: { type: "object", properties: {} }, handler: databaseStatus },
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
  {
    name: "macro_market_signals",
    description: "The market's early-warning dashboard in one call (FRED, live): 21 curated indicators across six pillars — CURVE (10Y-3M and 10Y-2Y spreads with inversion flags, 10Y nominal and TIPS real yield), CREDIT (ICE BofA High Yield and IG OAS with stress tiers, Chicago Fed NFCI, St. Louis Fed Financial Stress Index), LIQUIDITY (Fed balance sheet, overnight RRP, Treasury General Account, plus computed NET LIQUIDITY = WALCL − RRP − TGA in USD trillions with 1m/3m changes), GROWTH/LABOR (initial jobless claims momentum, Sahm rule trigger, Weekly Economic Index, building permits, unemployment), INFLATION EXPECTATIONS (10Y breakeven, 5Y5Y forward, CPI YoY), SENTIMENT/VOL (VIX regime tiers, Michigan consumer sentiment, daily Economic Policy Uncertainty). Each reading: latest value, ~1-month and ~3-month priors, changes, and a threshold-based signal grounded in documented historical relationships (e.g. 3M-10Y inversion preceding recessions, Sahm rule's real-time record). Currently-firing signals roll up into a highlights array. Optional pillars filter (['curve','credit','liquidity','growth','inflation','sentiment']). Indicators, not predictions — pair with ofr_financial_stress_index and fred_yield_curve; drill into any series with fred_get_series.",
    inputSchema: { type: "object", properties: { pillars: { type: "array", items: { type: "string", enum: ["curve", "credit", "liquidity", "growth", "inflation", "sentiment"] } } } },
    handler: macroMarketSignals,
  },
  {
    name: "fred_batch_latest",
    description: "Fetch the latest print plus ~1-month and ~3-month priors (with changes) for a LIST of FRED series in one parallel call — max 15 series. The building block for ad-hoc macro dashboards and pre-market briefs: pass any mix of rates, spreads, employment, inflation, commodity, or index series IDs (find IDs with fred_series_search). Returns per-series title, units, frequency, latest value/date, priors, and absolute changes; per-series errors surface individually without failing the batch. For a curated leading-indicator composite use macro_market_signals; for full history on one series use fred_get_series.",
    inputSchema: { type: "object", properties: { seriesIds: { type: "array", items: { type: "string" } }, maxSeries: { type: "number", default: 15, maximum: 15 } }, required: ["seriesIds"] },
    handler: fredBatchLatest,
  },
  { name: "treasury_avg_rates", description: "Average interest rate paid on outstanding U.S. Treasury debt, broken out by security type (Bills, Notes, Bonds, TIPS, FRNs, etc.) and security description. Published monthly. Defaults to most recent available month.", inputSchema: { type: "object", properties: { asOfDate: { type: "string" } } }, handler: treasuryAvgRates },
  { name: "treasury_debt_outstanding", description: "Total U.S. Treasury debt outstanding by security class. Includes notes, bonds, bills, TIPS, FRNs, savings bonds, GAS, and intragovernmental holdings. Returns per-security amounts in millions plus a top-line total in trillions.", inputSchema: { type: "object", properties: { asOfDate: { type: "string" } } }, handler: treasuryDebtOutstanding },
  {
    name: "treasury_daily_cash",
    description: "Daily Treasury General Account (TGA) cash balance from the Daily Treasury Statement (FiscalData, live, no key) — the DAILY version of the weekly WTREGEN series in macro_market_signals' net-liquidity calc. TGA drawdowns inject liquidity into the banking system; rebuilds (tax season, post-debt-ceiling refills) drain it. Returns the latest closing balance ($B), ~1-week and ~1-month changes ($B), and the daily series (values reported by Treasury in $ millions), plus the account types present for audit. Published each business day for the prior business day. Plausibility-gated ($30B–$2.5T) after the net-liquidity unit lesson; sampleRawRow surfaces if Treasury's field names drift.",
    inputSchema: { type: "object", properties: { lookbackDays: { type: "number", default: 30, maximum: 400 } } },
    handler: treasuryDailyCash,
  },
  {
    name: "treasury_daily_flows",
    description: "Daily federal cash deposits and withdrawals by category from the Daily Treasury Statement (FiscalData, live, no key) — the real-time fiscal-flows tape. Headline signal: 'Taxes - Withheld Individual/FICA' deposits track wage payrolls with ~1-day lag; focusCategory defaults to 'withheld' and returns that category's daily series plus latest today/MTD/FYTD amounts (FYTD vs the same point last fiscal year is the cleanest comparison — payment-calendar effects make day/week deltas noisy). Also returns the latest day's top deposit and withdrawal categories (topN, default 8), side sums excluding Treasury's own 'Total' rows (double-count guard; totals reported separately), and net flow. Category matching is case-insensitive contains — try focusCategory 'corporate' (corporate income taxes) or 'interest' (debt service). Optional transactionType filter ('deposits'|'withdrawals'). Figures in $ millions; publication lags one business day.",
    inputSchema: { type: "object", properties: { lookbackDays: { type: "number", default: 30, maximum: 120 }, focusCategory: { type: "string" }, transactionType: { type: "string", enum: ["deposits", "withdrawals"] }, topN: { type: "number", default: 8, maximum: 25 } } },
    handler: treasuryDailyFlows,
  },
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

const USASPENDING_TOOLS: ToolDef[] = [
  {
    name: "usaspending_awards_search",
    description: "Search federal awards to a recipient (USAspending.gov, live API). Award-level detail: grants, contracts, loans, or direct payments (awardType picks the group — the API cannot mix groups in one request). Filter by recipientName (fuzzy), keywords, recipientState, and startDate/endDate (default: last 3 years — this endpoint is slow over wide windows; widen deliberately or use usaspending_top_recipients for long-window totals). Returns award ID, recipient, dates, obligation amount (whole USD), awarding agency/sub-agency, description, and a USAspending.gov award link. Prospecting/diligence signal: a nonprofit or health system living on large federal grants has budget and reserve dynamics worth a board conversation; a company with big federal contracts has revenue concentration worth knowing. Pairs with irs_eo_search (find the org) — then this shows its federal money.",
    inputSchema: { type: "object", properties: { recipientName: { type: "string" }, keywords: { type: "string" }, awardType: { type: "string", enum: ["grants", "contracts", "loans", "direct_payments", "other", "idvs"], default: "grants" }, recipientState: { type: "string" }, startDate: { type: "string" }, endDate: { type: "string" }, sortBy: { type: "string", enum: ["amount", "end_date"], default: "amount" }, limit: { type: "number", default: 25, maximum: 100 }, page: { type: "number", default: 1 } } },
    handler: usaspendingAwardsSearch,
  },
  {
    name: "usaspending_top_recipients",
    description: "Rank the top recipients of federal awards by obligation total (USAspending.gov, live API) — the screening view. Scope by awardType group (grants, contracts, loans, direct_payments, other, idvs), recipientState, and startDate/endDate (default: last 10 years). Returns recipient name, aggregated obligations (whole USD) over the requested period/type, and recipient identifiers. Use to screen e.g. 'top federal grant recipients in IL' for nonprofit/health-system prospecting, then drill into a name with usaspending_awards_search. Totals are period-scoped obligations, not lifetime figures.",
    inputSchema: { type: "object", properties: { awardType: { type: "string", enum: ["grants", "contracts", "loans", "direct_payments", "other", "idvs"], default: "grants" }, recipientState: { type: "string" }, startDate: { type: "string" }, endDate: { type: "string" }, limit: { type: "number", default: 10, maximum: 100 }, page: { type: "number", default: 1 } } },
    handler: usaspendingTopRecipients,
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
    description: "Fetch a public company's reported financial concept as a time series from SEC XBRL data (companyconcept API, live). Resolve the company by cik, ticker, or name; concept is a us-gaap taxonomy tag (e.g. Revenues, RevenueFromContractWithCustomerExcludingAssessedTax, Assets, Liabilities, NetIncomeLoss, StockholdersEquity, CashAndCashEquivalentsAtCarryingValue). Optional taxonomy (default us-gaap), unit (default first available, usually USD), annualOnly (10-K / full-year facts only), and limit. Returns the value time series with fiscal year/period, form, and filing date. Freshness-aware tag fallback: when the requested concept returns nothing OR its latest fact is stale (>~18 months — filers switch tags across years), common alternates are tried and the freshest tag wins (staleFallbackUsed flags the switch; candidateLatest makes it auditable).",
    inputSchema: { type: "object", properties: { cik: { type: "string" }, ticker: { type: "string" }, name: { type: "string" }, concept: { type: "string" }, taxonomy: { type: "string" }, unit: { type: "string" }, annualOnly: { type: "boolean" }, limit: { type: "number", default: 40, maximum: 500 } }, required: ["concept"] },
    handler: edgarFinancialConcept,
  },
  {
    name: "edgar_concept_frame",
    description: "Screen or rank ALL SEC filers by one XBRL concept for one period (EDGAR frames API, live) — the cross-market transpose of edgar_financial_concept. E.g. 'largest filers by Assets at Q4 2025', 'every filer's NetIncomeLoss for CY2025', or a named peer set's values via nameContains. Provide concept (us-gaap tag), year, and optionally quarter and instantaneous; duration frames (CY2025, CY2025Q3) serve flow concepts like Revenues/NetIncomeLoss, instantaneous frames (CY2025Q4I) serve balance-sheet concepts like Assets/StockholdersEquity — mismatches are retried automatically (resolvedFrame shows what served the data). Returns entities sorted by value (sortDir 'asc' for smallest-first) with entityName, CIK, value, period end, and accession number; minValue floors a screen; totalEntities reports the full universe size. One as-reported fact per filer per frame; frames lag filings by weeks. unit defaults to USD ('shares' and 'USD-per-shares' also exist).",
    inputSchema: { type: "object", properties: { concept: { type: "string" }, year: { type: "number" }, quarter: { type: "number" }, instantaneous: { type: "boolean" }, taxonomy: { type: "string" }, unit: { type: "string" }, nameContains: { type: "string" }, minValue: { type: "number" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 25, maximum: 200 } }, required: ["concept", "year"] },
    handler: edgarConceptFrame,
  },
  {
    name: "edgar_fulltext_search",
    description: "Keyword search across the TEXT of all SEC EDGAR filings from 2001 onward (efts.sec.gov full-text search, live). The only free cross-filer search — reaches every filer including private funds and companies with no ticker (which edgar_company_lookup cannot resolve). Filter by form type(s) (comma-separated, e.g. 'D', '8-K,10-K', 'N-2') and date range (startDate/endDate, YYYY-MM-DD). Supports quoted phrases for exact match. Returns filer name, CIK, form, file date, accession number, and direct EDGAR document URLs. The API serves at most 10 hits per page — use offset (multiples of 10) to page through; totalMatches reports the full count. Useful for finding filings that MENTION a person, firm, fund, or term anywhere in the text — and, date-bounded to the last few days, as a near-real-time filing monitor (e.g. 8-K risk events, going-concern language, covenant amendments).",
    inputSchema: { type: "object", properties: { query: { type: "string" }, forms: { type: "string" }, startDate: { type: "string" }, endDate: { type: "string" }, limit: { type: "number", default: 10, maximum: 10 }, offset: { type: "number", default: 0 } }, required: ["query"] },
    handler: edgarFullTextSearch,
  },
  {
    name: "formd_search",
    description: "Search SEC Form D filings — Reg D exempt-offering notices that reveal which GPs, private funds, and issuers are RAISING capital, filed within days of first sale (EDGAR full-text search scoped to forms D and D/A, live). Provide a keyword (fund/GP/issuer name or strategy term like 'credit fund', 'real estate', 'secondaries') and optional startDate/endDate (YYYY-MM-DD) to scope to recent raises. includeAmendments (default true) also returns D/A amendments. Each hit links to the filing, which lists offering size, amount sold, minimum investment, and related persons. 10 hits per page (offset paginates); totalMatches is the full count. Feeds GP fundraising intelligence, alternatives sourcing, and M&A/BA-Solutions-style buyer research — and date-bounded counts serve as a private-market risk-appetite gauge.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, startDate: { type: "string" }, endDate: { type: "string" }, includeAmendments: { type: "boolean", default: true }, limit: { type: "number", default: 10, maximum: 10 }, offset: { type: "number", default: 0 } }, required: ["query"] },
    handler: formdSearch,
  },
];

const GLEIF_TOOLS: ToolDef[] = [
  {
    name: "gleif_entity_search",
    description: "Resolve any legal entity worldwide to its LEI record (GLEIF LEI API, live — the ISO 17442 Legal Entity Identifier registry). Fulltext search across legal names, other/former names, and addresses; optional 2-letter country filter on the legal address. Returns LEI, legal name, entity status (ACTIVE/INACTIVE), jurisdiction, category, legal/HQ addresses, and registration status/dates. Results are re-ranked client-side to put legal-name matches first (GLEIF's own fulltext also matches addresses). Coverage skews to financial-market participants — funds, GPs, banks, insurers, issuers — plus many private operating companies that ticker-based lookups (edgar_company_lookup) cannot reach. Use a returned lei with gleif_entity_profile for corporate family trees.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, country: { type: "string" }, limit: { type: "number", default: 10, maximum: 50 }, page: { type: "number", default: 1 } }, required: ["query"] },
    handler: gleifEntitySearch,
  },
  {
    name: "gleif_entity_profile",
    description: "One entity's LEI record PLUS its corporate family tree (GLEIF LEI API, live): direct parent, ultimate parent, and direct children under ACCOUNTING-CONSOLIDATION relationships. Resolve by lei (20-char identifier) or by name (best legal-name match wins). Answers 'which umbrella does this fund sit under?' for manager diligence and maps a PE firm's entity structure for M&A buyer research. Null parents are common and valid — many entities file reporting exceptions (e.g. no consolidating parent). childTotal reports the full subsidiary count; childrenLimit (default 10, max 50) caps what's returned.",
    inputSchema: { type: "object", properties: { lei: { type: "string" }, name: { type: "string" }, childrenLimit: { type: "number", default: 10, maximum: 50 } } },
    handler: gleifEntityProfile,
  },
];

const BDC_TOOLS: ToolDef[] = [
  {
    name: "bdc_list",
    description: "List the tracked universe of U.S.-listed Business Development Companies (BDCs) — large/mid-cap names in the VanEck BIZD / MVIS US BDC Index style. Returns ticker, name, and the live SEC CIK (resolved at query time), flagging any ticker that no longer resolves. Optional nameContains / tickerContains filters. BDCs are the main listed private-credit vehicles (Ares ARCC, Blue Owl OBDC, FS KKR FSK, Blackstone BXSL, Main Street MAIN, etc.); use a returned ticker/cik with bdc_profile or any edgar_* tool. NOTE: the universe is a curated snapshot, not a live BIZD holdings pull.",
    inputSchema: { type: "object", properties: { nameContains: { type: "string" }, tickerContains: { type: "string" }, limit: { type: "number", default: 100, maximum: 100 } } },
    handler: bdcList,
  },
  {
    name: "bdc_profile",
    description: "Profile a single BDC from SEC data (live EDGAR XBRL + submissions). Resolve by ticker (e.g. ARCC) or name. Returns key BDC financials — total assets, net assets, total investments at fair value, total investment income, net investment income, and NAV per share — plus recent filings (10-K/10-Q/8-K/N-2/DEF 14A) with direct EDGAR URLs. annualOnly (default true) uses 10-K / full-year facts. BDC XBRL tagging varies by filer, so each metric reports the concept that actually resolved, or null if this filer didn't tag it (NAV/share is frequently untagged). Figures are as-reported.",
    inputSchema: { type: "object", properties: { ticker: { type: "string" }, name: { type: "string" }, annualOnly: { type: "boolean", default: true } } },
    handler: bdcProfile,
  },
  {
    name: "bdc_screen",
    description: "Rank the tracked BDC universe by a financial metric pulled from SEC XBRL (live): netAssets (default), totalAssets, totalInvestmentsFairValue, totalInvestmentIncome, netInvestmentIncome, or navPerShare. Processes the first `limit` BDCs (default 12, max = universe size); each BDC is a separate SEC call, so larger limits are slower. Returns a descending ranking plus any names whose metric wasn't tagged or whose ticker didn't resolve. Useful for sizing and peer screening across listed private-credit BDCs.",
    inputSchema: { type: "object", properties: { metric: { type: "string", enum: ["totalAssets", "netAssets", "totalInvestmentsFairValue", "totalInvestmentIncome", "netInvestmentIncome", "navPerShare"], default: "netAssets" }, limit: { type: "number", default: 12, maximum: 40 }, annualOnly: { type: "boolean", default: true } } },
    handler: bdcScreen,
  },
];

const PENSION_TOOLS: ToolDef[] = [
  {
    name: "ppd_plan_search",
    description: "Search/screen U.S. state & local public pension plans (Public Plans Database, live API — the CRR/MissionSquare/NASRA/GFOA panel of ~230 largest public plans, the vast majority of public-plan assets). Filter by state, plan name, market-asset range (whole USD), and GASB funded-ratio range; sort by assets (default), funded_ratio, return_assumption, or name. Returns each plan's latest reported FY: market/actuarial assets, actuarial liabilities, funded ratio %, investment return assumption %, and membership counts. Public/governmental plans are ERISA-exempt and NOT in the DOL 5500 dataset — this is the asset-owner universe for public-fund OCIO prospecting (underfunded plans and above-market return assumptions are conversation starters).",
    inputSchema: { type: "object", properties: { state: { type: "string" }, nameContains: { type: "string" }, minAssetsUsd: { type: "number" }, maxAssetsUsd: { type: "number" }, minFundedRatioPct: { type: "number" }, maxFundedRatioPct: { type: "number" }, sortBy: { type: "string", enum: ["assets", "funded_ratio", "return_assumption", "name"], default: "assets" }, sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" }, limit: { type: "number", default: 25, maximum: 250 } } },
    handler: ppdPlanSearch,
  },
  {
    name: "ppd_plan_profile",
    description: "One public pension plan's multi-year funding history (Public Plans Database, live API). Resolve by ppdId or plan name (fuzzy; e.g. 'Illinois Municipal', 'California PERF'). Returns an annual series FY2001+ of market and actuarial assets, actuarial liabilities, GASB funded ratio %, investment return assumption %, and active/beneficiary membership, plus the latest year. Dollar amounts converted from PPD thousands to whole USD (flagged as unitAssumption). Useful for funding-trend diligence on a public-plan prospect: direction of funded ratio, whether the return assumption has been cut, and demographic pressure (actives vs beneficiaries).",
    inputSchema: { type: "object", properties: { ppdId: { type: "number" }, name: { type: "string" }, limit: { type: "number", default: 25, maximum: 30 } } },
    handler: ppdPlanProfile,
  },
  {
    name: "ppd_list_variables",
    description: "List the Public Plans Database's own variable catalog (q=ListVariables, live API) — the authoritative source for exact PPD variable names and definitions (e.g. MktAssets_net, ActFundedRatio_GASB, InvestmentReturnAssumption_GASB). Optional nameContains filter (matches anywhere in the catalog entry) and limit. Use to discover which funding, return, membership, and asset-allocation variables exist before interpreting ppd_plan_search / ppd_plan_profile output, or to diagnose a rejected query.",
    inputSchema: { type: "object", properties: { nameContains: { type: "string" }, limit: { type: "number", default: 50, maximum: 500 } } },
    handler: ppdListVariables,
  },
];

export const TOOLS: ToolDef[] = [
  ...RIA_TOOLS,
  ...NONPROFIT_TOOLS,
  ...MACRO_TOOLS,
  ...RETIREMENT_TOOLS,
  ...ENDOWMENT_TOOLS,
  ...PPP_TOOLS,
  ...USASPENDING_TOOLS,
  ...F13F_TOOLS,
  ...FDIC_TOOLS,
  ...OFR_TOOLS,
  ...EDGAR_TOOLS,
  ...GLEIF_TOOLS,
  ...BDC_TOOLS,
  ...PENSION_TOOLS,
];
export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
