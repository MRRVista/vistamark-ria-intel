/**
 * Research Datasets family — free academic / practitioner datasets a CIO uses
 * for factor attribution, valuation and volatility context. All live, keyless.
 *
 *   kfrench_factors     — Fama-French 3/5-factor + momentum (US + regions), any frequency, window stats
 *   kfrench_dataset     — any Ken French library file (industries, size/value sorts), multi-section aware
 *   aqr_factors         — AQR QMJ, BAB, HML Devil, Value & Momentum Everywhere, TSMOM, Century of Factor Premia
 *   damodaran_erp       — Damodaran implied equity risk premium (annual since 1960 + monthly since 2008)
 *   damodaran_industry  — Damodaran industry WACC, betas, PE, EV/EBITDA, margins, etc. (US + regions)
 *   shiller_cape        — Shiller CAPE / TR CAPE / Excess CAPE Yield with historical percentile
 *   cboe_vol_history    — VIX family (VIX9D/VIX/VIX3M/VIX6M term structure, VVIX, SKEW)
 *
 * Endpoint and format notes live at the top of each module; see README.md.
 * Legacy .xls sources (Shiller, Damodaran industries) are decoded by ./xls.ts,
 * a dependency-free BIFF8 reader.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { kfrenchFactors, kfrenchDataset } from "./kfrench";
import { aqrFactors } from "./aqr";
import { damodaranErp, damodaranIndustry } from "./damodaran";
import { shillerCape } from "./shiller";
import { cboeVolHistory } from "./cboe";

const windowProps = {
  years: { type: "number", description: "Window = last N years of available data (default 10). Ignored when start/end given unless also set." },
  start: { type: "string", description: "Window start: YYYY, YYYY-MM, YYYYMM or YYYY-MM-DD" },
  end: { type: "string", description: "Window end (same formats)" },
};

export const RESEARCH_TOOLS: ToolDef[] = [
  {
    name: "kfrench_factors",
    description:
      "Fama-French factor returns from the Kenneth R. French Data Library (live, keyless; US data CRSP-based, updated monthly with ~1-month lag). Models: ff3 (Mkt-RF, SMB, HML, RF), ff5 (adds RMW profitability, CMA investment; 2x3 sorts), mom (12-2 momentum), or ff3+mom / ff5+mom merged on date. Frequencies: monthly (default), daily, annual, weekly (US ff3 only). Regions: US (default), Developed, Developed_ex_US, Europe, Japan, Asia_Pacific_ex_Japan, North_America, Emerging (monthly ff5/mom only). Returns latest period, the most recent N rows, and per-factor window stats (cumulative, geometric annualized return, annualized vol, Sharpe, best/worst, % positive) over the last `years` (default 10) or a start/end window, plus total market return (Mkt-RF+RF). Values are PERCENT per period. Use for factor-premia context ('how has value done over 5 years?', 'momentum crash YTD?'); use kfrench_dataset for industry/size/value portfolios; aqr_factors for quality/BAB/TSMOM.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: ["ff3", "ff5", "mom", "ff3+mom", "ff5+mom"], default: "ff3" },
        frequency: { type: "string", enum: ["monthly", "daily", "annual", "weekly"], default: "monthly" },
        region: { type: "string", default: "US", description: "US | Developed | Developed_ex_US | Europe | Japan | Asia_Pacific_ex_Japan | North_America | Emerging" },
        recent: { type: "number", default: 12, maximum: 120, description: "number of most-recent rows to return" },
        ...windowProps,
      },
    },
    handler: kfrenchFactors,
  },
  {
    name: "kfrench_dataset",
    description:
      "Fetch ANY file from the Kenneth R. French Data Library by name (e.g. '10_Industry_Portfolios', '49_Industry_Portfolios_daily', '25_Portfolios_5x5', 'Portfolios_Formed_on_ME', 'F-F_LT_Reversal_Factor', 'Developed_ex_US_5_Factors'), or omit name and pass `search` (keywords, all must match) to list valid dataset names from the live library catalog (~300 files). Library CSVs hold multiple sections — e.g. industry files contain Value-Weighted Monthly, Equal-Weighted Monthly, VW Annual, EW Annual, Number of Firms, Average Firm Size, BE/ME — so the response lists every section (index, name, frequency, rows, date range) and returns the requested one (`section` by index or name words such as 'equal weighted annual'; default first = value-weighted monthly). Returns the most recent N rows and, for return sections, per-column window stats (default last 10 years). Values are PERCENT; missing (-99.99) are null. Use `columns` to pick portfolios (e.g. ['HiTec','Hlth']) when a section is wide (only the first 25 columns shown otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Dataset file name without _CSV.zip; omit to search the catalog" },
        search: { type: "string", description: "catalog keyword search when name is omitted, e.g. 'industry daily'" },
        section: { type: ["string", "number"], description: "section index or name words (e.g. 'equal weighted monthly', 'annual')" },
        columns: { type: "array", items: { type: "string" }, description: "subset of column names (exact, case-insensitive)" },
        recent: { type: "number", default: 12, maximum: 120 },
        stats: { type: "boolean", description: "force window stats on/off (default: on for return sections with ≤12 columns)" },
        ...windowProps,
      },
    },
    handler: kfrenchDataset,
  },
  {
    name: "aqr_factors",
    description:
      "AQR Capital Management public factor datasets (live public .xlsx downloads, no login; refreshed monthly, full history reconstructed each update). dataset: qmj (Quality Minus Junk, by country + Global/Europe/Pacific aggregates, since 1957), bab (Betting Against Beta, since 1930), hml_devil (timely value, since 1926), vme (Value & Momentum Everywhere: VAL/MOM across stocks, equity indices, FX, fixed income, commodities), tsmom (Time-Series Momentum / trend-following: all assets + CM/EQ/FI/FX), century (A Century of Factor Premia: value, momentum, carry, defensive and multi-style by asset class). Returns latest month, recent N monthly returns, window stats (default last 10 years: cumulative, annualized return/vol, Sharpe, worst month) and full-history stats per column. Monthly excess returns shown in PERCENT. Default columns: USA + global aggregates for qmj/bab/hml_devil; headline factors otherwise — pass `columns` for specific countries (ISO3, e.g. 'JPN','GBR') or series; `sheet` reads companion sheets (MKT, SMB, UMD, RF) in qmj/bab/hml_devil. Use for quality/low-beta/trend/carry premia; for Fama-French factors use kfrench_factors.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", enum: ["qmj", "bab", "hml_devil", "vme", "tsmom", "century"], default: "qmj" },
        columns: { type: "array", items: { type: "string" }, description: "column names (exact or substring), e.g. ['USA','Global'] or ['TSMOM^EQ']" },
        sheet: { type: "string", description: "companion sheet name (e.g. 'UMD', 'MKT', 'RF'); default first sheet" },
        recent: { type: "number", default: 12, maximum: 120 },
        ...windowProps,
      },
    },
    handler: aqrFactors,
  },
  {
    name: "damodaran_erp",
    description:
      "Aswath Damodaran's implied equity risk premium (ERP) for the S&P 500 (NYU Stern, live, keyless). Combines (1) the annual history since 1960 (histimpl.xlsx; year-end implied ERP via FCFE and DDM, T-bond and T-bill rates, S&P level, earnings/dividend yields, analyst growth; plus Damodaran's period averages such as 1960–2025 and 2016–2025) with (2) the monthly series since Sep-2008 (ERPbymonth.xlsx; start-of-month implied ERP on trailing-12m cash flows, sustainable-payout and smoothed variants, T-bond and $ riskfree rate). Returns latest annual and monthly readings, the latest annual ERP's percentile vs 1960+ history, and recent rows (years default 10; months default 12). All rates are DECIMALS (0.0423 = 4.23%). Use for 'what ERP is the market pricing?', capital-market-assumption and cost-of-equity work; for industry cost of capital use damodaran_industry; for CAPE valuation use shiller_cape.",
    inputSchema: {
      type: "object",
      properties: {
        years: { type: "number", default: 10, maximum: 70, description: "recent annual rows to return" },
        months: { type: "number", default: 12, maximum: 220, description: "recent monthly rows (0 = skip the monthly file)" },
      },
    },
    handler: damodaranErp,
  },
  {
    name: "damodaran_industry",
    description:
      "Aswath Damodaran's annual industry datasets (NYU Stern, live, keyless; ~95 industries + Total Market rows; refreshed each January with year-end data — dataAsOf shows the vintage). dataset: wacc (beta, cost of equity, E/(D+E), cost of debt, tax rate, cost of capital), betas (levered, unlevered, cash-corrected, D/E, std dev, multi-year history), pe (current/trailing/forward PE, PEG, growth — US only), ev_ebitda (EV/EBITDA, EV/EBIT, EV/EBITDAR&D; positive-EBITDA and all-firm variants), margins (gross, net, operating, EBITDA, R&D/SG&A/SBC ratios), pbv (P/B, ROE, EV/IC, ROIC — US only), ps (P/S, EV/Sales — US only), roe, taxrate, dividends (payout, buybacks, FCFE), debt (debt ratios, coverage, debt/EBITDA), growth (ROC, reinvestment, fundamental growth), totalbeta. region: us (default), global, europe, japan, emerging, china, india, rest. Filter by `industry` keywords (all must match, e.g. 'bank regional', 'software', 'oil'), choose `columns` by substring, `sortBy` a column (descending default) for rankings, `limit` rows. Rates/margins are DECIMALS (0.0802 = 8.02%); multiples and betas are plain numbers. Use for sector hurdle rates, relative-valuation benchmarks, and comparing a holding's multiple to its industry.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", enum: ["wacc", "betas", "pe", "ev_ebitda", "margins", "pbv", "ps", "roe", "taxrate", "dividends", "debt", "growth", "totalbeta"], default: "wacc" },
        region: { type: "string", enum: ["us", "global", "europe", "japan", "emerging", "china", "india", "rest"], default: "us" },
        industry: { type: "string", description: "keyword filter on industry name" },
        columns: { type: "array", items: { type: "string" }, description: "column-name substrings to keep, e.g. ['cost of capital','beta']" },
        sortBy: { type: "string", description: "column name (exact or substring) to rank by" },
        descending: { type: "boolean", default: true },
        limit: { type: "number", default: 15, maximum: 120 },
      },
    },
    handler: damodaranIndustry,
  },
  {
    name: "shiller_cape",
    description:
      "Robert Shiller's cyclically adjusted P/E (CAPE / P/E10) for the S&P Composite from his maintained ie_data.xls (shillerdata.com, live, keyless; monthly since 1871, updated roughly monthly). Returns the latest month's CAPE, TR CAPE (payout-adjusted), Excess CAPE Yield (1/CAPE minus real 10y yield), 10-year earnings yield, S&P level, GS10 and CPI; the latest CAPE's historical percentile (since `since`, default 1881, plus since 1990), mean/median/p10/p90/min/max and deviation from mean; the latest month with reported earnings/dividends; and the last N months (default 12). Use for long-horizon equity valuation context and expected-return framing; pair with damodaran_erp (implied ERP) for a second valuation lens.",
    inputSchema: {
      type: "object",
      properties: {
        months: { type: "number", default: 12, maximum: 240, description: "recent monthly rows to return" },
        since: { type: "number", default: 1881, description: "first year for percentile/history stats" },
      },
    },
    handler: shillerCape,
  },
  {
    name: "cboe_vol_history",
    description:
      "Cboe volatility index history (live daily CSVs from cdn.cboe.com, keyless; full history: VIX since 1990, VIX9D 2011, VIX3M 2009, VIX6M 2008, VVIX 2006, SKEW 1990). Returns for each requested symbol the latest close, 1/5/21-day changes, percentile vs full history (or lookbackYears), 1-year range and all-time high; a VIX term-structure block (VIX9D, VIX, VIX3M, VIX6M on the latest common date; VIX9D/VIX, VIX/VIX3M, VIX3M/VIX6M ratios; contango / flat / backwardation state; historical percentile of VIX/VIX3M; short-end inversion flag); and the last N days (default 10) with VIX/VIX3M. Levels are vol points. Use for volatility regime, hedging-cost and stress context; FRED's VIXCLS (fred tools) only has spot VIX.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string", enum: ["VIX", "VIX9D", "VIX3M", "VIX6M", "VVIX", "SKEW"] }, description: "default all six" },
        days: { type: "number", default: 10, maximum: 260, description: "recent daily rows" },
        lookbackYears: { type: "number", description: "percentile window in years (default full history)" },
      },
    },
    handler: cboeVolHistory,
  },
];

export const RESEARCH_DOMAIN: CatalogDomain = {
  id: "research",
  label: "Research Datasets (French · AQR · Damodaran · Shiller · Cboe)",
  source:
    "Kenneth R. French Data Library (Tuck), AQR public datasets (.xlsx), Aswath Damodaran NYU Stern datasets, Robert Shiller ie_data.xls (shillerdata.com), Cboe daily index history CSVs — all live, keyless, cached in-memory 6–24h",
  tools: [
    { name: "kfrench_factors", backing: "live-api", probe: "unprobed", note: "CSV zips, cached 12–24h" },
    { name: "kfrench_dataset", backing: "live-api", probe: "unprobed", note: "any library file; catalog scraped from data_library.html" },
    { name: "aqr_factors", backing: "live-api", probe: "unprobed", note: "monthly .xlsx (0.1–2.5 MB), cached 24h" },
    { name: "damodaran_erp", backing: "live-api", probe: "unprobed", note: "annual since 1960 + monthly since 2008" },
    { name: "damodaran_industry", backing: "live-api", probe: "unprobed", note: "legacy .xls decoded in-repo; annual January vintage" },
    { name: "shiller_cape", backing: "live-api", probe: "unprobed", note: "legacy .xls decoded in-repo; link scraped from shillerdata.com" },
    { name: "cboe_vol_history", backing: "live-api", probe: "unprobed", note: "daily CSVs, cached 6h" },
  ],
};

export const RESEARCH_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "research: Fama-French 3 factors", tool: "kfrench_factors", args: { model: "ff3", recent: 2, years: 5 }, note: "13 KB zip — expect latest month ~1-2 months back, Mkt-RF/SMB/HML/RF in percent" },
  { name: "research: Cboe VIX term structure", tool: "cboe_vol_history", args: { symbols: ["VIX"], days: 2 }, note: "fetches VIX/VIX9D/VIX3M/VIX6M CSVs (~1.1 MB total); expect a contango/backwardation state" },
  { name: "research: Damodaran WACC (banks)", tool: "damodaran_industry", args: { dataset: "wacc", industry: "bank", limit: 3 }, note: "77 KB .xls through the in-repo BIFF8 reader; expect Bank (Money Center) + Banks (Regional) rows" },
];
