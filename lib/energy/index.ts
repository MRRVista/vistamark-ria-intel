/**
 * Energy & Commodities family — EIA Open Data (keyed), CFTC Commitments of
 * Traders (keyless Socrata) and Baker Hughes rig counts (keyless xlsx).
 *
 *   eia_series              — any EIA API v2 dataset route with facets/frequency/window stats (EIA_API_KEY)
 *   eia_browse              — EIA v2 route / facet discovery (EIA_API_KEY)
 *   cftc_cot                — COT net positioning by trader class, 52w percentile, WoW change
 *   cftc_cot_markets        — search COT contract market names / codes
 *   baker_hughes_rig_count  — weekly US & Canada oil/gas rig counts with 1w/4w/52w changes
 *
 * Existing overlap: fred_get_series already serves daily WTI (DCOILWTICO),
 * Brent (DCOILBRENTEU) and Henry Hub (DHHNGSP) spot keylessly — descriptions
 * steer the model there for prices and here for EIA-only data (inventories,
 * storage, production, electricity, STEO) and positioning.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { eiaSeries, eiaBrowse } from "./eia";
import { cftcCot, cftcCotMarkets } from "./cftc";
import { bakerHughesRigCount } from "./bakerhughes";

export const ENERGY_TOOLS: ToolDef[] = [
  {
    name: "eia_series",
    description:
      "Fetch any U.S. Energy Information Administration (EIA) Open Data API v2 dataset (KEYED: EIA_API_KEY, free). Give a `route` (e.g. 'petroleum/pri/spt' spot prices, 'natural-gas/pri/fut' Henry Hub spot/futures, 'natural-gas/stor/wkly' weekly storage Bcf, 'petroleum/stoc/wstk' weekly crude/product stocks, 'petroleum/sum/sndw' weekly supply/demand, 'petroleum/crd/drill' rigs, 'electricity/retail-sales' price/sales by state+sector, 'total-energy' MER, 'steo' forecasts), a `frequency` the dataset supports (daily/weekly/monthly/annual...), `facets` to pin series (e.g. {series:['RWTC']} WTI Cushing, {series:['RBRTE']} Brent, {series:['RNGWHHD']} Henry Hub, {stateid:['IL'],sectorid:['RES']}), optional start/end (dataset date format) and `data` columns (default 'value'). Returns up to `length` (≤60, default 24) newest periods grouped per series with units, latest value, period-over-period and window change, min/max/mean. Use eia_browse first when unsure of a route's facets. For daily WTI/Brent/Henry Hub spot, fred_get_series (DCOILWTICO, DCOILBRENTEU, DHHNGSP) is keyless — use eia_series for EIA-only data: inventories, storage, production, refinery runs, retail electricity prices, STEO forecasts.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string", description: "EIA v2 route without /data, e.g. 'petroleum/pri/spt', 'natural-gas/stor/wkly', 'electricity/retail-sales'" },
        frequency: { type: "string", description: "e.g. daily | weekly | monthly | quarterly | annual (must be one the dataset lists)" },
        facets: { type: "object", description: "facet filters, e.g. {\"series\":[\"RWTC\",\"RBRTE\"]} or {\"stateid\":[\"IL\"],\"sectorid\":[\"RES\"]}", additionalProperties: { type: ["string", "array"] } },
        data: { type: "array", items: { type: "string" }, description: "data column ids (default ['value']); e.g. ['price','sales'] for electricity/retail-sales" },
        start: { type: "string", description: "start period in the dataset's date format (YYYY, YYYY-MM, YYYY-MM-DD)" },
        end: { type: "string" },
        length: { type: "number", default: 24, maximum: 60, description: "rows to return (newest first)" },
        offset: { type: "number", default: 0, description: "pagination offset into the sorted result" },
        sort: { type: "string", enum: ["desc", "asc"], default: "desc" },
        groupBy: { type: "string", description: "facet id to group rows into series when several facets are present (default: all facet ids)" },
      },
      required: ["route"],
    },
    handler: eiaSeries,
  },
  {
    name: "eia_browse",
    description:
      "Browse the EIA Open Data API v2 catalog to discover routes, frequencies, facets and facet values before calling eia_series (KEYED: EIA_API_KEY). With no route it lists top-level categories (petroleum, natural-gas, electricity, coal, total-energy, steo, nuclear-outages, international, aeo...); with a parent route it lists child routes; with a dataset route it returns the frequencies, facet ids, data columns and date range; with `facet` it lists that facet's allowed values (e.g. route 'petroleum/pri/spt', facet 'series' → RWTC = Cushing WTI spot, RBRTE = Brent). `search` filters any listing by keywords. Use this to resolve a human request ('Illinois residential electricity price', 'Henry Hub futures', 'Lower-48 gas storage') into an eia_series call.",
    inputSchema: {
      type: "object",
      properties: {
        route: { type: "string", description: "route to inspect (omit for root)" },
        facet: { type: "string", description: "facet id whose values to list (requires a dataset route)" },
        search: { type: "string", description: "keyword filter (all words must match)" },
        limit: { type: "number", default: 40, maximum: 200 },
      },
    },
    handler: eiaBrowse,
  },
  {
    name: "cftc_cot",
    description:
      "CFTC Commitments of Traders positioning for one futures market (keyless; CFTC Public Reporting Socrata API; weekly, positions as of Tuesday released Friday 3:30pm ET). `market` is a keyword or alias ('GOLD', 'WTI'/'crude', 'NAT GAS', 'E-MINI S&P 500'/'spx', 'nasdaq', '10-year'/'UST 10Y NOTE', '2-year', 'bond', 'euro', 'yen', 'dollar index', 'bitcoin', 'copper', 'corn'), resolved to the exact or highest-open-interest active contract (or pass `code`, the cftc_contract_market_code). `report`: legacy (Commercial vs Non-Commercial, default; any market), disaggregated (Producer/Merchant, Swap Dealer, Managed Money, Other — physical commodities), tff (Dealer, Asset Manager, Leveraged Funds, Other — financial futures: equity indices, rates, FX). Returns the latest week's long/short/net per trader class, net as % of open interest, week-over-week change, each class's net percentile and range over `lookbackWeeks` (default 52), a speculative gauge (Non-Commercial / Managed Money / Leveraged Funds net with percentile, z-score and crowded-long/short reading), open interest, and `weeks` (default 12, ≤104) of weekly net history in CONTRACTS. Use for 'how crowded is gold/oil/S&P positioning', 'are specs net short treasuries', hedge-fund sentiment and contrarian extremes. cftc_cot_markets lists contract names/codes.",
    inputSchema: {
      type: "object",
      properties: {
        market: { type: "string", description: "keyword/alias, e.g. 'GOLD', 'WTI', 'E-MINI S&P 500', 'UST 10Y NOTE', 'EURO FX', 'NAT GAS'" },
        code: { type: "string", description: "exact cftc_contract_market_code (e.g. 088691 GOLD, 13874A E-MINI S&P 500, 043602 UST 10Y NOTE, 067651 WTI-PHYSICAL)" },
        report: { type: "string", enum: ["legacy", "disaggregated", "tff"], default: "legacy" },
        combined: { type: "boolean", default: false, description: "true = futures + options combined; default futures only" },
        weeks: { type: "number", default: 12, maximum: 104, description: "weekly history rows to return" },
        lookbackWeeks: { type: "number", default: 52, maximum: 260, description: "window for percentile / z-score / range" },
      },
    },
    handler: cftcCot,
  },
  {
    name: "cftc_cot_markets",
    description:
      "Search CFTC Commitments of Traders contract market names (keyless, Socrata) to find the exact contract and cftc_contract_market_code for cftc_cot. Keyword words must all appear in the 'market and exchange' name (e.g. 'GOLD', 'S&P', 'UST', 'NAT GAS', 'CRUDE', 'EURO', 'SOFR', 'BITCOIN'); results are markets reported in the last 120 days, sorted by peak open interest, with commodity group/subgroup and latest report date. `report` picks the universe: legacy (all markets), disaggregated (physical commodities), tff (financial futures). CFTC naming is terse — 'UST 10Y NOTE' not '10-year', 'WTI-PHYSICAL' = NYMEX crude, 'NAT GAS NYME' = Henry Hub, 'COPPER- #1'.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "keyword(s), e.g. 'GOLD', 'S&P 500', 'UST'" },
        report: { type: "string", enum: ["legacy", "disaggregated", "tff"], default: "legacy" },
        combined: { type: "boolean", default: false },
        limit: { type: "number", default: 25, maximum: 60 },
      },
      required: ["search"],
    },
    handler: cftcCotMarkets,
  },
  {
    name: "baker_hughes_rig_count",
    description:
      "Baker Hughes North America rotary rig count (keyless; weekly workbook from rigcount.bakerhughes.com, posted Fridays ~noon CT). Returns the latest week's U.S. and Canada active rigs split oil / gas / misc, with 1-week, 4-week and 52-week changes, one-year range of the total, oil share, and the last `weeks` (default 12, ≤104) of weekly rows. Units are rig counts (operator-declared oil vs gas). Use for drilling-activity, shale-supply-response and energy-capex context ('are US oil rigs rising with WTI at $X?'). Note: the parser was built from Baker Hughes' documented layout and flags `unverified` until a live run confirms it (the publisher's CDN blocks some server networks; set BAKER_HUGHES_RIG_XLSX_URL to override the download). EIA's monthly rig series is available via eia_series route 'petroleum/crd/drill' (keyed).",
    inputSchema: {
      type: "object",
      properties: {
        weeks: { type: "number", default: 12, maximum: 104, description: "weekly rows to return" },
        region: { type: "string", enum: ["both", "us", "canada"], default: "both" },
      },
    },
    handler: bakerHughesRigCount,
  },
];

export const ENERGY_DOMAIN: CatalogDomain = {
  id: "energy",
  label: "Energy & Commodities (EIA · CFTC COT · Baker Hughes)",
  source:
    "EIA Open Data API v2 (api.eia.gov, EIA_API_KEY), CFTC Commitments of Traders via publicreporting.cftc.gov Socrata (keyless; legacy/disaggregated/TFF, futures-only and combined), Baker Hughes North America rig count workbook (rigcount.bakerhughes.com, keyless xlsx) — live, cached in-memory 30 min–24 h",
  tools: [
    { name: "eia_series", backing: "live-api", probe: "unprobed", note: "keyed (EIA_API_KEY); fails fast when unset; length ≤ 60 per call, cached 30 min" },
    { name: "eia_browse", backing: "live-api", probe: "unprobed", note: "keyed (EIA_API_KEY); route/facet metadata cached 24h" },
    { name: "cftc_cot", backing: "live-api", probe: "unprobed", note: "Socrata SoQL, keyless; weekly Fri release; cached 6h" },
    { name: "cftc_cot_markets", backing: "live-api", probe: "unprobed", note: "Socrata group-by over last 120 days; cached 6h" },
    { name: "baker_hughes_rig_count", backing: "live-api", probe: "unprobed", note: "~7 MB xlsx via in-repo reader; publisher CDN 403s some networks — layout sniffed, unverified from sandbox" },
  ],
};

export const ENERGY_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "energy: CFTC COT gold (legacy)", tool: "cftc_cot", args: { market: "GOLD", weeks: 2 }, note: "Socrata, keyless; expect COMEX GOLD 088691, Non-Commercial net long, asOf = latest Tuesday" },
  { name: "energy: CFTC COT market search", tool: "cftc_cot_markets", args: { search: "UST", report: "tff", limit: 5 }, note: "expect UST 2Y/5Y/10Y NOTE, UST BOND, ULTRA rows" },
  { name: "energy: EIA key presence", tool: "eia_browse", args: { route: "petroleum/pri/spt" }, note: "keyed — without EIA_API_KEY this fails fast with 'EIA_API_KEY not configured'; with a key expect frequencies daily/weekly/monthly/annual and facets series/duoarea/product/process" },
];
