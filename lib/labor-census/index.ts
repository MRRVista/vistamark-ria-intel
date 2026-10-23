/**
 * Labor & Demographics family — BLS (timeseries + QCEW) and Census (ACS, CBP,
 * Geocoder) for Hinsdale / DuPage / Cook prospect-territory context.
 *
 *   bls_series           — any BLS timeseries (CPI, unemployment, payrolls, JOLTS, ECI, LAUS county rates…) by id or alias
 *   bls_popular          — the alias map + BLS's live "popular series" list + id patterns
 *   bls_qcew_county      — QCEW county employment / establishments / weekly wage by ownership × NAICS, with YoY
 *   census_acs_profile   — curated ACS 5-yr wealth profile for a ZCTA / county / place (+ state & US comparison)
 *   census_acs_variable  — any ACS variable(s) by code with label lookup, optional all-counties/places/ZCTAs wildcard
 *   census_cbp           — County Business Patterns establishments / employees / payroll by NAICS (county, zip, state, msa)
 *   census_geocode       — address or lat/lon → county FIPS, tract, block, ZCTA, place, CD, school districts
 *
 * Keys: BLS_API_KEY optional (raises BLS quota); CENSUS_API_KEY REQUIRED for the
 * three Census data tools (api.census.gov rejects keyless requests as of 2026).
 * See README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { blsSeries, blsPopular } from "./bls";
import { blsQcewCounty } from "./qcew";
import { censusAcsProfile, censusAcsVariable, censusCbp, censusGeocode } from "./census";

const geoProps = {
  zcta: { type: "string", description: "5-digit ZIP Code Tabulation Area, e.g. '60521' (Hinsdale). Default geography when nothing else is given." },
  county: { type: "string", description: "5-digit county FIPS: '17043' DuPage, '17031' Cook, '17097' Lake, '17111' McHenry, '17089' Kane, '17197' Will" },
  place: { type: "string", description: "Census place code with state (state:'IL', place:'35307' Hinsdale village) or 7-digit GEOID '1735307'; get it from census_geocode" },
  state: { type: "string", description: "2-letter postal or 2-digit FIPS ('IL' / '17'); alone = statewide" },
  msa: { type: "string", description: "CBSA code, e.g. '16980' Chicago-Naperville-Elgin" },
  tract: { type: "string", description: "6-digit tract code (with county) or 11-digit tract GEOID from census_geocode" },
  year: { type: "number", description: "ACS vintage (end year of the 5-year window). Default = newest published (2024 as of Oct 2026)." },
};

export const LABORCENSUS_TOOLS: ToolDef[] = [
  {
    name: "bls_series",
    description:
      "Latest readings for up to 10 BLS time series (Bureau of Labor Statistics Public Data API; keyless 25 queries/day per IP, BLS_API_KEY optional for 500/day). Pass BLS series ids (e.g. 'LNS14000000', 'CUUR0000SA0', 'LAUCN170430000000003') or built-in alias names: unemployment, unemployment_u6, participation, payrolls, private_payrolls, financial_activities_payrolls, ahe, awe, avg_weekly_hours, cpi, cpi_sa, core_cpi, core_cpi_sa, cpi_energy, cpi_rent, cpi_chicago, ppi_final_demand, import_prices, jolts_openings, jolts_quits_rate, jolts_hires_rate, eci, eci_wages, productivity, unit_labor_costs, il_unemployment, chicago_msa_unemployment, dupage_unemployment, cook_unemployment (call bls_popular for the full map and id patterns). Returns per series: latest period and value (preliminary flag), change vs prior period and vs the same period a year earlier (diff and %), and the most recent N periods (default 13). Index series (CPI/PPI) need changeVsYearAgo.pct for the inflation rate; rate series use diff in points. Monthly data lag ~2–6 weeks; LAUS county rates ~6 weeks. Use for 'what is DuPage unemployment?', 'Chicago CPI YoY?', 'wage growth vs inflation' and client-letter macro context; use fred_get_series for FRED-only series and long histories (BLS caps at 10 years keyless).",
    inputSchema: {
      type: "object",
      properties: {
        series: { type: "array", items: { type: "string" }, description: "1–10 BLS series ids or alias names" },
        recent: { type: "number", default: 13, maximum: 60, description: "recent periods to return per series" },
        years: { type: "number", default: 3, maximum: 10, description: "years of history to request (ending endYear)" },
        startYear: { type: "number" },
        endYear: { type: "number" },
      },
      required: ["series"],
    },
    handler: blsSeries,
  },
  {
    name: "bls_popular",
    description:
      "Reference list for bls_series: the ~30 built-in alias names with their BLS series ids, titles and units (national CPI/core CPI/Chicago CPI, unemployment & U-6, participation, payrolls, average hourly/weekly earnings, JOLTS openings/quits/hires, PPI, import prices, ECI, productivity, unit labor costs, Illinois / Chicago MSA / DuPage / Cook unemployment), plus BLS's live 'popular series' endpoint (optionally filtered by survey code such as LA, CU, CE, JT) and the id-construction patterns for LAUS county/MSA, CPI area and CES industry series. Keyless; cached 24h. Call once when you need a series id you don't know, then call bls_series.",
    inputSchema: {
      type: "object",
      properties: {
        survey: { type: "string", description: "optional BLS survey code to filter the live popular list (LA, CU, CE, JT, PR, CI, WP, EI)" },
      },
    },
    handler: blsPopular,
  },
  {
    name: "bls_qcew_county",
    description:
      "BLS Quarterly Census of Employment and Wages (QCEW) slice for a county, state or the US — establishments, employment, total wages and average weekly wage by ownership (private default; 'all' for federal/state/local/total) and NAICS industry level, each row with BLS's published over-the-year % changes and the employment location quotient vs the US. Keyless open-data CSV (data.bls.gov/cew), covering ~95% of jobs via UI records; a quarter publishes ~5 months after it ends (newest found automatically; 2026 Q1 and 2024 annual available Oct 2026). area: county FIPS ('17043' DuPage default, '17031' Cook), state ('17' → 17000), 'US000', MSA 'C1698'. Filter with naics (['52','523','5239','523940','5411','5412'] — NAICS 2022 codes: 5239 'other financial investment activities' = RIAs and family offices, 523940 investment advice (was 523930 under NAICS 2017), 523 securities/investments, 52 finance & insurance, 5412 accounting, 5411 legal) or level (2–6 digit NAICS breadth); default returns total + 2-digit sectors sorted by employment. Use for sizing a local wealth-management market (how many RIA establishments and what do they pay in DuPage vs Cook?), wage trends, and local economic context; use census_cbp for ZIP-level establishment counts and bls_series for unemployment rates.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", default: "17043", description: "county FIPS (5 digits), state FIPS (2 digits), 'US000', or MSA code 'C1698'" },
        naics: { type: "array", items: { type: "string" }, description: "exact NAICS codes to return (any level), e.g. ['52','523','5239']" },
        level: { type: "number", description: "return every industry at this NAICS digit level (2–6) instead of naics" },
        ownership: { type: "string", default: "5", description: "'5' private (default), '0' total all ownerships, '1' federal, '2' state, '3' local, or 'all'" },
        period: { type: "string", enum: ["quarterly", "annual"], default: "quarterly" },
        year: { type: "number", description: "specific year (default newest published)" },
        quarter: { type: "number", description: "1–4 with year (default 4)" },
        sortBy: { type: "string", enum: ["employment", "establishments", "avgWeeklyWageUSD"], default: "employment" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: blsQcewCounty,
  },
  {
    name: "census_acs_profile",
    description:
      "Wealth-prospecting demographic profile for a ZIP/ZCTA (default 60521 Hinsdale), county (17043 DuPage, 17031 Cook), place, tract, MSA or state from the Census ACS 5-year Data Profile (DP02–DP05; newest vintage auto-detected, 2020–2024 as of Oct 2026, refreshed each December). Returns ~35 curated indicators: population, households, median age, % 65+, married-couple share; median/mean household income, median family and per-capita income, % households earning $200K+ and $150–200K, % with retirement income and its mean, % with Social Security, poverty; bachelor's+ and graduate-degree shares, labor-force participation, unemployment, % in management/professional and finance/real-estate occupations, self-employment; housing units, owner-occupancy, median home value, % homes $1M+ and $500K–1M, mortgage share, owner costs, rent, vacancy; foreign-born and veteran shares. By default also returns the same indicators for the state and the US for comparison (compare:false to skip); sections limits to people / income / education_work / housing. Requires CENSUS_API_KEY (free, instant). Dollars are inflation-adjusted to the vintage year; ZCTA margins of error are wide. Use to qualify a territory ('how affluent is 60523 vs 60521?', 'share of $200K+ households in DuPage') before outreach; use census_acs_variable for any other ACS table or MOEs; use local-wealth tools for parcel-level data.",
    inputSchema: {
      type: "object",
      properties: {
        ...geoProps,
        sections: { type: "array", items: { type: "string", enum: ["people", "income", "education_work", "housing"] }, description: "subset of indicator groups (default all)" },
        compare: { type: "boolean", default: true, description: "include state and US rows" },
      },
    },
    handler: censusAcsProfile,
  },
  {
    name: "census_acs_variable",
    description:
      "Fetch any Census ACS 5-year variable(s) by code for a geography, with the official label of each variable looked up from variables.json. Up to 40 codes: detailed tables (B19013_001E median household income, B25077_001E median home value, B19083_001E Gini, B19001_017E households $200K+, B01003_001E population; add M suffix for the margin of error), Data Profile (DP03_0062E), Subject (S1901_C01_012E) or Comparison Profile (CP03) codes — the dataset is inferred from the prefix or set with dataset ('acs/acs5', 'acs/acs5/profile', 'acs/acs5/subject', 'acs/acs5/cprofile'; 'acs/acs1' for 1-year estimates on 65K+ geographies). Geography: zcta, county, place, tract, msa, state, or all:true to return EVERY unit of that level inside the parent (all counties in IL with state:'IL' county:'*'-style; all ZCTAs nationally is large — use limit/sortBy) for ranking, e.g. rank Illinois counties by B19013_001E. Newest vintage auto-detected (2024). Requires CENSUS_API_KEY. Use when census_acs_profile lacks the measure (Gini, income brackets, age-by-income, commute, language, detailed housing) or for cross-geography rankings.",
    inputSchema: {
      type: "object",
      properties: {
        variables: { type: "array", items: { type: "string" }, description: "ACS variable codes, e.g. ['B19013_001E','B19013_001M']" },
        dataset: { type: "string", description: "override dataset path, e.g. 'acs/acs1'" },
        ...geoProps,
        all: { type: "boolean", default: false, description: "wildcard the lowest geography level given (e.g. every county in the state, every place in the state, every tract in the county)" },
        sortBy: { type: "string", description: "variable code to sort descending when all:true" },
        limit: { type: "number", default: 25, maximum: 200 },
      },
      required: ["variables"],
    },
    handler: censusAcsVariable,
  },
  {
    name: "census_cbp",
    description:
      "Census County Business Patterns (CBP): number of establishments, March employees and annual payroll by NAICS industry for a county (17043 DuPage, 17031 Cook), 5-digit ZIP (zip:'60521' — the only ZIP-level business census, available 2019+), state or MSA. Newest vintage auto-detected (2023 as of Oct 2026; CBP publishes ~18 months after the reference year). Default returns the total plus every 2-digit sector; pass naics codes at any depth (['52','523','5239','523930','5412','5411','6211'] — NAICS 2017 codes: 523930 investment advice (note QCEW uses NAICS 2022 = 523940), 5239 other financial investment activities, 5412 accounting, 5411 legal, 6211 physicians) for exact counts; includes avg pay per employee. Requires CENSUS_API_KEY (free). Counts only establishments with paid employees (sole-proprietor RIAs are excluded; see census_acs_profile self-employment share). Use to size the professional/business community in a ZIP (how many law, CPA and investment-advice offices in 60521 / 60523 / 60515?), to benchmark DuPage vs Cook, and as a cross-check to bls_qcew_county (which has wages and quarterly freshness but no ZIP level).",
    inputSchema: {
      type: "object",
      properties: {
        zip: { type: "string", description: "5-digit ZIP code (ZIP-level CBP, 2019+)" },
        county: geoProps.county,
        state: geoProps.state,
        msa: geoProps.msa,
        naics: { type: "array", items: { type: "string" }, description: "NAICS codes (2–6 digit); omit for total + 2-digit sectors" },
        year: { type: "number", description: "CBP reference year (default newest)" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: censusCbp,
  },
  {
    name: "census_geocode",
    description:
      "Census Bureau Geocoder (keyless, live): turn a one-line US street address (or lat/lon) into coordinates plus every Census geography it falls in — state and county FIPS, census tract, block group, 2020 block, ZCTA, incorporated place (e.g. Hinsdale village 1735307), township/county subdivision, MSA/CSA, congressional district, state senate/house districts, and school districts. Returns a nextSteps hint with the exact county/ZCTA args for census_acs_profile, census_cbp and bls_qcew_county. Use before any Census call when you only have a prospect's or firm's address (Form ADV office address, 990 address, property address) and need the county FIPS or tract, to check which district an address sits in, or to confirm a Hinsdale address is in DuPage (60521 straddles DuPage and Cook). Address-range matching: include city/state or ZIP; PO boxes and new construction may not match.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "one-line address, e.g. '15 Salt Creek Ln, Hinsdale, IL 60521'" },
        lat: { type: "number" },
        lon: { type: "number" },
      },
    },
    handler: censusGeocode,
  },
];

export const LABORCENSUS_DOMAIN: CatalogDomain = {
  id: "laborcensus",
  label: "Labor & Demographics (BLS · Census ACS/CBP · QCEW)",
  source:
    "BLS Public Data API v2/v1 (timeseries; keyless 25/day, BLS_API_KEY optional), BLS QCEW open-data CSVs (keyless), Census Data API — ACS 5-year profile/detailed tables and County Business Patterns (CENSUS_API_KEY required), Census Geocoder (keyless). In-memory cache 1h (BLS) to 7d (ACS/CBP/titles).",
  tools: [
    { name: "bls_series", backing: "live-api", probe: "unprobed", note: "v2 keyless → v1 fallback when the shared-IP quota trips; 10-yr cap keyless" },
    { name: "bls_popular", backing: "live-api", probe: "unprobed", note: "alias map is static; popular endpoint live, cached 24h" },
    { name: "bls_qcew_county", backing: "live-api", probe: "unprobed", note: "~350 KB county CSV per period, cached 24h; newest quarter auto-probed" },
    { name: "census_acs_profile", backing: "live-api", probe: "unprobed", note: "CENSUS_API_KEY required (keyless requests redirect to missing_key.html)" },
    { name: "census_acs_variable", backing: "live-api", probe: "unprobed", note: "CENSUS_API_KEY required; label lookup keyless" },
    { name: "census_cbp", backing: "live-api", probe: "unprobed", note: "CENSUS_API_KEY required; ZIP level 2019+" },
    { name: "census_geocode", backing: "live-api", probe: "unprobed", note: "keyless; layers=all for ZCTA/MSA/school districts" },
  ],
};

export const LABORCENSUS_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "laborcensus: BLS unemployment + Chicago CPI", tool: "bls_series", args: { series: ["unemployment", "cpi_chicago"], recent: 2, years: 2 }, note: "v2 keyless; falls back to v1 on the shared-IP daily quota; expect latest month ~1 month back" },
  { name: "laborcensus: QCEW DuPage finance", tool: "bls_qcew_county", args: { area: "17043", naics: ["52", "5239"], limit: 4 }, note: "350 KB CSV; expect ~2,000 private finance establishments, ~480 in 5239" },
  { name: "laborcensus: geocode Hinsdale", tool: "census_geocode", args: { address: "15 Salt Creek Ln, Hinsdale, IL 60521" }, note: "keyless; expect county 17043, ZCTA 60521, place 1735307" },
  { name: "laborcensus: ACS profile 60521", tool: "census_acs_profile", args: { zcta: "60521", sections: ["income"], compare: false }, note: "fails fast with 'CENSUS_API_KEY not configured' when unset" },
];
