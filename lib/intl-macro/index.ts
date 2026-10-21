/**
 * International Macro family — IMF, OECD, BIS, World Bank. All live, keyless.
 *
 *   worldbank_indicator         — WB Indicators API v2, annual values by country
 *   worldbank_indicator_search  — WB indicator catalog keyword search
 *   imf_weo                     — IMF DataMapper (WEO/Fiscal Monitor/Global Debt), annual incl. projections
 *   imf_indicator_list          — IMF DataMapper indicator catalog
 *   imf_sdmx_series             — IMF SDMX 3.0 (api.imf.org) monthly CPI / FX (IFS successor)
 *   oecd_series                 — OECD SDMX presets (CLI, BCI/CCI, rates, unemployment, CPI) + raw
 *   bis_series                  — BIS SDMX presets (policy rates, credit gaps, property prices, EERs) + raw
 *
 * Endpoint notes live at the top of each module. See README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { worldbankIndicator, worldbankIndicatorSearch } from "./worldbank";
import { imfWeo, imfIndicatorList, imfSdmxSeries, IMF_SDMX_PRESET_NAMES } from "./imf";
import { oecdSeries, OECD_PRESET_NAMES } from "./oecd";
import { bisSeries, BIS_PRESET_NAMES } from "./bis";

const countriesSchema = {
  type: "array",
  items: { type: "string" },
  description: "ISO2 or ISO3 country codes (converted per upstream); 'EA'/'EUROAREA' maps to each source's euro-area code. Aggregates pass through (WB: WLD, OED, HIC; IMF: WEOWORLD, ADVEC, OEMDC; OECD: OECD, G7, G20, EA20).",
};

export const INTLMACRO_TOOLS: ToolDef[] = [
  {
    name: "worldbank_indicator",
    description: "World Bank Indicators API (live, no key): annual values of any WB indicator (World Development Indicators and other WB databases) for one or more countries/aggregates. Returns per country the latest non-null year and recent values (newest first), indicator name, and WB lastUpdated date. Common codes: NY.GDP.MKTP.KD.ZG real GDP growth %, NY.GDP.PCAP.CD GDP per capita US$, FP.CPI.TOTL.ZG CPI inflation %, SL.UEM.TOTL.ZS unemployment %, GC.DOD.TOTL.GD.ZS central govt debt % GDP, BN.CAB.XOKA.GD.ZS current account % GDP, NE.TRD.GNFS.ZS trade % GDP, SP.POP.TOTL population, FR.INR.RINR real interest rate. Aggregates: WLD, EMU (euro area), EUU, OED (OECD members), HIC, LMY. Data lag 1-2 years and there are NO forecasts — for current-year estimates and projections use imf_weo; for monthly data use oecd_series/bis_series/imf_sdmx_series. Find codes with worldbank_indicator_search.",
    inputSchema: {
      type: "object",
      properties: {
        indicator: { type: "string", description: "WB indicator code, e.g. NY.GDP.MKTP.KD.ZG" },
        countries: countriesSchema,
        startYear: { type: "number" },
        endYear: { type: "number" },
        recent: { type: "number", default: 10, maximum: 60, description: "values per country to return" },
      },
      required: ["indicator"],
    },
    handler: worldbankIndicator,
  },
  {
    name: "worldbank_indicator_search",
    description: "Keyword search of the World Bank indicator catalog (cached 24h). By default searches the ~1.5k World Development Indicators; allSources:true searches all ~29k indicators across WB databases (International Debt Statistics, Gender, Doing Business, etc.). All query words must appear in the id, name or description; name matches rank first. Returns id, name, source, topics and a short description. Feed an id to worldbank_indicator.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        allSources: { type: "boolean", default: false },
        limit: { type: "number", default: 15, maximum: 50 },
      },
      required: ["query"],
    },
    handler: worldbankIndicatorSearch,
  },
  {
    name: "imf_weo",
    description: "IMF World Economic Outlook-style annual data INCLUDING IMF projections (IMF DataMapper API, live, no key; current vintage shown in dataSource, e.g. 'World Economic Outlook (October 2026)'). Pass an indicator and countries (ISO3 or groups WEOWORLD, ADVEC, OEMDC, EURO, EU). Returns per country the latest actual year and the values in the window (default current year −5 to +5), each flagged projection:true for forward years. Key WEO codes: NGDP_RPCH real GDP growth %, PCPIPCH avg CPI inflation %, PCPIEPCH end-period inflation, LUR unemployment %, GGXWDG_NGDP general govt gross debt % GDP, GGXCNL_NGDP fiscal balance % GDP, BCA_NGDPD current account % GDP, NGDPD nominal GDP US$bn, NGDPDPC GDP per capita US$, PPPSH share of world GDP (PPP). Also Fiscal Monitor (GGCBP_G01_PGDP_PT cyclically-adjusted primary balance) and Global Debt Database (HH_ALL household debt, NFC_ALL corporate debt, % GDP). Use imf_indicator_list for the catalog. Best tool for cross-country growth/inflation/debt forecasts; for monthly prints use imf_sdmx_series / oecd_series.",
    inputSchema: {
      type: "object",
      properties: {
        indicator: { type: "string", description: "e.g. NGDP_RPCH, PCPIPCH, GGXWDG_NGDP" },
        countries: countriesSchema,
        startYear: { type: "number" },
        endYear: { type: "number" },
      },
      required: ["indicator"],
    },
    handler: imfWeo,
  },
  {
    name: "imf_indicator_list",
    description: "List IMF DataMapper indicators (id, label, unit, dataset, source vintage). Default view shows the macro datasets — WEO (World Economic Outlook), FM (Fiscal Monitor), GDD (Global Debt Database), DEBT. Filter by keyword query (all words must match) or dataset (WEO, FM, GDD, AFRREO, CF, CL, SPRLU, FPP, AIPI, ...). Feed an id to imf_weo.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        dataset: { type: "string" },
        limit: { type: "number", default: 60, maximum: 200 },
      },
    },
    handler: imfIndicatorList,
  },
  {
    name: "imf_sdmx_series",
    description: `Monthly IMF statistics from the IMF SDMX 3.0 API (api.imf.org, live, keyless — successor to International Financial Statistics). Presets: ${IMF_SDMX_PRESET_NAMES.join(", ")} — cpi_yoy (headline CPI % y/y), cpi_index (CPI level), fx_usd (domestic currency per USD, period average), fx_usd_eop (end of period). Pass preset + countries (ISO3; broad EM coverage that OECD lacks, e.g. NGA, EGY, PAK, VNM). Raw mode: flow 'IMF.STA/CPI/+' (agency/id/version, '+' = latest) and key in that flow's dimension order (CPI: COUNTRY.INDEX_TYPE.COICOP_1999.TYPE_OF_TRANSFORMATION.FREQUENCY, e.g. 'G163.HICP._T.YOY_PCH_PA_PT.M' for euro-area HICP; ER: COUNTRY.INDICATOR.TYPE_OF_TRANSFORMATION.FREQUENCY). Returns the last N observations per series (periods like 2026-M09). For OECD economies, oecd_series is usually fresher; for annual forecasts use imf_weo.`,
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: IMF_SDMX_PRESET_NAMES },
        countries: countriesSchema,
        flow: { type: "string" },
        key: { type: "string" },
        recent: { type: "number", default: 6, maximum: 60 },
      },
    },
    handler: imfSdmxSeries,
  },
  {
    name: "oecd_series",
    description: `OECD monthly macro data from the OECD Data Explorer SDMX API (sdmx.oecd.org, live, no key). Presets (pass preset + countries, ISO3 or aggregates OECD, G7, G20, EA20): ${OECD_PRESET_NAMES.join(", ")}. cli = Composite Leading Indicator (amplitude-adjusted, 100 = trend; above 100 and rising = growth above trend ahead, turning points lead the business cycle ~6-9 months; covers G20 + major aggregates); bci/cci = harmonised business/consumer confidence; short_rate = 3-month interbank rate; long_rate = 10-year govt bond yield; unemployment = harmonised SA rate; cpi / core_cpi = % y/y (core = ex food & energy). Returns the last N observations per series (default 6, newest first) with units and labels. Raw mode: dataflow 'AGENCY,DSD@DF_ID,VERSION' (e.g. 'OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA,') and key (dimension values joined by '.', empty = wildcard, '+' = OR) plus optional startPeriod. OECD throttles bursts; results are cached 6h. Prefer for cross-country monthly comparisons of developed economies; for central bank policy rates use bis_series.`,
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: OECD_PRESET_NAMES },
        countries: countriesSchema,
        dataflow: { type: "string" },
        key: { type: "string" },
        startPeriod: { type: "string", description: "e.g. 2024-01" },
        recent: { type: "number", default: 6, maximum: 120 },
        maxSeries: { type: "number", default: 30, maximum: 100 },
      },
    },
    handler: oecdSeries,
  },
  {
    name: "bis_series",
    description: `Bank for International Settlements statistics (BIS SDMX API v1, stats.bis.org, live, no key). Presets (pass preset + countries, ISO2 or ISO3, euro area = EA/XM): ${BIS_PRESET_NAMES.join(", ")}. policy_rate = central bank policy rates for ~40 central banks, end of month (policy_rate_daily for daily); credit_gap = Basel III credit-to-GDP gap, private non-financial sector, pp of GDP (>2pp CCyB activation guide, >10pp historically precedes banking crises); credit_to_gdp = ratio + HP trend + gap; property_prices_real / _nominal = residential property price index (2010=100) and y/y %; reer / neer = real / nominal effective exchange rate, broad basket, 2020=100 (up = appreciation). Returns the last N observations per series (default 6, newest first) with units. Raw mode: flow (e.g. 'WS_CBPOL', 'WS_LONG_CPI', 'WS_TC', 'WS_DSR', 'WS_XRU') and key (dimension values joined by '.', '+' = OR, empty = wildcard). Best source for a cross-country policy-rate table and financial-cycle/housing risk indicators.`,
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: BIS_PRESET_NAMES },
        countries: countriesSchema,
        flow: { type: "string" },
        key: { type: "string" },
        startPeriod: { type: "string" },
        recent: { type: "number", default: 6, maximum: 120 },
        maxSeries: { type: "number", default: 30, maximum: 100 },
      },
    },
    handler: bisSeries,
  },
];

export const INTLMACRO_DOMAIN: CatalogDomain = {
  id: "intlmacro",
  label: "International Macro (IMF · OECD · BIS · World Bank)",
  source: "World Bank Indicators API, IMF DataMapper + SDMX 3.0, OECD Data Explorer SDMX, BIS Data Portal SDMX (all live, keyless)",
  tools: [
    { name: "worldbank_indicator", backing: "live-api", probe: "unprobed" },
    { name: "worldbank_indicator_search", backing: "live-api", probe: "unprobed", note: "catalog cached 24h" },
    { name: "imf_weo", backing: "live-api", probe: "unprobed", note: "includes IMF projections" },
    { name: "imf_indicator_list", backing: "live-api", probe: "unprobed" },
    { name: "imf_sdmx_series", backing: "live-api", probe: "unprobed", note: "monthly CPI / FX" },
    { name: "oecd_series", backing: "live-api", probe: "unprobed", note: "presets: CLI, rates, unemployment, CPI" },
    { name: "bis_series", backing: "live-api", probe: "unprobed", note: "presets: policy rates, credit gap, property prices, EER" },
  ],
};

export const INTLMACRO_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "intlmacro: IMF WEO US growth", tool: "imf_weo", args: { indicator: "NGDP_RPCH", countries: ["USA"] } },
  { name: "intlmacro: BIS policy rates", tool: "bis_series", args: { preset: "policy_rate", countries: ["US", "GB"], recent: 2 } },
  { name: "intlmacro: World Bank GDP growth", tool: "worldbank_indicator", args: { indicator: "NY.GDP.MKTP.KD.ZG", countries: ["US"], recent: 2 } },
];
