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

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  handler: (args: any) => Promise<any>;
}

export const TOOLS: ToolDef[] = [
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
        isLargeAdviser: {
          type: "boolean",
          description: "Filter firms with regulatory AUM >= $100M (SEC large adviser threshold)",
        },
        minPctPensionPlans: { type: "number", description: "Minimum percentage of pension/profit-sharing clients" },
        minPctCharitableOrgs: {
          type: "number",
          description: "Minimum percentage of charitable organization clients",
        },
        minPctHighNetWorth: {
          type: "number",
          description: "Minimum percentage of high-net-worth individual clients",
        },
        minPctGovernmentEntities: {
          type: "number",
          description: "Minimum percentage of state/local government clients",
        },
        minPctIndividualNonHnw: {
          type: "number",
          description: "Minimum percentage of non-HNW individual clients",
        },
        offersPensionConsulting: { type: "boolean" },
        offersFinancialPlanning: { type: "boolean" },
        offersAdvisorSelection: { type: "boolean" },
        nameContains: { type: "string", description: "Substring match on legal or business name" },
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
    description:
      "Get the full Form ADV profile for a single RIA, including AUM history, key advisors, custodians, and private funds. Specify by CRD number or by name (best fuzzy match wins).",
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
    description:
      "Search individual investment adviser representatives (IARs) by name or current firm.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Substring match on full name" },
        currentFirmName: { type: "string", description: "Filter to advisors currently at firms matching this name" },
        limit: { type: "number", default: 50, maximum: 200 },
      },
    },
    handler: searchAdvisors,
  },
  {
    name: "find_alumni",
    description:
      "Find advisors who previously worked at a specific firm and have since moved elsewhere. Useful for tracking diaspora from firms like Fiducient Advisors. Returns where each alum currently works.",
    inputSchema: {
      type: "object",
      properties: {
        priorFirmName: {
          type: "string",
          description: "Firm name to find alumni of (fuzzy match, e.g., 'Fiducient', 'DiMeo Schneider')",
        },
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
    description:
      "List firms reporting a specific qualified custodian (e.g., 'Schwab', 'Fidelity', 'Pershing'). Returns assets and accounts held with that custodian.",
    inputSchema: {
      type: "object",
      properties: {
        custodianName: { type: "string", description: "Custodian name (fuzzy match)" },
        limit: { type: "number", default: 100, maximum: 500 },
      },
      required: ["custodianName"],
    },
    handler: firmsUsingCustodian,
  },
  {
    name: "top_rias_by",
    description:
      "Rank firms by AUM, accounts, employees, or registered IAR count. Optionally scoped to a single state. Useful for 'largest RIAs in Illinois' style queries.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["aum", "accounts", "employees", "iars"], default: "aum" },
        state: { type: "string", description: "Two-letter US state code (optional)" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
      required: ["metric"],
    },
    handler: topRiasBy,
  },
  {
    name: "database_status",
    description:
      "Get the health and freshness of the RIA database: number of firms, latest SEC feed ingested, last successful ingestion run.",
    inputSchema: { type: "object", properties: {} },
    handler: databaseStatus,
  },
];

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
