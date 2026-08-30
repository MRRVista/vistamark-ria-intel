/**
 * VistaIntel tool catalog — navigation taxonomy for the 64 MCP tools.
 *
 * WHY THIS EXISTS
 * ---------------
 * `lib/mcp/tools.ts` is a flat array of 64 tools. That is the right shape for
 * an MCP client (which wants tools/list) and the wrong shape for a human
 * (who wants "show me the endowment tools"). This module adds the layer the
 * flat registry deliberately omits: which data DOMAIN a tool belongs to,
 * what is actually STORING the data behind it, and whether it last ran.
 *
 * THREE ORTHOGONAL FACTS PER TOOL
 * -------------------------------
 * 1. `backing`  — where the bytes live. This is the single most useful field
 *                 for triage: a `postgres` tool that returns nothing is an
 *                 INGEST problem; a `live-api` tool that returns nothing is
 *                 an UPSTREAM problem. Different fix, different owner.
 * 2. `probe`    — the last known selftest verdict. A SNAPSHOT, not live truth.
 * 3. `note`     — why a non-live probe is what it is, in plain language.
 *
 * ON `probe` BEING A SNAPSHOT
 * ---------------------------
 * These values are hand-synced from a /api/selftest run (see PROBE_SOURCE).
 * They exist so the console can paint status instantly on first paint instead
 * of blocking ~7s on a 36-check selftest. They WILL drift. Anything making a
 * real decision should read /api/selftest, and /api/catalog?health=1 overlays
 * live ingest-pipeline state on top of this. Treat `probe` as a hint that
 * tells the UI which colour to start with, never as a source of truth.
 */

export type ToolProbe =
  | "live" //      probed and returned real data
  | "slow" //      probed and exceeded the selftest per-check budget
  | "empty" //     probed clean, but the backing table has never been ingested
  | "degraded" //  probed and resolved, but returned structurally null metrics
  | "unprobed"; //  not covered by selftest — status genuinely unknown

export type ToolBacking =
  | "postgres" //  served from the Neon tables in lib/db/schema.ts
  | "live-api" //  proxied to an upstream API on every call, nothing stored
  | "hybrid"; //   live upstream call, curated local universe/metadata

export interface CatalogTool {
  name: string;
  backing: ToolBacking;
  probe: ToolProbe;
  note?: string;
}

export interface CatalogDomain {
  id: string;
  label: string;
  /** Human-readable provenance — shown verbatim in the console sidebar. */
  source: string;
  tools: CatalogTool[];
}

/** Provenance for every `probe` value below. Update when re-syncing. */
export const PROBE_SOURCE = {
  endpoint: "/api/selftest",
  ranAt: "2026-08-30T22:19:59.823Z",
  checksRun: 39,
  passed: 39,
  failed: 0,
  note:
    "Clean run. The three FRED composites that timed out in the 08.19 sync " +
    "now finish in ~2.6s against the 7000ms budget, so they move slow -> live. " +
    "EODHD probes are live for the first time (token landed). Passing is NOT " +
    "the same as healthy: dol_plan_search still answers rows:[] on total:224947, " +
    "and ppd_plan_profile/bdc_profile still return all-null metrics, so those " +
    "stay degraded despite ok=true.",
} as const;

export const DOMAINS: CatalogDomain[] = [
  {
    id: "ria",
    label: "RIA / Form ADV",
    source: "SEC Form ADV + IAPD bulk filings (ingested)",
    tools: [
      { name: "search_rias", backing: "postgres", probe: "live" },
      { name: "get_ria_profile", backing: "postgres", probe: "unprobed" },
      { name: "search_advisors", backing: "postgres", probe: "unprobed" },
      { name: "find_alumni", backing: "postgres", probe: "unprobed" },
      { name: "get_aum_history", backing: "postgres", probe: "unprobed" },
      { name: "firms_using_custodian", backing: "postgres", probe: "unprobed" },
      { name: "top_rias_by", backing: "postgres", probe: "live" },
    ],
  },
  {
    id: "nonprofit",
    label: "Nonprofits",
    source: "IRS EO BMF (ingested) + ProPublica Nonprofit Explorer 990s (live)",
    tools: [
      { name: "irs_eo_search", backing: "postgres", probe: "live" },
      { name: "irs_eo_lookup", backing: "postgres", probe: "unprobed" },
      { name: "propublica_org_search", backing: "live-api", probe: "live" },
      { name: "propublica_org_990", backing: "live-api", probe: "unprobed" },
    ],
  },
  {
    id: "retirement",
    label: "Retirement Plans",
    source: "DOL Form 5500 (ingested)",
    tools: [
      {
        name: "dol_plan_search",
        backing: "postgres",
        probe: "degraded",
        note:
          "Table is POPULATED (224,947 rows) but every probe returned an empty " +
          "rows array — including the unfiltered one, which reported total=224947 " +
          "with rows=[]. State+assets and 401(k) feature-code filters both " +
          "returned total=0. Row projection and filter predicates are broken, " +
          "not the ingest.",
      },
      { name: "dol_plan_lookup", backing: "postgres", probe: "unprobed" },
    ],
  },
  {
    id: "endowment",
    label: "Endowments",
    source: "IPEDS Finance Survey Part H, FY2003-04 to FY2022-23 (ingested)",
    tools: [
      { name: "endowment_search", backing: "postgres", probe: "live" },
      { name: "endowment_lookup", backing: "postgres", probe: "unprobed" },
      { name: "endowment_peer_set", backing: "postgres", probe: "unprobed" },
      { name: "endowment_percentile_rank", backing: "postgres", probe: "live" },
      { name: "endowment_growth_history", backing: "postgres", probe: "unprobed" },
      { name: "endowment_decade_comparison", backing: "postgres", probe: "unprobed" },
    ],
  },
  {
    id: "nacubo",
    label: "NACUBO Benchmarks",
    source: "NACUBO/Commonfund NCSE public aggregates, FY2020-FY2025 (ingested)",
    tools: [{ name: "nacubo_benchmark_lookup", backing: "postgres", probe: "live" }],
  },
  {
    id: "pension",
    label: "Public Pensions",
    source: "Public Plans Database — ~230 largest state/local plans (live)",
    tools: [
      { name: "ppd_plan_search", backing: "live-api", probe: "live" },
      {
        name: "ppd_plan_profile",
        backing: "live-api",
        probe: "degraded",
        note:
          "Resolves the plan and returns 3 observations, but the `latest` block " +
          "came back all-null (marketAssetsUsd, fundedRatioPct, etc.) for a plan " +
          "the size of California PERF. Latest-period selection is picking a row " +
          "with no reported values.",
      },
      { name: "ppd_list_variables", backing: "live-api", probe: "live" },
    ],
  },
  {
    id: "ppp",
    label: "SBA PPP Loans",
    source: "SBA PPP FOIA bulk data, loans >= $150K (ingested)",
    tools: [
      {
        name: "ppp_search",
        backing: "postgres",
        probe: "empty",
        note: "ppp_loans table has never been ingested — returns a clean total=0.",
      },
      { name: "ppp_lookup", backing: "postgres", probe: "unprobed" },
    ],
  },
  {
    id: "federal",
    label: "Federal Awards",
    source: "USAspending.gov award-level grants/contracts/loans (live)",
    tools: [
      { name: "usaspending_awards_search", backing: "live-api", probe: "live" },
      { name: "usaspending_top_recipients", backing: "live-api", probe: "live" },
    ],
  },
  {
    id: "holdings",
    label: "13F Holdings",
    source: "SEC Form 13F quarterly data sets (ingested)",
    tools: [
      {
        name: "holdings_by_manager",
        backing: "postgres",
        probe: "empty",
        note:
          "f13f_filings / f13f_holdings never ingested — the quarterly cron is a " +
          "deliberate no-op stub. Returns a clean empty result, not an error.",
      },
      { name: "holders_of_security", backing: "postgres", probe: "unprobed" },
    ],
  },
  {
    id: "banks",
    label: "Banks / FDIC",
    source: "FDIC BankFind Suite API (live)",
    tools: [
      { name: "fdic_bank_search", backing: "live-api", probe: "live" },
      { name: "fdic_bank_financials", backing: "live-api", probe: "unprobed" },
      { name: "fdic_failed_banks", backing: "live-api", probe: "unprobed" },
    ],
  },
  {
    id: "systemic",
    label: "Systemic Risk / OFR",
    source: "Office of Financial Research — FSI, repo, MMF, CP (live)",
    tools: [
      { name: "ofr_financial_stress_index", backing: "live-api", probe: "live" },
      { name: "ofr_series_search", backing: "live-api", probe: "unprobed" },
      { name: "ofr_series", backing: "live-api", probe: "unprobed" },
    ],
  },
  {
    id: "edgar",
    label: "SEC EDGAR",
    source: "SEC EDGAR submissions, XBRL frames, full-text search (live)",
    tools: [
      { name: "edgar_company_lookup", backing: "live-api", probe: "live" },
      { name: "edgar_company_filings", backing: "live-api", probe: "unprobed" },
      { name: "edgar_financial_concept", backing: "live-api", probe: "live" },
      { name: "edgar_concept_frame", backing: "live-api", probe: "live" },
      { name: "edgar_fulltext_search", backing: "live-api", probe: "live" },
      { name: "formd_search", backing: "live-api", probe: "live" },
    ],
  },
  {
    id: "gleif",
    label: "Entity Resolution / GLEIF",
    source: "GLEIF LEI records + accounting-consolidation family trees (live)",
    tools: [
      { name: "gleif_entity_search", backing: "live-api", probe: "live" },
      { name: "gleif_entity_profile", backing: "live-api", probe: "live" },
    ],
  },
  {
    id: "bdc",
    label: "Private Credit / BDC",
    source: "Curated BIZD-style listed-BDC universe on live EDGAR XBRL",
    tools: [
      { name: "bdc_list", backing: "hybrid", probe: "live" },
      {
        name: "bdc_profile",
        backing: "hybrid",
        probe: "degraded",
        note:
          "Resolves the filer and returns recent filings, but every financial " +
          "metric came back null (totalAssetsUsd, netAssetsUsd, navPerShare, ...) " +
          "for ARCC. The XBRL concept mapping is not matching BDC tags.",
      },
      { name: "bdc_screen", backing: "hybrid", probe: "unprobed" },
    ],
  },
  {
    id: "macro",
    label: "Macro & Rates",
    source: "FRED + Treasury Fiscal Data incl. Daily Treasury Statement (live)",
    tools: [
      { name: "morning_market_brief", backing: "live-api", probe: "live" },
      { name: "macro_market_signals", backing: "live-api", probe: "live" },
      { name: "fred_batch_latest", backing: "live-api", probe: "live" },
      { name: "fred_series_search", backing: "live-api", probe: "unprobed" },
      { name: "fred_get_series", backing: "live-api", probe: "unprobed" },
      { name: "fred_yield_curve", backing: "live-api", probe: "live" },
      { name: "treasury_avg_rates", backing: "live-api", probe: "live" },
      { name: "treasury_debt_outstanding", backing: "live-api", probe: "unprobed" },
      { name: "treasury_daily_cash", backing: "live-api", probe: "live" },
      { name: "treasury_daily_flows", backing: "live-api", probe: "live" },
    ],
  },
  {
    id: "markets",
    label: "Market Data / EODHD",
    source: "EODHD — global prices, fundamentals, news, screener (live, keyed)",
    tools: [
      { name: "eodhd_search", backing: "live-api", probe: "live" },
      { name: "eodhd_eod_prices", backing: "live-api", probe: "live" },
      { name: "eodhd_quote", backing: "live-api", probe: "live" },
      {
        name: "eodhd_dividends_splits",
        backing: "live-api",
        probe: "unprobed",
        note:
          "The token is live and the family is proven by the three probed tools; " +
          "these four simply have no selftest coverage yet. Unprobed here means " +
          "uncovered, not broken.",
      },
      { name: "eodhd_fundamentals", backing: "live-api", probe: "unprobed" },
      { name: "eodhd_news", backing: "live-api", probe: "unprobed" },
      { name: "eodhd_screener", backing: "live-api", probe: "unprobed" },
    ],
  },
  {
    id: "system",
    label: "System",
    source: "Ingest run records + per-pipeline health",
    tools: [{ name: "database_status", backing: "postgres", probe: "live" }],
  },
];

/** Flat view of every catalogued tool, with its domain stamped on. */
export const CATALOG_TOOLS: Array<CatalogTool & { domain: string; domainLabel: string }> =
  DOMAINS.flatMap((d) =>
    d.tools.map((t) => ({ ...t, domain: d.id, domainLabel: d.label }))
  );

export const DOMAIN_BY_TOOL: Record<string, string> = Object.fromEntries(
  CATALOG_TOOLS.map((t) => [t.name, t.domain])
);

export const CATALOG_TOOL_COUNT = CATALOG_TOOLS.length;

/**
 * Roll the per-tool probe values into counts for the console header.
 * Deliberately returns `unprobed` as its own bucket rather than folding it
 * into "ok" — an untested tool is not a passing tool, and collapsing the two
 * is exactly the kind of false green that makes a status page worthless.
 */
export function probeSummary(): Record<ToolProbe, number> & { total: number } {
  const out: any = { live: 0, slow: 0, empty: 0, degraded: 0, unprobed: 0, total: 0 };
  for (const t of CATALOG_TOOLS) {
    out[t.probe] += 1;
    out.total += 1;
  }
  return out;
}

/**
 * Reconcile the catalog against the live tool registry. Any drift here means
 * someone added or renamed a tool in lib/mcp/tools.ts without updating this
 * file, and the console navigation would silently hide it.
 */
export function reconcile(registryNames: string[]): {
  ok: boolean;
  registryCount: number;
  catalogCount: number;
  uncatalogued: string[];
  missingFromRegistry: string[];
} {
  const reg = new Set(registryNames);
  const cat = new Set(CATALOG_TOOLS.map((t) => t.name));
  const uncatalogued = registryNames.filter((n) => !cat.has(n));
  const missingFromRegistry = CATALOG_TOOLS.map((t) => t.name).filter((n) => !reg.has(n));
  return {
    ok: uncatalogued.length === 0 && missingFromRegistry.length === 0,
    registryCount: reg.size,
    catalogCount: cat.size,
    uncatalogued,
    missingFromRegistry,
  };
}
