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
  { name: "database_status", description: "Get the health and freshness of the RIA database: number of firms, latest SEC feed ingested, last successful ingestion run.", inputSchema: { type: "object", properties: {} }, handler: databaseStatus },
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

export const TOOLS: ToolDef[] = [...RIA_TOOLS, ...NONPROFIT_TOOLS, ...MACRO_TOOLS, ...RETIREMENT_TOOLS];
export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
