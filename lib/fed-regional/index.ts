/**
 * Fed Regional Banks family — NY Fed, Atlanta Fed, Philadelphia Fed. All live, keyless.
 *
 *   nyfed_reference_rates        — SOFR/EFFR/OBFR/TGCR/BGCR with percentiles + volumes, SOFR averages
 *   nyfed_primary_dealer         — FR 2004 primary dealer positions/financing: snapshot, search, history
 *   nyfed_operations             — ON RRP, standing repo, SOMA holdings summary
 *   nyfed_term_premia            — ACM 1–10y Treasury term premia (legacy .xls via ./biff.ts; CSV fallback)
 *   nyfed_recession_probability  — yield-curve (10y–3m) 12-month-ahead recession probability
 *   atlfed_gdpnow                — GDPNow nowcast, evolution, component growth/contributions
 *   atlfed_wage_tracker          — Atlanta Fed Wage Growth Tracker (median wage growth, stayers vs switchers)
 *   philfed_spf                  — Survey of Professional Forecasters median forecasts by horizon
 *
 * Endpoint notes live at the top of each module. See README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { nyfedReferenceRates, nyfedPrimaryDealer, nyfedOperations } from "./nyfed-markets";
import { nyfedTermPremia, nyfedRecessionProbability } from "./nyfed-research";
import { atlfedGdpnow, atlfedWageTracker } from "./atlfed";
import { philfedSpf } from "./philfed";

export const FEDREG_TOOLS: ToolDef[] = [
  {
    name: "nyfed_reference_rates",
    description: "NY Fed overnight reference rates (Markets Data API, live, no key): SOFR, EFFR, OBFR, TGCR, BGCR — each with the rate, the 1st/25th/75th/99th volume-weighted percentiles, and daily volume ($bn); EFFR also carries the FOMC target range. Also returns the 30/90/180-day SOFR averages and SOFR Index, and the SOFR–EFFR spread in bp. Default: latest 5 business days of all five rates (newest first); `recent` up to 250, or a startDate/endDate (YYYY-MM-DD) window. Use for funding-market stress (SOFR above EFFR, fat p99 tails around month/quarter-end and Treasury settlements), floating-rate/SOFR-linked pricing, and money-fund yield context. FRED has only the headline rates with a lag — prefer this for percentiles, volumes, same-morning data. Published ~8am ET for the prior business day.",
    inputSchema: {
      type: "object",
      properties: {
        rates: { type: "array", items: { type: "string", enum: ["sofr", "effr", "obfr", "tgcr", "bgcr"] }, description: "Subset of rates (default all five)" },
        recent: { type: "number", default: 5, maximum: 250, description: "Most recent N business days per rate" },
        startDate: { type: "string", description: "YYYY-MM-DD (overrides recent)" },
        endDate: { type: "string", description: "YYYY-MM-DD (default today)" },
      },
    },
    handler: nyfedReferenceRates,
  },
  {
    name: "nyfed_primary_dealer",
    description: "NY Fed Primary Dealer Statistics (FR 2004, weekly, live, no key) — what the ~25 primary dealers hold and how they finance it. Three modes: (1) no args → headline snapshot of the latest week: net Treasury positions (total, bills, 7–11y coupons, >21y), agency MBS, corporates, and Treasury repo/reverse-repo financing, each with week-over-week change ($ millions); (2) query='treasury coupons' → keyword search (AND) across ~1,540 series keyids/descriptions with each match's latest value; (3) keyids=['PDPOSGST-TOT', ...] (max 8) → history (newest first, `recent` weeks, default 8) plus 1w/4w/52w changes. Use for dealer balance-sheet capacity, Treasury supply absorption (record net-long coupons = strained intermediation), repo financing demand, and settlement fails. Keyid prefixes: PDPOS positions, PDTR transactions, PDSORA repo, PDSIRRA reverse repo, PDSIOSB/PDSOOS securities borrowed/lent, PDFT/PDCA fails; trailing C = weekly change. As-of Wednesday, published with ~1-week lag. Not on FRED.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword search over series keyids/descriptions" },
        keyids: { type: "array", items: { type: "string" }, description: "Series keyids to fetch history for (max 8)" },
        recent: { type: "number", default: 8, maximum: 260, description: "Weeks of history per keyid" },
        limit: { type: "number", default: 25, maximum: 100, description: "Max search results" },
      },
    },
    handler: nyfedPrimaryDealer,
  },
  {
    name: "nyfed_operations",
    description: "NY Fed open market operations (Markets Data API, live, no key). kind='rrp' (default): Overnight Reverse Repo facility results — daily take-up ($bn), counterparties, award rate (the floor of the fed funds range); same-day, more detail than FRED RRPONTSYD. kind='repo': Standing Repo Facility operations (twice daily) — take-up by collateral type; any non-zero take-up signals reserve scarcity / repo rates pressing the top of the range. kind='soma': weekly System Open Market Account holdings at par ($bn) — total, bills, notes/bonds, TIPS, FRNs, MBS, CMBS, agencies — with 4/13/52-week changes in the total (QT pace). `recent` = number of operations/weeks (newest first). Pair with nyfed_reference_rates for a full funding-conditions read and macro_market_signals for the net-liquidity composite.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["rrp", "repo", "soma"], default: "rrp" },
        recent: { type: "number", default: 10, maximum: 260 },
      },
    },
    handler: nyfedOperations,
  },
  {
    name: "nyfed_term_premia",
    description: "Adrian-Crump-Moench (ACM) Treasury term premia from the NY Fed (live file, no key): decomposes 1–10y zero-coupon Treasury yields into the expected path of short rates (risk-neutral yield) and the term premium — the extra compensation investors demand for holding duration. Returns the latest full 1–10y curve (term premium, fitted yield, risk-neutral yield), a 10y summary (level, 1m and 1y change, percentile since 1961), and recent history for chosen maturities (default 1/2/5/10y). frequency 'daily' (default, ~1-day lag) or 'monthly' (month-end). Use to answer 'is the long-end selloff about Fed expectations or term premium?' (fiscal/supply/inflation-uncertainty stories show up in the term premium), and for duration positioning. Values in %. Source is a ~10MB legacy .xls parsed in-process (first call ~2-4s, then cached 6h); if that fails, falls back to a monthly 10y-only CSV. Not on FRED in current form (FRED's THREEFYTP series are discontinued).",
    inputSchema: {
      type: "object",
      properties: {
        frequency: { type: "string", enum: ["daily", "monthly"], default: "daily" },
        recent: { type: "number", default: 10, maximum: 400, description: "Rows of history (newest first)" },
        maturities: { type: "array", items: { type: "number", minimum: 1, maximum: 10 }, description: "Maturities (years 1-10) for the history rows; default [1,2,5,10]" },
      },
    },
    handler: nyfedTermPremia,
  },
  {
    name: "nyfed_recession_probability",
    description: "NY Fed yield-curve recession probability (live, no key): the Estrella-Mishkin probit model's probability of a U.S. recession 12 months ahead, driven by the monthly-average 10-year minus 3-month Treasury spread. Returns the headline probability (for the month 12 months after the latest observed spread), the latest curve inputs (10y, 3m, spread), the forward path of probabilities already implied for the next 12 months, recent monthly history with NBER recession flags (default 12 months, newest first), and the 10-year peak. Use for recession-risk framing in client letters and IPS reviews; historically probabilities above ~30% preceded every recession since 1968, but with notable false positives (2023-24). For the raw daily spread use fred_yield_curve or macro_market_signals; for growth nowcasts use atlfed_gdpnow.",
    inputSchema: {
      type: "object",
      properties: { recent: { type: "number", default: 12, maximum: 120, description: "Months of history" } },
    },
    handler: nyfedRecessionProbability,
  },
  {
    name: "atlfed_gdpnow",
    description: "Atlanta Fed GDPNow (live workbook, no key): the model-based running nowcast of current-quarter real GDP growth (% SAAR). Returns the latest nowcast with date and the data releases that moved it, change vs the prior update, the quarter's initial nowcast and min/max range, the latest BEA estimates for the two prior quarters, component detail (PCE goods/services, equipment, IP, structures, residential, government, exports, imports — growth SAAR % and percentage-point contributions — plus net exports and inventory contributions), and the update-by-update evolution (default last 10, newest first). Updated ~6-8 times a month after major releases (ISM, jobs, retail sales, trade, housing). Use for 'what is the economy doing this quarter right now', and to see which components drive the number (e.g. inventory or net-export swings that will reverse). Not an official forecast — no judgment applied. Pair with philfed_spf (consensus) and nyfed_recession_probability. Workbook ~11MB, cached 6h.",
    inputSchema: {
      type: "object",
      properties: {
        recent: { type: "number", default: 10, maximum: 120, description: "Evolution rows (newest first)" },
        includeComponents: { type: "boolean", default: true },
      },
    },
    handler: atlfedGdpnow,
  },
  {
    name: "atlfed_wage_tracker",
    description: "Atlanta Fed Wage Growth Tracker (live workbook, no key): median 12-month growth in individual workers' hourly wages from matched Current Population Survey records (3-month moving average, %) — a composition-robust wage gauge that, unlike average hourly earnings, isn't distorted by who enters/leaves employment. Default series: Overall, Job Stayer, Job Switcher, Overall: Weighted, Paid Hourly, lower/upper half of the wage distribution; any of ~16 series via `series` (see availableSeries, e.g. 'Full-time', 'College degree', 'Age 25-54', 'Female', 'Male', 'Services', 'Overall: Weekly Basis'). Returns latest month, year-ago values, the job-switcher premium (switcher minus stayer, pp — wide = tight labor market), and recent monthly history (default 12, newest first). Use for wage-inflation pressure, services-inflation stickiness and labor-market tightness. Monthly, ~2-week lag after CPS. Cached 24h.",
    inputSchema: {
      type: "object",
      properties: {
        series: { type: "array", items: { type: "string" }, description: "Series names as in availableSeries (case-insensitive)" },
        recent: { type: "number", default: 12, maximum: 360 },
      },
    },
    handler: atlfedWageTracker,
  },
  {
    name: "philfed_spf",
    description: "Philadelphia Fed Survey of Professional Forecasters (live workbooks, no key): the latest quarterly survey's MEDIAN forecasts from ~35-40 professional forecasters — the longest-running macro consensus (since 1968). Default variables: real GDP growth, unemployment rate, headline and core CPI, headline and core PCE inflation, 3-month T-bill and 10-year Treasury yield; optional NGDP, PGDP, EMP (avg monthly payroll change), HOUSING. Each variable returns horizons: the survey quarter (nowcast) and next four quarters, plus annual figures for the current and following years (inflation Q4/Q4; RGDP annual-average growth derived from levels), each with the PREVIOUS survey's median for the same period (forecast revision). Also returns long-run expectations: 5y and 10y CPI/PCE inflation, CPI 5y5y-forward, natural unemployment rate (Q3), and 10-year GDP/productivity/stock/bond/bill returns (Q1) with their survey dates. Use for 'what does consensus expect' in client letters, CMAs and IPS reviews; compare with atlfed_gdpnow (model nowcast) and market pricing. Released mid-Feb/May/Aug/Nov. Cached 24h.",
    inputSchema: {
      type: "object",
      properties: {
        variables: {
          type: "array",
          items: { type: "string", enum: ["RGDP", "UNEMP", "CPI", "CORECPI", "PCE", "COREPCE", "TBILL", "TBOND", "NGDP", "PGDP", "EMP", "HOUSING"] },
        },
        compareToPrevious: { type: "boolean", default: true },
      },
    },
    handler: philfedSpf,
  },
];

export const FEDREG_DOMAIN: CatalogDomain = {
  id: "fedregional",
  label: "Fed Regional Banks (NY · Atlanta · Philadelphia)",
  source: "NY Fed Markets Data API + NY Fed research files (ACM term premia, yield-curve recession model), Atlanta Fed GDPNow & Wage Growth Tracker workbooks, Philadelphia Fed SPF median workbooks — live, keyless",
  tools: [
    { name: "nyfed_reference_rates", backing: "live-api", probe: "unprobed" },
    { name: "nyfed_primary_dealer", backing: "live-api", probe: "unprobed" },
    { name: "nyfed_operations", backing: "live-api", probe: "unprobed" },
    { name: "nyfed_term_premia", backing: "live-api", probe: "unprobed", note: "parses a ~10MB legacy .xls in-process; cached 6h" },
    { name: "nyfed_recession_probability", backing: "live-api", probe: "unprobed" },
    { name: "atlfed_gdpnow", backing: "live-api", probe: "unprobed", note: "~11MB xlsx; cached 6h" },
    { name: "atlfed_wage_tracker", backing: "live-api", probe: "unprobed" },
    { name: "philfed_spf", backing: "live-api", probe: "unprobed" },
  ],
};

export const FEDREG_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "NY Fed reference rates (SOFR, last 2)", tool: "nyfed_reference_rates", args: { rates: ["sofr"], recent: 2 } },
  { name: "NY Fed recession probability", tool: "nyfed_recession_probability", args: { recent: 3 } },
  { name: "Atlanta Fed wage tracker", tool: "atlfed_wage_tracker", args: { recent: 3 }, note: "~340KB xlsx" },
];
