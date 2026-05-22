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

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => Promise<any>;
}

// ─── RIA tools (ADV) ─────────────────────────────────────────────────────
const RIA_TOOLS: ToolDef[] = [
  {
    name: "search_rias",
    description:
      "Search SEC-registered investment advisers (RIAs) by state, AUM range, accounts, client mix (HNW, pension, charitable), services offered, custody, and name. Returns up to 500 firms with key stats.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: "string", description: "Two-letter US state code, e.g., 'IL'" },
        city: { type: "string", description: "City name (case-insensitive partial match)" },
        minAum: { type: "number", description: "Minimum total regulatory AUM in dollars" },
        maxAum: { type: "number", description: "Maximum total regulatory AUM in dollars" },
        minAccounts: { type: "number", description: "Minimum total accounts" },
        hasCustody: { type: "boolean", description: "Filter firms that have custody of client assets" },
        isLargeAdviser: { type: "boolean", description: "Filter firms with regulatory AUM >= $100M" },
        minPctPensionPlans: { type: "number" },
        minPctCharitableOrgs: { type: "number" },
        minPctHighNetWorth: { type: "number" },
        minPctGovernmentEntities: { type: "number" },
        minPctIndividualNonHnw: { type: "number" },
        offersPensionConsulting: { type: "boolean" },
        offersFinancialPlanning: { type: "boolean" },
        offersAdvisorSelection: { type: "boolean" },
        nameContains: { type: "string" },
        sortBy: { type: "string", enum: ["aum", "accounts", "employees", "name"], default: "aum" },
        sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" },
        limit: { type: "number", default: 50, maximum: 500 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: searchRias,
  },
  {
    name: "get_ria_profile",
    description: "Get the full Form ADV profile for a single RIA, including AUM history, key advisors, custodians, and private funds. Specify by CRD number or by name (best fuzzy match wins).",
    inputSchema: {
      type: "object",
      properties: {
        crdNumber: { type: "number", description: "SEC/IARD CRD number" },
        legalName: { type: "string", description: "Firm legal name (fuzzy match)" },
      },
    },
    handler: getRiaProfile,
  },
  {
    name: "search_advisors",
    description: "Search individual investment adviser representatives (IARs) by name or current firm.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        currentFirmName: { type: "string" },
        limit: { type: "number", default: 50, maximum: 200 },
      },
    },
    handler: searchAdvisors,
  },
  {
    name: "find_alumni",
    description: "Find advisors who previously worked at a specific firm and have since moved elsewhere. Useful for tracking diaspora from firms like Fiducient Advisors. Returns where each alum currently works.",
    inputSchema: {
      type: "object",
      properties: {
        priorFirmName: { type: "string" },
        limit: { type: "number", default: 100, maximum: 500 },
      },
      required: ["priorFirmName"],
    },
    handler: findAlumni,
  },
  {
    name: "get_aum_history",
    description: "Get the time series of AUM, accounts, and employees for a given firm across all ingested ADV filings.",
    inputSchema: {
      type: "object",
      properties: {
        crdNumber: { type: "number" },
        limit: { type: "number", default: 50, maximum: 200 },
      },
      required: ["crdNumber"],
    },
    handler: getAumHistory,
  },
  {
    name: "firms_using_custodian",
    description: "List firms reporting a specific qualified custodian (e.g., 'Schwab', 'Fidelity', 'Pershing'). Returns assets and accounts held with that custodian.",
    inputSchema: {
      type: "object",
      properties: {
        custodianName: { type: "string" },
        limit: { type: "number", default: 100, maximum: 500 },
      },
      required: ["custodianName"],
    },
    handler: firmsUsingCustodian,
  },
  {
    name: "top_rias_by",
    description: "Rank firms by AUM, accounts, employees, or registered IAR count. Optionally scoped to a single state.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["aum", "accounts", "employees", "iars"], default: "aum" },
        state: { type: "string" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
      required: ["metric"],
    },
    handler: topRiasBy,
  },
  {
    name: "database_status",
    description: "Get the health and freshness of the RIA database: number of firms, latest SEC feed ingested, last successful ingestion run.",
    inputSchema: { type: "object", properties: {} },
    handler: databaseStatus,
  },
];

// ─── Nonprofit tools (Phase 1) ───────────────────────────────────────────
const NONPROFIT_TOOLS: ToolDef[] = [
  {
    name: "propublica_org_search",
    description: "Search ProPublica's Nonprofit Explorer (live API, no caching) for tax-exempt organizations by keyword. Filter by state (2-letter code), NTEE major group (1=Arts, 2=Education, 3=Environment & Animals, 4=Health, 5=Human Services, 6=International, 7=Public Benefit, 8=Religion, 9=Mutual Benefit, 10=Unknown), or IRC subsection (3=501(c)(3), 4=501(c)(4), 6=501(c)(6), etc.). Returns paginated results with EIN, name, location, and subsection classification.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query (required)" },
        state: { type: "string", description: "Two-letter state code, e.g. 'IL'" },
        ntee: { type: "number", description: "NTEE major group code (1-10)" },
        cCode: { type: "number", description: "IRC subsection code, e.g. 3 for 501(c)(3)" },
        page: { type: "number", default: 0 },
      },
      required: ["q"],
    },
    handler: propublicaOrgSearch,
  },
  {
    name: "propublica_org_990",
    description: "Pull a tax-exempt organization's complete 990 filing history from ProPublica. Returns the org profile plus a time series of annual financials (revenue, expenses, total assets, net assets, investment income) for every year on file. Accepts EIN as 9-digit number or 'XX-XXXXXXX' hyphenated string.",
    inputSchema: {
      type: "object",
      properties: {
        ein: { description: "9-digit EIN. Number or string.", oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["ein"],
    },
    handler: propublicaOrg990,
  },
  {
    name: "irs_eo_lookup",
    description: "Fast EIN-based lookup of any tax-exempt organization in the IRS Exempt Organizations Business Master File. Returns the org's IRS-registered name, address, IRC subsection (501(c)(?)), foundation classification, NTEE code, latest tax period, and asset/income/revenue bands. Refreshed monthly from IRS bulk feed.",
    inputSchema: {
      type: "object",
      properties: {
        ein: { description: "9-digit EIN (with or without hyphen).", oneOf: [{ type: "string" }, { type: "number" }] },
      },
      required: ["ein"],
    },
    handler: irsEoLookup,
  },
  {
    name: "irs_eo_search",
    description: "Search the IRS Business Master File of all 1.7M+ tax-exempt organizations. Powerful prospecting filter: state, IRC subsection (3=501(c)(3), 4=501(c)(4)), NTEE major group code prefix (e.g. 'B' for Education), asset/income class buckets (0-9, where 9 = $50M+), or hard-dollar minimums on assets/revenue. Sort by largest assets, income, or revenue.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        state: { type: "string" },
        city: { type: "string" },
        subsection: { type: "number", description: "IRC subsection (3 = 501(c)(3), 4 = 501(c)(4), etc.)" },
        nteeCodePrefix: { type: "string", description: "NTEE code prefix, e.g. 'B' or 'B5'" },
        minAssetCode: { type: "number", description: "Minimum asset code (0-9): 6=$1M+, 7=$5M+, 8=$10M+, 9=$50M+" },
        minIncomeCode: { type: "number" },
        minAssetAmt: { type: "number" },
        maxAssetAmt: { type: "number" },
        minRevenueAmt: { type: "number" },
        foundationCode: { type: "number" },
        sortBy: { type: "string", enum: ["asset_amt", "income_amt", "revenue_amt", "name"], default: "asset_amt" },
        sortDir: { type: "string", enum: ["asc", "desc"], default: "desc" },
        limit: { type: "number", default: 50, maximum: 500 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: irsEoSearch,
  },
];

export const TOOLS: ToolDef[] = [...RIA_TOOLS, ...NONPROFIT_TOOLS];

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
