/**
 * Advisor & Broker Records family — LIVE per-person / per-firm regulatory
 * records, complementary to lib/adv (Form ADV bulk feed in Postgres).
 *
 *   brokercheck_individual_search — FINRA BrokerCheck people search (name / firm / state+city)
 *   brokercheck_individual_detail — full BrokerCheck record: employments, exams, licenses, disclosures
 *   brokercheck_firm_search       — BrokerCheck BD/IA firm search
 *   brokercheck_firm_detail       — firm profile: SEC#, type, offices, headcount, disclosures, owners
 *   iapd_individual_search        — SEC IAPD people search (IA-side view of the same engine)
 *   iapd_individual_detail        — IAPD record incl. IA state registrations + branch offices
 *   iapd_firm_detail              — IAPD firm: SEC/state registration status, notice filings, brochures, Form CRS
 *   sec_litigation_releases       — SEC Litigation Releases (RSS + filterable listing + page summaries)
 *   sec_admin_proceedings         — SEC Administrative Proceedings (RSS + filterable listing)
 *
 * All keyless. FINRA Disciplinary Actions Online was evaluated and dropped —
 * see README.md (Drupal POST webform, no JSON endpoint; api.finra.org needs a token).
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { searchIndividuals, individualDetail, searchFirms, firmDetail } from "./finra-engine";
import { enforcementFeed } from "./sec-enforcement";

const individualSearchProps = {
  query: { type: "string", description: "Person's name, e.g. 'Matthew Rice' (first + last works best). Optional when `firm` or city+state is given." },
  firm: { type: ["string", "number"], description: "Restrict to a firm by CRD number (preferred, e.g. 222520) or firm name. With an empty `query` this lists the firm's roster." },
  state: { type: "string", description: "Two-letter state of a current branch office, e.g. 'IL'" },
  city: { type: "string", description: "Branch city (requires `state`), e.g. 'Hinsdale' or 'Oak Brook'" },
  zip: { type: "string", description: "5-digit zip; applied client-side (exact zip first, then same 3-digit prefix) because the engine ignores zip" },
  activeOnly: { type: "boolean", description: "Keep only people currently registered as broker and/or adviser" },
  disclosuresOnly: { type: "boolean", description: "Keep only people with a disclosure flag" },
  limit: { type: "number", default: 12, maximum: 25 },
  start: { type: "number", default: 0, description: "offset for paging the engine results" },
};

const detailProps = {
  crd: { type: ["string", "number"], description: "Individual CRD number (from a *_individual_search result or Form ADV)" },
  maxDisclosures: { type: "number", default: 10, maximum: 40 },
  maxEmployments: { type: "number", default: 12, maximum: 40, description: "cap on current+previous employment rows returned" },
};

const enforcementProps = {
  keyword: { type: "string", description: "Respondent-name / title keyword(s), e.g. 'Advisers', 'Chicago', a person or firm name. Matched by the SEC listing search, then re-checked locally." },
  year: { type: ["number", "string"], description: "Calendar year to list (YYYY). Omit for the newest releases." },
  month: { type: ["number", "string"], description: "1–12; requires `year`" },
  since: { type: "string", description: "YYYY-MM-DD lower bound on release date" },
  until: { type: "string", description: "YYYY-MM-DD upper bound" },
  limit: { type: "number", default: 15, maximum: 25 },
  pages: { type: "number", default: 1, maximum: 3, description: "listing pages to scan (100 rows each) when filtering" },
};

export const REGULATORY_TOOLS: ToolDef[] = [
  {
    name: "brokercheck_individual_search",
    description:
      "Search FINRA BrokerCheck for a registered representative or investment adviser rep by name, firm (CRD or name), and/or branch state+city (live, keyless; same-day data from CRD/IARD). Returns CRD, name, broker/adviser status (Active / InActive / NotInScope), disclosure flag, number of FINRA registrations, years in industry, branch location and every current firm with its CRD, city/state/zip and BD vs IA role. Use for pre-meeting diligence on a prospect's current broker, confirming a rep's CRD before brokercheck_individual_detail, or pulling a competitor's roster (set `firm` to the firm CRD with no `query`, or `city`+`state` for a town such as Hinsdale, IL). This is the live per-person layer; search_advisors (lib/adv) is the bulk Form ADV table. Zip is filtered client-side because the engine ignores it.",
    inputSchema: { type: "object", properties: individualSearchProps },
    handler: (a) => searchIndividuals("brokercheck", a),
  },
  {
    name: "brokercheck_individual_detail",
    description:
      "Full FINRA BrokerCheck record for one individual CRD (live, keyless): current and previous employments with dates (BD and IA sides, most recent first), FINRA/SRO registrations and categories, state registrations (BD + IA), exams passed (Series 7/63/65/66 etc. with dates), years in industry, and every public disclosure — type (Customer Dispute, Regulatory, Criminal, Financial, Termination, Judgment/Lien, Civil), event date, resolution, allegations (trimmed), disposition/sanctions and the broker's comment. Use for compliance screens and 'what's on this person's U4/U5?' questions before a meeting; use iapd_individual_detail for the SEC-side view with branch-office addresses.",
    inputSchema: { type: "object", properties: detailProps, required: ["crd"] },
    handler: (a) => individualDetail("brokercheck", a),
  },
  {
    name: "brokercheck_firm_search",
    description:
      "Search FINRA BrokerCheck for broker-dealer and investment-adviser FIRMS by name or CRD (live, keyless). Returns firm CRD, current and former names, SEC file numbers (8- for BD, 801- for IA), BD and IA registration status, disclosure flag, branch-office count, main-office address and phone. Optional `state` keeps firms whose main office is in that state. Use to resolve a firm CRD for brokercheck_firm_detail / roster pulls, or to see which BDs a prospect's 'advisor' actually clears through; search_rias (lib/adv) remains the richer AUM/clients view for SEC-registered RIAs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Firm name (partial OK) or CRD number" },
        state: { type: "string", description: "Two-letter main-office state filter (client-side)" },
        limit: { type: "number", default: 10, maximum: 25 },
        start: { type: "number", default: 0 },
      },
      required: ["query"],
    },
    handler: (a) => searchFirms("brokercheck", a),
  },
  {
    name: "brokercheck_firm_detail",
    description:
      "FINRA BrokerCheck firm profile for one firm CRD (live, keyless): legal names, SEC numbers, BD/IA status, firm type and state/date of formation, FINRA district and size class, regulator, main and mailing addresses, phone, count of currently registered individuals (from the people index), FINRA/SEC/SRO/state registration counts, disclosure counts by type (Regulatory Event, Arbitration, Civil Event, Bond, Judgment/Lien), and direct owners/executive officers with their CRDs (first 8 by default; `owners` raises it). Use for diligence on a prospect's broker-dealer or a competing wirehouse/IBD; for SEC-registered RIAs pair with get_ria_profile (Form ADV AUM, fees) and iapd_firm_detail (registration status, brochures, Form CRS).",
    inputSchema: {
      type: "object",
      properties: {
        crd: { type: ["string", "number"], description: "Firm CRD number" },
        owners: { type: "number", default: 8, maximum: 30, description: "direct owners / officers to list (0 = none)" },
        countIndividuals: { type: "boolean", default: true, description: "also count currently registered individuals (one extra request)" },
      },
      required: ["crd"],
    },
    handler: (a) => firmDetail("brokercheck", a),
  },
  {
    name: "iapd_individual_search",
    description:
      "Search the SEC's Investment Adviser Public Disclosure (IAPD) people index by name, firm (CRD/name) and/or state+city (live, keyless). Same engine as BrokerCheck but the IA-side view: current firms listed are the investment-adviser affiliations (BD-only reps show no current firms), with IA disclosure flag and IA industry start date. Use when the person is an IAR at an RIA (fee-only advisers, dual registrants) or to pull an RIA's IAR roster (`firm` = RIA CRD, no `query`); use brokercheck_individual_search for FINRA-registered reps. Results include CRD, status, disclosure flag, years in industry, location and profileUrl on adviserinfo.sec.gov.",
    inputSchema: { type: "object", properties: individualSearchProps },
    handler: (a) => searchIndividuals("iapd", a),
  },
  {
    name: "iapd_individual_detail",
    description:
      "Full SEC IAPD record for one individual CRD (live, keyless): current IA and BD employments with registration dates and branch-office city/state, previous employments, approved IA state registrations (count + list with dates), FINRA/SRO registrations, exams (Series 65/66/7/63 etc.), years in industry and all disclosures (type, date, resolution, allegations, disposition, comment). Prefer this over brokercheck_individual_detail for IARs at RIAs (it carries the IA state-registration list and current IA branch offices); both tools return the same disclosure set.",
    inputSchema: { type: "object", properties: detailProps, required: ["crd"] },
    handler: (a) => individualDetail("iapd", a),
  },
  {
    name: "iapd_firm_detail",
    description:
      "SEC IAPD firm profile for one adviser-firm CRD (live, keyless): legal and former names, SEC 801- number, IA status, latest Form ADV filing date, SEC vs state registration status history (Approved / Terminated with effective dates), notice-filing states, exempt-reporting flags, main office, count of registered individuals, Part 2A brochure names with submission dates and a Form CRS link. Use to confirm an RIA is currently SEC- or state-registered, when it last amended its ADV, and where it is notice-filed — the live complement to get_ria_profile (bulk Form ADV: AUM, clients, fees). For broker-dealer side facts (FINRA district, owners, BD disclosures) use brokercheck_firm_detail with the same CRD.",
    inputSchema: {
      type: "object",
      properties: {
        crd: { type: ["string", "number"], description: "Adviser firm CRD number (e.g. 335309 Vistamark, 222520 Goldstone)" },
        countIndividuals: { type: "boolean", default: true },
      },
      required: ["crd"],
    },
    handler: (a) => firmDetail("iapd", { ...a, owners: 0 }),
  },
  {
    name: "sec_litigation_releases",
    description:
      "SEC Litigation Releases — federal-court enforcement actions (complaints, judgments, settlements) published by the SEC Division of Enforcement (live, keyless; new releases most business days). With no filters returns the newest 25 from the RSS feed; with `keyword` (respondent/firm name, 'Advisers', a city), `year`/`month`, or `since`/`until` it scans the filterable listing (100 rows/page, up to 3 pages). Each row: date, release number (LR-NNNNN), respondents, release URL and linked complaint/judgment PDFs. `includeSummary` fetches the release page and returns the case caption plus the opening paragraphs (first 6 rows, `summaryChars` default 600). Use for compliance screens on an adviser or firm name, 'any SEC actions against X?', and enforcement-trend context; use sec_admin_proceedings for settled administrative orders (most adviser cases).",
    inputSchema: {
      type: "object",
      properties: {
        ...enforcementProps,
        includeSummary: { type: "boolean", default: false, description: "fetch each release page for a trimmed narrative (max 6)" },
        summaryChars: { type: "number", default: 600, maximum: 1500 },
      },
    },
    handler: (a) => enforcementFeed("litigation", a),
  },
  {
    name: "sec_admin_proceedings",
    description:
      "SEC Administrative Proceedings — orders instituting or settling in-house enforcement actions, where most investment-adviser and broker-dealer cases land (live, keyless; several per business day). Same interface as sec_litigation_releases: no filters = newest 25 via RSS; `keyword` (respondent/firm name, 'Advisers', 'Capital'), `year`/`month`, `since`/`until` scan the filterable listing (100 rows/page, up to 3 pages). Each row: date, release number (IA-NNNN Advisers Act, 34-NNNNNN Exchange Act, 33- Securities Act, IC- Investment Company Act, AAER accounting), respondents, administrative file number (3-NNNNN) and the order PDF URL (PDFs are linked, not parsed). Use to screen a prospect's adviser or custodian for SEC orders and to track industry sweeps (e.g. marketing-rule, off-channel communications).",
    inputSchema: { type: "object", properties: enforcementProps },
    handler: (a) => enforcementFeed("admin", a),
  },
];

export const REGULATORY_DOMAIN: CatalogDomain = {
  id: "regulatory",
  label: "Advisor & Broker Records (BrokerCheck · IAPD · SEC enforcement)",
  source:
    "FINRA BrokerCheck API (api.brokercheck.finra.org) and SEC IAPD API (api.adviserinfo.sec.gov) — same keyless search engine, live CRD/IARD data; SEC Litigation Release and Administrative Proceeding RSS feeds + filterable listings on sec.gov. Cached in-memory 1–6h.",
  tools: [
    { name: "brokercheck_individual_search", backing: "live-api", probe: "unprobed", note: "name/firm/state+city server-side; zip client-side; always sends r=25 (state without r errors)" },
    { name: "brokercheck_individual_detail", backing: "live-api", probe: "unprobed", note: "double-encoded JSON in _source.content; cached 6h" },
    { name: "brokercheck_firm_search", backing: "live-api", probe: "unprobed", note: "BD + IA firms; address blob is stringified JSON" },
    { name: "brokercheck_firm_detail", backing: "live-api", probe: "unprobed", note: "headcount via a second people-index request" },
    { name: "iapd_individual_search", backing: "live-api", probe: "unprobed", note: "IA-side view; BD-only reps show no current firms" },
    { name: "iapd_individual_detail", backing: "live-api", probe: "unprobed", note: "_source.iacontent; includes IA state registrations + branch offices" },
    { name: "iapd_firm_detail", backing: "live-api", probe: "unprobed", note: "registrationStatus, noticeFilings, brochures, Form CRS" },
    { name: "sec_litigation_releases", backing: "live-api", probe: "unprobed", note: "RSS (25) or Drupal listing w/ populate/year/month; LR page summaries optional" },
    { name: "sec_admin_proceedings", backing: "live-api", probe: "unprobed", note: "RSS (25) or Drupal listing; order PDFs linked only" },
  ],
};

export const REGULATORY_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "regulatory: BrokerCheck person search", tool: "brokercheck_individual_search", args: { query: "Matthew Rice", state: "IL", limit: 3 }, note: "expect CRD 2946351 (Vistamark / Goldstone, Hinsdale IL) among hits" },
  { name: "regulatory: IAPD firm detail (Vistamark)", tool: "iapd_firm_detail", args: { crd: 335309, countIndividuals: false }, note: "expect SEC Approved registration, 801-136204, Hinsdale main office" },
  { name: "regulatory: SEC litigation releases RSS", tool: "sec_litigation_releases", args: { limit: 3 }, note: "~10 KB RSS; expect LR-2xxxx numbers dated within the last two weeks" },
];
