/**
 * Fed Board & Treasury Markets family — Federal Reserve Board publications and
 * U.S. Treasury market-plumbing data a CIO needs around FOMC days, auctions and
 * foreign demand. All live, keyless, cached in-memory.
 *
 *   fed_press_releases          — Board RSS feeds (all / monetary / bcreg / enforcement / orders / other / speeches / testimony)
 *   fomc_calendar               — FOMC meeting schedule (past + upcoming), next meeting, statement/minutes/SEP links
 *   fomc_statement              — latest or dated FOMC statement text + vote + rate decision line
 *   fed_enforcement_actions     — Board enforcement actions database (1990s → today) by name/state/type/status
 *   treasury_auctions           — FiscalData auction results (stop yield, bid-to-cover, indirect/direct/dealer shares)
 *   treasury_upcoming_auctions  — FiscalData upcoming auction schedule and sizes
 *   treasury_tic_holders        — TIC major foreign holders of Treasuries (latest month, 12m change, country series)
 *   treasury_savings_bond_rates — Series I / EE savings bond rates and history (TreasuryDirect)
 *
 * Complements (does not duplicate) lib/fred (series), lib/treasury (avg rates, debt outstanding, DTS),
 * lib/fed-regional (NY Fed reference rates / dealer stats / operations, Atlanta, Philly).
 * Endpoint notes at the top of each module; see README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { fedPressReleases, fomcStatement, FEEDS } from "./press";
import { fomcCalendar, latestStatement } from "./fomc";
import { fedEnforcementActions } from "./enforcement";
import { treasuryAuctions, treasuryUpcomingAuctions } from "./auctions";
import { treasuryTicHolders } from "./tic";
import { treasurySavingsBondRates } from "./savings";

export const FEDBOARD_TOOLS: ToolDef[] = [
  {
    name: "fed_press_releases",
    description:
      "Latest Federal Reserve Board press releases, speeches and testimony from the Board's official RSS feeds (live, keyless; each feed carries only the most recent 15–20 items, roughly the last 1–6 weeks depending on feed). feed: all (default, every press release), monetary (FOMC statements, minutes, discount-rate actions), bcreg (bank/consumer regulation), enforcement, orders (banking applications), other, speeches (Board governors; title = 'Surname, Title'), testimony. Optional sinceDays and keyword (all words must appear in title/summary). Returns title, ISO date, link, category and a ≤300-char summary. Use for 'what did the Fed announce this week', 'recent Waller speeches'; for the statement text use fomc_statement, for meeting dates fomc_calendar, for historical enforcement use fed_enforcement_actions.",
    inputSchema: {
      type: "object",
      properties: {
        feed: { type: "string", enum: Object.keys(FEEDS), default: "all" },
        limit: { type: "number", default: 10, maximum: 25 },
        sinceDays: { type: "number", description: "only items published within the last N days" },
        keyword: { type: "string", description: "space-separated words that must all appear (case-insensitive), e.g. 'stress test'" },
      },
    },
    handler: fedPressReleases,
  },
  {
    name: "fomc_calendar",
    description:
      "FOMC meeting calendar scraped live from federalreserve.gov (keyless; covers current year ±5, e.g. 2021–2027). Returns the next meeting (decision day, days until, whether it is an SEP/dot-plot meeting), the last meeting with links to its statement, implementation note, minutes (and minutes release date), press conference and projection materials, the next N upcoming decision days, and the full schedule for `year` (default this year). Dates are ISO; decision day = last day of the meeting (statement at 2:00 p.m. ET; minutes three weeks later). Set links=true for every document URL per meeting. Use before fomc_statement when you need a specific meeting's date.",
    inputSchema: {
      type: "object",
      properties: {
        year: { type: "number", description: "schedule year (default current year)" },
        upcoming: { type: "number", default: 4, maximum: 16, description: "how many upcoming decision days to list" },
        links: { type: "boolean", default: false, description: "include all document links (statement PDF, implementation note, press conference, projections)" },
      },
    },
    handler: fomcCalendar,
  },
  {
    name: "fomc_statement",
    description:
      "Full text of an FOMC policy statement from the Board's press release page (live, keyless). Default = the most recent completed meeting's statement (resolved via the FOMC calendar); or pass date = the decision day (YYYY-MM-DD, e.g. 2024-09-18) for any meeting since ~2006. Returns the statement text trimmed to maxChars (default 3,000; max 5,000), the extracted vote (e.g. '12–0' or the 'Voting for/against' sentences), the sentence stating the federal funds target range decision, release time and the implementation-note link. Use for 'what did the Fed say', comparing language across meetings (call twice with two dates). Minutes and SEP are linked from fomc_calendar, not fetched here.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "FOMC decision day YYYY-MM-DD; omit for latest" },
        maxChars: { type: "number", default: 3000, maximum: 5000 },
      },
    },
    handler: (args: any) => fomcStatement(args ?? {}, latestStatement),
  },
  {
    name: "fed_enforcement_actions",
    description:
      "Search the Federal Reserve Board's enforcement-actions database (live JSON behind the Board's search page, keyless; ~2,900 actions: 2019→today always loaded, 1990s–2018 loaded when includeHistorical=true, when `name` is given, or when `since` predates 2019). Covers written agreements, cease-and-desist orders, civil money penalties, prohibitions from banking (individuals), Section 19 letters, PCA directives for state member banks, bank/savings-and-loan holding companies, foreign banks and their insiders. Filters: name (words in institution/individual/affiliation), state (2-letter, parsed from the party's city/state), actionType (substring, e.g. 'Written Agreement', 'Civil Money Penalty'), status (active | terminated | all), since (YYYY[-MM[-DD]]) or sinceDays, includeIndividuals (default true). Returns effective/termination dates (ISO), type, party, state, document URL, plus counts by type. Falls back to the enforcement RSS feed if the JSON is unavailable. OCC/FDIC/CFPB actions are NOT included.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "institution or individual name words, e.g. 'Wells Fargo'" },
        state: { type: "string", description: "two-letter state, e.g. IL" },
        actionType: { type: "string" },
        status: { type: "string", enum: ["all", "active", "terminated"], default: "all" },
        since: { type: "string", description: "effective date on/after YYYY, YYYY-MM or YYYY-MM-DD" },
        sinceDays: { type: "number" },
        includeIndividuals: { type: "boolean", default: true },
        includeHistorical: { type: "boolean", default: false, description: "also load pre-2019 actions (~570 KB)" },
        limit: { type: "number", default: 15, maximum: 25 },
      },
    },
    handler: fedEnforcementActions,
  },
  {
    name: "treasury_auctions",
    description:
      "Results of recent U.S. Treasury auctions from FiscalData 'Treasury Securities Auctions Data' (live, keyless; every auction since 1979, results post ~1:30–2 p.m. ET on auction day). Filters: securityType (Bill | Note | Bond = nominal only; TIPS | FRN | CMB resolved via FiscalData flag columns), term ('10-Year', '10y', '13-Week', '4w'; coupon terms also match reopenings such as '9-Year 10-Month'), since/until (YYYY-MM-DD) or sinceDays, limit (default 12, max 25), fields (subset of output keys). Per auction: date, CUSIP, offered/accepted/tendered ($bn), bid-to-cover, stop (high yield for coupons, high discount rate for bills, high discount margin for FRNs; percent), median, high-minus-median (bp), coupon, price, allotment at high, and indirect/direct/dealer shares of competitive awards (%), non-comp and SOMA add-on ($bn). No when-issued yield is published here, so a true tail vs WI is not computed. Use for 'how did the 10-year auction go', 'bid-to-cover trend for 2-years'; for the schedule use treasury_upcoming_auctions; for yields on the run use FRED (DGS10).",
    inputSchema: {
      type: "object",
      properties: {
        securityType: { type: "string", enum: ["Bill", "Note", "Bond", "TIPS", "FRN", "CMB"] },
        term: { type: "string", description: "e.g. '10-Year', '2y', '30-Year', '13-Week', '4w'" },
        since: { type: "string", description: "auction date on/after YYYY-MM-DD" },
        until: { type: "string", description: "auction date on/before YYYY-MM-DD" },
        sinceDays: { type: "number" },
        limit: { type: "number", default: 12, maximum: 25 },
        fields: { type: "array", items: { type: "string" }, description: "subset of output keys, e.g. ['stop','bidToCover','indirectPct']" },
      },
    },
    handler: treasuryAuctions,
  },
  {
    name: "treasury_upcoming_auctions",
    description:
      "Upcoming U.S. Treasury auctions from FiscalData 'Upcoming Auctions' (live, keyless; the tentative/announced schedule for roughly the next two weeks, refreshed daily). Returns each auction's date, security type (Bill | Note | Bond only — TIPS/FRNs show as Note/Bond with odd terms) and term, reopening flag, CUSIP, offering size in $bn (null until Treasury announces it), announcement and issue dates; plus a by-day digest, the coupon (note/bond/TIPS/FRN) auction list and total announced coupon supply in the window. Filters: securityType, days (horizon, default 21), limit. Use for 'what Treasury supply is coming this week', 'when is the next 30-year auction'; results afterwards via treasury_auctions.",
    inputSchema: {
      type: "object",
      properties: {
        securityType: { type: "string", enum: ["Bill", "Note", "Bond"] },
        days: { type: "number", default: 21, maximum: 60 },
        limit: { type: "number", default: 25, maximum: 25 },
      },
    },
    handler: treasuryUpcomingAuctions,
  },
  {
    name: "treasury_tic_holders",
    description:
      "Major Foreign Holders of U.S. Treasury securities from the Treasury International Capital (TIC) system (live, keyless; monthly, published ~6–7 weeks after month-end; $ billions, end of month; ~20 named countries plus All Other, Grand Total and foreign-official memo lines). Default returns the latest month ranked by holdings (top N, default 15) with share of total foreign holdings, 1-month and 12-month changes ($bn and %), biggest risers/fallers, total foreign and foreign-official holdings. sortBy: holdings | change12m | change1m. Pass country (e.g. 'Japan', 'China', 'UK', 'Belgium', 'Cayman Islands', 'Grand Total') for a monthly series (default 24 months, up to 120 from the TIC history file). Custodial-centre caveat applies (Belgium/Luxembourg/Cayman/UK holdings include other countries' assets). Use for 'is China selling Treasuries', 'foreign demand for USTs'.",
    inputSchema: {
      type: "object",
      properties: {
        top: { type: "number", default: 15, maximum: 25 },
        sortBy: { type: "string", enum: ["holdings", "change12m", "change1m"], default: "holdings" },
        country: { type: "string", description: "one holder for a monthly time series" },
        months: { type: "number", default: 24, maximum: 120, description: "series length when country is given" },
      },
    },
    handler: treasuryTicHolders,
  },
  {
    name: "treasury_savings_bond_rates",
    description:
      "Current Series I and Series EE U.S. savings bond rates with history, scraped live from TreasuryDirect (keyless; rates reset every May 1 and November 1; no FiscalData API carries these). I bond: composite rate, fixed rate (locked for 30 years), semiannual inflation rate (and annualized), the issue window the rates apply to, fixed-rate and inflation-rate history by set date (since 1998), and the composite rate currently earned by purchase window. EE bond: fixed rate, issue window, the 20-year doubling guarantee, fixed-rate history since 2005. history = rows per table (default 8). Use for client cash/inflation-hedge questions ('what are I bonds paying', 'is the I bond fixed rate attractive vs TIPS'); for TIPS real yields use FRED (DFII5/DFII10).",
    inputSchema: {
      type: "object",
      properties: {
        series: { type: "string", enum: ["I", "EE", "both"], default: "both" },
        history: { type: "number", default: 8, maximum: 60 },
      },
    },
    handler: treasurySavingsBondRates,
  },
];

export const FEDBOARD_DOMAIN: CatalogDomain = {
  id: "fedboard",
  label: "Fed Board & Treasury Markets (FOMC · press · auctions · TIC · savings bonds)",
  source:
    "Federal Reserve Board RSS feeds, FOMC calendar + statement pages and enforcement-actions JSON (federalreserve.gov); U.S. Treasury FiscalData auctions_query / upcoming_auctions; TIC Major Foreign Holders tables (ticdata.treasury.gov); TreasuryDirect savings-bond rate pages — all live, keyless, cached in-memory 15 min–24 h",
  tools: [
    { name: "fed_press_releases", backing: "live-api", probe: "unprobed", note: "RSS, 15–20 items per feed; cached 15 min" },
    { name: "fomc_calendar", backing: "live-api", probe: "unprobed", note: "scrapes fomccalendars.htm (~165 KB); cached 6h" },
    { name: "fomc_statement", backing: "live-api", probe: "unprobed", note: "monetaryYYYYMMDDa.htm; latest resolved via calendar" },
    { name: "fed_enforcement_actions", backing: "live-api", probe: "unprobed", note: "ea-cms-recent.json (90 KB) + ea-old.json (570 KB on demand); RSS fallback" },
    { name: "treasury_auctions", backing: "live-api", probe: "unprobed", note: "FiscalData auctions_query; retried once on dropped tunnel" },
    { name: "treasury_upcoming_auctions", backing: "live-api", probe: "unprobed", note: "FiscalData upcoming_auctions; cached 30 min" },
    { name: "treasury_tic_holders", backing: "live-api", probe: "unprobed", note: "slt_table5.txt (13 months) + mfhhis01.txt history; cached 12–24h" },
    { name: "treasury_savings_bond_rates", backing: "live-api", probe: "unprobed", note: "TreasuryDirect HTML; cached 12h" },
  ],
};

export const FEDBOARD_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "fedboard: Board press feed", tool: "fed_press_releases", args: { feed: "monetary", limit: 3 }, note: "~10 KB RSS; expect latest FOMC statement/minutes items" },
  { name: "fedboard: FOMC calendar", tool: "fomc_calendar", args: { upcoming: 2 }, note: "~165 KB HTML; expect nextMeeting with daysUntilDecision" },
  { name: "fedboard: upcoming Treasury auctions", tool: "treasury_upcoming_auctions", args: { days: 10, limit: 5 }, note: "FiscalData; expect bills + any coupon auctions in the next 10 days" },
];
