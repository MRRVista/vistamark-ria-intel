/**
 * Compliance Screening family — onboarding screens for an RIA's clients,
 * prospects and counterparties. All live, keyless, cached in memory.
 *
 *   ofac_sdn_search         — fuzzy name screen vs OFAC SDN + Consolidated (non-SDN) lists
 *   ofac_sdn_status         — list publication date, counts by list/type/program
 *   fincen_msb_search       — FinCEN registered Money Services Businesses (full list export)
 *   occ_enforcement_search  — OCC enforcement actions vs national banks / thrifts / their insiders
 *   sec_pause_list          — SEC PAUSE list (unregistered soliciting entities, impersonators, fake regulators)
 *   cftc_red_list           — CFTC RED List (unregistered foreign FX/binary/crypto solicitors)
 *
 * Dropped (documented in README.md): FDIC Enforcement Decisions & Orders — the
 * orders.fdic.gov Salesforce site is unreachable from this sandbox (TLS chain
 * + 503) and exposes no documented public API.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { ofacSdnSearch, ofacSdnStatus } from "./ofac";
import { fincenMsbSearch } from "./fincen";
import { occEnforcementSearch } from "./occ";
import { secPauseList } from "./sec-pause";
import { cftcRedListSearch } from "./cftc-red";

export const COMPLIANCE_TOOLS: ToolDef[] = [
  {
    name: "ofac_sdn_search",
    description:
      "Screen a person, company, vessel or aircraft against the US Treasury OFAC sanctions lists — the SDN list plus the Consolidated non-SDN lists (SSI sectoral, Non-SDN Menu-Based, CMIC Chinese military, CAPTA, FSE, PLC). Live keyless download of OFAC's official CSV exports (~19.5k SDN + ~480 consolidated entries, aliases and addresses), cached 12h; `listPublished` shows the OFAC publication date. Fuzzy, order-insensitive name matching (diacritics/punctuation/corporate suffixes normalized; Jaro-Winkler token scoring 0–100) against primary names AND all a.k.a./f.k.a. aliases. Args: `name` (required unless `uid`), optional `type` (individual|entity|vessel|aircraft), `program` (e.g. SDGT, RUSSIA-EO14024, CUBA, IRAN), `list` (SDN|CONSOLIDATED), `country` (address country contains), `minScore` (default 80), `limit` (≤25). Returns verdict (NO_MATCH / POSSIBLE_MATCH_REVIEW / POTENTIAL_MATCH), scored matches with uid, programs, DOB/POB for individuals, aliases, addresses, remarks. Pass `uid` to fetch one full record. Use at client/prospect/counterparty onboarding and before wires; it does NOT cover EU/UN/UK lists, PEPs or adverse media.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "name to screen, any token order (e.g. 'Vladimir Putin', 'Bank Melli', 'Rosneft')" },
        uid: { type: "number", description: "OFAC ent_num to fetch one full record" },
        type: { type: "string", enum: ["individual", "entity", "vessel", "aircraft"] },
        program: { type: "string", description: "sanctions program code filter (substring, e.g. 'RUSSIA', 'SDGT')" },
        list: { type: "string", enum: ["SDN", "CONSOLIDATED"], description: "default both" },
        country: { type: "string", description: "address country filter (substring)" },
        minScore: { type: "number", default: 80, description: "minimum match score 1–100" },
        limit: { type: "number", default: 10, maximum: 25 },
      },
    },
    handler: ofacSdnSearch,
  },
  {
    name: "ofac_sdn_status",
    description:
      "Freshness and composition of the OFAC sanctions data behind ofac_sdn_search: latest OFAC publication date and ID (from the Sanctions List Service change history), Last-Modified of the SDN and Consolidated CSV files, cache age, total entries by list (SDN vs Consolidated), by type (individual/entity/vessel/aircraft) and by sanctions program (top N, default 25). Keyless, live. Use to document 'screened against OFAC list dated X' in a compliance file or to check whether the cached list is current.",
    inputSchema: {
      type: "object",
      properties: { topPrograms: { type: "number", default: 25, maximum: 200 } },
    },
    handler: ofacSdnStatus,
  },
  {
    name: "fincen_msb_search",
    description:
      "Search FinCEN's registry of Money Services Businesses (check cashers, money transmitters, currency exchangers, money-order/prepaid-access sellers and issuers) — the official full-list export from msb.fincen.gov (~34k current registrants, keyless, cached 24h). Filter by `name` (fuzzy, legal name or DBA), `state` (2-letter; also Mexican/Canadian codes), `zip` (prefix), `city`, `activity` (code 401–499 or words like 'money transmitter', 'check casher', 'prepaid'). Returns legal name, DBA, address, activities, states of operation (or All/Foreign scope), branch count and registration (authorized-signature) date, plus a verdict when screening by name. Use for client/counterparty KYC ('is this crypto exchange / remittance firm a registered MSB?'), prospecting MSB owners by zip, or AML due diligence. Only CURRENT registrations appear; absence may mean lapsed, exempt (banks, agents) or unregistered.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        state: { type: "string", description: "2-letter state code, e.g. IL" },
        zip: { type: "string", description: "5-digit zip or prefix" },
        city: { type: "string" },
        activity: { type: "string", description: "activity code or keyword" },
        minScore: { type: "number", default: 85 },
        limit: { type: "number", default: 15, maximum: 25 },
      },
    },
    handler: fincenMsbSearch,
  },
  {
    name: "occ_enforcement_search",
    description:
      "Search the OCC Enforcement Action database (apps.occ.gov/EASearch; ~6.1k actions since 1987 against national banks, federal savings associations and their officers/directors/employees, incl. legacy OTS). Live keyless JSON export, cached 12h. Filter by `name` (bank, holding company or individual — fuzzy), `state`, `type` (CMP civil money penalty, FA formal agreement, C&D, Prohibition, REST restitution, 1829, Notice, PCAD, SEC, GLBA, CD, Suspension, SASO), `since`/`until` start dates, `party` (individual|institution), `activeOnly`, `subject` (post-2012 subject matter, e.g. 'BSA/AML', 'Fair Lending', 'Flood'). Returns scored actions with party, institution/charter, location, type, penalty amount, start/termination dates, docket and PDF links, plus a by-type/active summary. Use when onboarding bank executives or vetting a bank counterparty/custodian; for bank financial condition use fdic_bank_search / fdic_bank_financials. Does not cover state banks (FDIC/Fed/state orders) or broker-dealers (FINRA).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "bank, company or individual ('Last, First' or 'First Last')" },
        state: { type: "string", description: "2-letter state" },
        type: { type: "string", description: "type code or words (e.g. 'CMP', 'prohibition', 'formal agreement')" },
        since: { type: "string", description: "earliest start date (YYYY, YYYY-MM or YYYY-MM-DD)" },
        until: { type: "string", description: "latest start date" },
        party: { type: "string", enum: ["individual", "institution"] },
        activeOnly: { type: "boolean", default: false },
        subject: { type: "string", description: "subject-matter keyword (actions since 2012)" },
        minScore: { type: "number", default: 85 },
        limit: { type: "number", default: 15, maximum: 25 },
      },
    },
    handler: occEnforcementSearch,
  },
  {
    name: "sec_pause_list",
    description:
      "Screen an entity against the SEC PAUSE list (Public Alert: Unregistered Soliciting Entities; ~1,700 names) — entities that falsely claim SEC registration or a US presence when soliciting investors, impersonators of genuine registered firms, and fictitious regulators/agencies. Scraped live from sec.gov (keyless; 17 pages, cached 24h). `name` is fuzzy-matched (domains like 'xyzfx.com' handled); optional `category` (unregistered | impersonators | fictitious regulators), `minScore` (default 80), `limit`, `details` (default true: fetches the top 5 alerts' date, claimed address/phone/website and narrative, which names the genuine firm being impersonated). Without `name` returns category counts and the first N entries. Use when a prospect mentions an unfamiliar 'advisor', when a client is pitched by an overseas firm, or to check whether YOUR firm's name is being impersonated. Complements adviser_search/FINRA checks; PAUSE is not an enforcement action list.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        category: { type: "string", description: "unregistered | impersonators | fictitious regulators" },
        minScore: { type: "number", default: 80 },
        limit: { type: "number", default: 10, maximum: 25 },
        details: { type: "boolean", default: true },
      },
    },
    handler: secPauseList,
  },
  {
    name: "cftc_red_list",
    description:
      "Screen an entity against the CFTC RED List (Registration Deficient List; ~280 foreign firms soliciting US customers for forex, binary options, precious metals or crypto derivatives without required CFTC registration). Scraped live from cftc.gov (keyless, cached 24h). `name` fuzzy-matched; `details` (default true) adds website, origin country, owner/operator and offering type for the top 5 hits. Without `name` returns the most recently added entries. Use alongside sec_pause_list when a client or prospect is being solicited by an unfamiliar offshore trading platform; RED-listing is not a finding of violation. Existing cftc_cot tools cover positioning data, not registration.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        minScore: { type: "number", default: 80 },
        limit: { type: "number", default: 10, maximum: 25 },
        details: { type: "boolean", default: true },
      },
    },
    handler: cftcRedListSearch,
  },
];

export const COMPLIANCE_DOMAIN: CatalogDomain = {
  id: "compliance",
  label: "Sanctions & Enforcement Screening (OFAC · FinCEN MSB · OCC/FDIC enforcement · SEC PAUSE)",
  source:
    "OFAC Sanctions List Service CSV exports (SDN + Consolidated), FinCEN MSB Registrant full-list export (msb.fincen.gov), OCC EASearch JSON export (apps.occ.gov), SEC PAUSE list pages (sec.gov), CFTC RED List pages (cftc.gov) — all live, keyless, cached in-memory 12–24h. FDIC Enforcement Decisions & Orders omitted (no public API; see lib/compliance/README.md)",
  tools: [
    { name: "ofac_sdn_search", backing: "live-api", probe: "unprobed", note: "6 OFAC CSVs (~9 MB) via presigned S3 redirect, cached 12h; fuzzy in-memory match" },
    { name: "ofac_sdn_status", backing: "live-api", probe: "unprobed", note: "same cache + SLS changes/history JSON for publication date" },
    { name: "fincen_msb_search", backing: "live-api", probe: "unprobed", note: "POST retrieve.msb.list.php (5.4 MB TSV), cached 24h" },
    { name: "occ_enforcement_search", backing: "live-api", probe: "unprobed", note: "ExportToJSON full list (3.4 MB), WAF answers ~half of requests with 302 — retried up to 8x; cached 12h" },
    { name: "sec_pause_list", backing: "live-api", probe: "unprobed", note: "17 Drupal pages scraped (8 concurrent), cached 24h; detail pages on demand" },
    { name: "cftc_red_list", backing: "live-api", probe: "unprobed", note: "single items_per_page=All page, cached 24h; node pages on demand" },
  ],
};

export const COMPLIANCE_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  {
    name: "compliance: OFAC SDN screen (Putin)",
    tool: "ofac_sdn_search",
    args: { name: "Vladimir Putin", type: "individual", limit: 2 },
    note: "cold ~2–4 s: 6 CSVs (~9 MB) through the SLS presigned-S3 redirect; expect uid 35096 RUSSIA-EO14024 at score 100",
  },
  {
    name: "compliance: CFTC RED list (recent entries)",
    tool: "cftc_red_list",
    args: { limit: 3 },
    note: "one ~200 KB page; expect total > 200 and a latestEntry date",
  },
  {
    name: "compliance: FinCEN MSB (Western Union)",
    tool: "fincen_msb_search",
    args: { name: "Western Union Financial Services", state: "CO", limit: 2 },
    note: "cold ~3–4 s: 5.4 MB TSV POST export; expect Denver CO registrant with money transmitter activity",
  },
];
