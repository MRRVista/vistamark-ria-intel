/**
 * Funds & Managers family — SEC investment-company and manager filings, live
 * from EDGAR / sec.gov (no bulk ingest, no API key).
 *
 *   nport_fund_search       ticker / fund name -> cik, seriesId, classId
 *   nport_holdings          latest public NPORT-P: fund totals + top holdings
 *   ncen_service_providers  latest N-CEN: advisers, sub-advisers, custodians, TA, admin, auditor, underwriter, pricing
 *   formpf_statistics       SEC Private Fund Statistics (Form PF aggregates) — headline tables / any tab
 *   form_ma_search          registered municipal advisors (Form MA / MA-I)
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { nportFundSearch, nportHoldings } from "./nport";
import { ncenServiceProviders } from "./ncen";
import { formpfStatistics } from "./formpf";
import { formMaSearch } from "./formma";

export const FUNDS_TOOLS: ToolDef[] = [
  {
    name: "nport_fund_search",
    description:
      "Resolve a mutual fund / ETF ticker, series id, or fund-name text to its SEC identifiers: registrant CIK (the trust), seriesId (S000…, the fund/portfolio) and classId (C000…, the share class), plus registrant, series and class names. Sources: SEC company_tickers_mf.json and the Investment Company Series & Class list. Use before nport_holdings / ncen_service_providers when you only have a name (e.g. 'Contrafund', 'Windsor II', 'total bond'). One series has several tickers (share classes) that share one portfolio. UIT ETFs like SPY/DIA aren't in the fund map — pass those tickers straight to nport_holdings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Ticker (VFIAX), series id (S000002839), class id, or name text ('500 index')." },
        limit: { type: "number", default: 15, maximum: 50 },
      },
      required: ["query"],
    },
    handler: nportFundSearch,
  },
  {
    name: "nport_holdings",
    description:
      "Portfolio holdings of a registered fund (mutual fund, ETF, closed-end fund) from its latest PUBLIC Form N-PORT (NPORT-P), live from EDGAR. Returns fund totals (total assets, liabilities, net assets in USD, holdings count, top-10 concentration), the three monthly total returns for the quarter, a composition summary by asset category, and the top N holdings sorted by % of net assets: name, CUSIP, ISIN, balance + units (NS shares / PA principal), value USD, pctVal (percent of net assets, already in %), asset category (EC equity, DBT debt, STIV cash vehicles, DE/DIR/DFE derivatives, ABS-MBS, LON loans…), issuer category, country, and coupon/maturity for debt. Identify the fund by ticker (VFIAX, SPY, AGG, FCNTX), seriesId, or registrant cik + seriesName. Caveat: only each fiscal quarter's last month is public, released ~60 days later, so holdings are 2-5 months old (see filing.reportPeriodEnd). For 13F-filing managers' equity books use the 13F tools instead; this is the fund-level, all-asset-class view.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Fund/ETF ticker, e.g. VFIAX, SPY, IVV, FXAIX." },
        seriesId: { type: "string", description: "SEC series id S000xxxxxx (preferred when known)." },
        cik: { type: "string", description: "Registrant (trust) CIK — combine with seriesName for multi-fund trusts." },
        seriesName: { type: "string", description: "Fund name text to pick a series within the cik's trust." },
        limit: { type: "number", default: 20, maximum: 200, description: "Top N holdings by % of net assets." },
        assetCategory: { type: "string", description: "Filter holdings by N-PORT asset category code: EC, EP, DBT, STIV, RA, ABS-MBS, ABS-O, LON, DE, DIR, DFE, DCR, OTHER…" },
        accession: { type: "string", description: "Optional specific NPORT-P accession number (with dashes) instead of the latest." },
      },
    },
    handler: nportHoldings,
  },
  {
    name: "ncen_service_providers",
    description:
      "Service-provider roster for a registered investment company from its latest annual Form N-CEN (live EDGAR): per fund series — investment advisers and SUB-ADVISERS (with SEC 801- file numbers, CRD and LEI), administrators, custodians (sub-custodian count), transfer agents, shareholder-servicing agents, pricing services, securities-lending agents, liquidity-classification vendors; registrant level — principal underwriters/distributors and independent auditor (PCAOB #), plus sponsor/trustee/depositor for UITs (e.g. SPY). Multi-series trusts also get a roll-up of distinct advisers/custodians/admins across all series. Identify by registrant cik, a fund ticker (filters to that series), or seriesId; seriesName filters within the trust. Use for 'who sub-advises this fund', 'which custodian/administrator does X use', competitive/intermediary mapping; adviser CRDs join to Form ADV tools. Filed annually ~75 days after fiscal year end.",
    inputSchema: {
      type: "object",
      properties: {
        cik: { type: "string", description: "Registrant (trust) CIK." },
        ticker: { type: "string", description: "Fund ticker — resolves the trust and filters to that series." },
        seriesId: { type: "string", description: "S000xxxxxx to filter to one series." },
        seriesName: { type: "string", description: "Name text to filter series within the trust." },
        limitSeries: { type: "number", default: 2, maximum: 50, description: "Max series to return in detail." },
      },
    },
    handler: ncenServiceProviders,
  },
  {
    name: "formpf_statistics",
    description:
      "Private-fund industry aggregates from the SEC Division of Investment Management's quarterly Private Fund Statistics (built from confidential Form PF filings by registered advisers with ≥$150M private fund AUM). Parses the machine-readable supporting-data xlsx: number of funds, gross asset value (GAV) and net asset value (NAV) in $ billions by fund type (hedge, private equity, real estate, VC, securitized asset, liquidity, other), number of advisers by fund type, and borrowings as % of GAV — each with latest quarter, prior quarter, year-ago and QoQ/YoY % change. Also lists the latest report PDF/xlsx links. Pass table (e.g. 'Tab.8.10' QHF NAV by strategy, 'Tab.4.2' beneficial ownership %, 'Tab.3.2' adviser location, 'Tab.10.1' PE portfolio-company industries) with history=N for any of ~140 published series back to 2013Q1. Data lags ~2 quarters. Market-sizing context only — no individual fund or manager data (use Form ADV / Form D tools for that).",
    inputSchema: {
      type: "object",
      properties: {
        quarter: { type: "string", description: "Release quarter like '2025Q3' (default latest with xlsx)." },
        table: { type: "string", description: "Specific tab id, e.g. 'Tab.2.3' or 'Tab.8.10'." },
        history: { type: "number", default: 8, maximum: 60, description: "Trailing quarters to return with table." },
      },
    },
    handler: formpfStatistics,
  },
  {
    name: "form_ma_search",
    description:
      "SEC-registered municipal advisors (Form MA firms; MA-I individuals). Name search runs against the SEC's monthly list of CURRENTLY registered MA firms (~400; name, 867- file number, CIK), enriched with latest Form MA filing date/form and EDGAR business location; names not on the list fall back to EDGAR full-text search (finds withdrawn firms). state='IL' lists firms with MA filings based in that state (rolled up from the 100 most recent filings), flagged currentlyRegistered. individuals=true searches MA-I filings (associated natural persons). Use for public-finance / municipal-advisory prospecting, verifying an MA registration, or finding who advises issuers in a state. Returns firm, CIK, file number, location, latestFilingDate, latestForm (MA, MA-A, MA/A, MA-W withdrawal), filing URL.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Firm name text (or 867- file number / CIK); with individuals=true, any filing text such as a person's name." },
        state: { type: "string", description: "2-letter state of the filer's business address, e.g. IL." },
        individuals: { type: "boolean", default: false, description: "Search MA-I (individual) filings instead of firm filings." },
        limit: { type: "number", default: 15, maximum: 50 },
      },
    },
    handler: formMaSearch,
  },
];

export const FUNDS_DOMAIN: CatalogDomain = {
  id: "funds",
  label: "Funds & Managers (N-PORT · N-CEN · Form PF · Form MA)",
  source: "SEC EDGAR live: NPORT-P / N-CEN primary_doc.xml, company_tickers_mf.json, Series & Class list, Private Fund Statistics xlsx, municipal advisor list + EDGAR full-text search",
  tools: [
    { name: "nport_fund_search", backing: "live-api", probe: "unprobed" },
    { name: "nport_holdings", backing: "live-api", probe: "unprobed", note: "Public NPORT-P is quarterly with ~60-day lag" },
    { name: "ncen_service_providers", backing: "live-api", probe: "unprobed" },
    { name: "formpf_statistics", backing: "live-api", probe: "unprobed", note: "Aggregates only; individual Form PF filings are confidential" },
    { name: "form_ma_search", backing: "live-api", probe: "unprobed" },
  ],
};

export const FUNDS_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "funds: N-PORT holdings (VFIAX)", tool: "nport_holdings", args: { ticker: "VFIAX", limit: 5 }, note: "series Atom feed + ~500KB XML" },
  { name: "funds: municipal advisor name search", tool: "form_ma_search", args: { query: "PFM", limit: 3 } },
];
