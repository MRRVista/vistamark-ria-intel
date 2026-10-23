/**
 * Web-intel family — open-web signals about a prospect, firm or topic:
 *
 *   gdelt_doc_search        — GDELT DOC 2.0 global news index (artlist / timelinevol)
 *   news_rss_search         — Google News RSS + Bing News RSS, deduped, trimmed
 *   wikidata_entity_search  — Wikidata item search + key claims (occupation, employer, net worth, founders…)
 *   wikipedia_summary       — English Wikipedia lead extract, description, thumbnail
 *   courtlistener_search    — CourtListener v4 search: RECAP federal dockets or case-law opinions
 *   opencorporates_search   — OpenCorporates company registry search (KEYED)
 *   opencorporates_officers — OpenCorporates officer-by-name search (KEYED)
 *
 * Illinois SOS CyberDrive business search was evaluated and dropped — see README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { gdeltDocSearch } from "./gdelt";
import { newsRssSearch } from "./news";
import { wikidataEntitySearch, wikipediaSummary } from "./wikimedia";
import { courtlistenerSearch } from "./courtlistener";
import { opencorporatesOfficers, opencorporatesSearch } from "./opencorporates";

export const WEBINTEL_TOOLS: ToolDef[] = [
  {
    name: "gdelt_doc_search",
    description:
      "Search the GDELT DOC 2.0 global online-news index (keyless; monitors news in 65 languages, refreshed every 15 minutes, rolling 3-month window). mode 'artlist' (default) returns up to 25 recent articles (title, url, domain, date, language, source country) newest-first; mode 'timelinevol' returns the share of worldwide coverage matching the query over time — use it to spot a news spike about a firm or person. `query` supports quoted phrases, OR, and is auto-quoted for multi-word names; narrow with `domain` (e.g. wsj.com), `sourceCountry` (e.g. US), `sourceLang` (e.g. english) or `toneFilter` ('tone<-5' = negative coverage). `timespan`: 15min..3m (default 1w). GDELT rate-limits to one call per 5 s per IP, so avoid firing it in a loop; for headline-grade US coverage with source names prefer news_rss_search, and for ticker-specific news use eodhd_news.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "keywords / quoted phrase / boolean, e.g. '\"Vista Equity\" OR \"Robert F. Smith\"'" },
        mode: { type: "string", enum: ["artlist", "timelinevol"], default: "artlist" },
        timespan: { type: "string", default: "1w", description: "e.g. 24h, 7d, 2w, 1m, 3m" },
        limit: { type: "number", default: 15, maximum: 25 },
        sort: { type: "string", enum: ["date", "relevance"], default: "date" },
        domain: { type: "string", description: "restrict to one source domain" },
        sourceCountry: { type: "string", description: "GDELT country name/FIPS, e.g. US, UnitedKingdom" },
        sourceLang: { type: "string", description: "e.g. english, spanish" },
        toneFilter: { type: "string", description: "e.g. 'tone<-5' (negative) or 'tone>5' (positive)" },
      },
      required: ["query"],
    },
    handler: gdeltDocSearch,
  },
  {
    name: "news_rss_search",
    description:
      "Recent news headlines for any name or topic from Google News RSS and Bing News RSS (both keyless, live; typically the last few weeks, up to ~100 items per provider). Returns deduped items newest-first: title, url, source/publisher, published time (UTC) and a short snippet where Bing supplies one. `query` accepts Google-style operators (quotes, OR, site:); `sinceDays` restricts to the last N days (also adds Google's when:Nd); `provider` google | bing | both (default). Use this as the default 'any news on <prospect / firm / foundation>?' tool before a call or outreach draft; use gdelt_doc_search for multilingual/global volume and trends, eodhd_news for ticker-tagged financial news, and web_search for non-news web pages.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 15, maximum: 25 },
        sinceDays: { type: "number", description: "only items published within the last N days (1-365)" },
        provider: { type: "string", enum: ["google", "bing", "both"], default: "both" },
      },
      required: ["query"],
    },
    handler: newsRssSearch,
  },
  {
    name: "wikidata_entity_search",
    description:
      "Look up a person, company, foundation or family office in Wikidata (keyless, live, community-maintained; strongest for public figures and notable firms, thin for private individuals). Pass `query` (name) or a known `id` (e.g. Q7936440). Returns up to `limit` candidate items (QID, label, description) and, for the top match, structured key claims resolved to English labels: instance of, occupation, employer, educated at, net worth (USD, with as-of date), founded by, CEO/chair, headquarters, inception, industry, parent/owner, official website, birth date/place, residence, citizenship, spouse/children, positions held, LinkedIn/Twitter ids, plus the English Wikipedia link. Use for quick biographical/corporate facts and to find the right Wikipedia title; use wikipedia_summary for prose and web_search when the subject is not notable enough for Wikidata.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "entity name, e.g. 'Robert F. Smith' or 'Vista Equity Partners'" },
        id: { type: "string", description: "Wikidata QID to fetch directly" },
        limit: { type: "number", default: 5, maximum: 10 },
        claims: { type: "boolean", default: true, description: "false = candidates only, no claim fetch" },
      },
    },
    handler: wikidataEntitySearch,
  },
  {
    name: "wikipedia_summary",
    description:
      "English Wikipedia lead section for an article title (keyless, live REST summary with an action-API fallback when Wikimedia throttles). Returns the normalized title, one-line description, the intro extract (plain text, ≤ 1,200 chars, `maxChars` to shorten), thumbnail image url, canonical page url, the Wikidata QID and last-modified time; redirects are followed and a near-miss title falls back to the top search hit (noted). Use for a neutral background paragraph on a notable prospect, firm, university or foundation before a meeting; pair with wikidata_entity_search for structured facts.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "article title, e.g. 'Vista Equity Partners' or 'Robert F. Smith (investor)'" },
        maxChars: { type: "number", default: 1200, maximum: 1200 },
      },
      required: ["title"],
    },
    handler: wikipediaSummary,
  },
  {
    name: "courtlistener_search",
    description:
      "Litigation search on CourtListener (Free Law Project; live). `type` 'r' (default) searches RECAP — the public mirror of federal PACER dockets (civil, bankruptcy, criminal): case name, court, date filed/terminated, docket number, nature of suit, cause, parties, first-document snippet. `type` 'o' searches published case-law opinions from federal and state courts: case name, court, date, docket, citations, status, snippet. Quote exact names in `query` (\"Vista Equity Partners\"); narrow with `court` (CourtListener slugs, e.g. 'ilnd' N.D. Ill., 'ill' Ill. Supreme Court, space-separated for several) and `filedAfter`/`filedBefore` (YYYY-MM-DD); `sort` date (default) or relevance. Anonymous use is allowed but throttled per IP; set COURTLISTENER_TOKEN (free account) for 5,000 requests/day. Use for pre-engagement diligence on a prospect, their business or a counterparty; it does not cover most state trial-court dockets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["r", "o"], default: "r", description: "r = RECAP federal dockets, o = case-law opinions" },
        court: { type: "string", description: "court slug(s), e.g. 'ilnd' or 'ilnd ilcd ilsd'" },
        filedAfter: { type: "string", description: "YYYY-MM-DD" },
        filedBefore: { type: "string", description: "YYYY-MM-DD" },
        sort: { type: "string", enum: ["date", "relevance"], default: "date" },
        limit: { type: "number", default: 10, maximum: 20 },
      },
      required: ["query"],
    },
    handler: courtlistenerSearch,
  },
  {
    name: "opencorporates_search",
    description:
      "Search company registrations across 140+ corporate registries via OpenCorporates (KEYED: requires OPENCORPORATES_API_TOKEN; the free anonymous tier was discontinued, so the tool fails fast without a key). Returns for each match the registered name, company number, jurisdiction (e.g. us_il), current status, company type, incorporation/dissolution dates, registered address, the source-registry URL and the OpenCorporates page/officers link. `jurisdiction` accepts a bare US state code ('il' → us_il) or an OpenCorporates code; `inactive:false` hides dissolved entities. Use to confirm a prospect's LLC/holding-company footprint or an RIA's legal entity; for SEC-registered advisers use search_rias / get_ria_profile, for LEIs use gleif_entity_search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "company name" },
        jurisdiction: { type: "string", description: "e.g. 'il', 'us_de', 'gb'" },
        inactive: { type: "boolean", description: "false = active entities only" },
        limit: { type: "number", default: 10, maximum: 25 },
      },
      required: ["query"],
    },
    handler: opencorporatesSearch,
  },
  {
    name: "opencorporates_officers",
    description:
      "Find companies where a named person is a registered officer, director, manager or registered agent, via OpenCorporates officers search (KEYED: OPENCORPORATES_API_TOKEN required; fails fast without it). Returns officer name as filed, position, start/end dates, jurisdiction, company name/number and links. Optional `jurisdiction` (e.g. 'il') and `position` (e.g. 'manager', 'director'). Coverage depends on which registries publish officer data (Illinois publishes president/secretary/agent; Delaware does not). Use to map a prospect's business interests before outreach; pair with opencorporates_search on each company found.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "person name, e.g. 'Matthew Rice'" },
        jurisdiction: { type: "string" },
        position: { type: "string" },
        limit: { type: "number", default: 10, maximum: 25 },
      },
      required: ["name"],
    },
    handler: opencorporatesOfficers,
  },
];

export const WEBINTEL_DOMAIN: CatalogDomain = {
  id: "webintel",
  label: "News, Entities & Courts (GDELT · Google News RSS · Wikidata/Wikipedia · CourtListener · OpenCorporates)",
  source:
    "GDELT DOC 2.0 API, Google News + Bing News RSS, Wikidata (EntityData/SPARQL) + English Wikipedia, CourtListener REST v4 (optional COURTLISTENER_TOKEN), OpenCorporates v0.4 (OPENCORPORATES_API_TOKEN required) — live, cached in-memory 10 min–12 h",
  tools: [
    { name: "gdelt_doc_search", backing: "live-api", probe: "unprobed", note: "keyless; 1 req / 5 s per IP, single backoff retry; cached 15 min" },
    { name: "news_rss_search", backing: "live-api", probe: "unprobed", note: "Google News needs a browser UA; Bing accepts Vistamark UA; cached 10 min" },
    { name: "wikidata_entity_search", backing: "live-api", probe: "unprobed", note: "api.php often 429s shared IPs; falls back to enwiki search + Special:EntityData + SPARQL" },
    { name: "wikipedia_summary", backing: "live-api", probe: "unprobed", note: "REST summary with action-API extract fallback; cached 12 h" },
    { name: "courtlistener_search", backing: "live-api", probe: "unprobed", note: "anonymous throttled per IP (sandbox saw 429s); COURTLISTENER_TOKEN lifts to 5k/day" },
    { name: "opencorporates_search", backing: "live-api", probe: "unprobed", note: "KEYED — anonymous calls return 401; needs OPENCORPORATES_API_TOKEN" },
    { name: "opencorporates_officers", backing: "live-api", probe: "unprobed", note: "KEYED — same token; officer coverage varies by registry" },
  ],
};

export const WEBINTEL_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "webintel: Bing/Google news RSS", tool: "news_rss_search", args: { query: "Vista Equity Partners", limit: 3, provider: "bing" }, note: "Bing RSS only (Google is browser-UA gated and slower); expect ≥1 item with source + pubDate" },
  { name: "webintel: Wikipedia summary", tool: "wikipedia_summary", args: { title: "Vista Equity Partners", maxChars: 300 }, note: "REST summary or action-API fallback; expect description 'American investment firm'" },
  { name: "webintel: Wikidata claims", tool: "wikidata_entity_search", args: { id: "Q7936440" }, note: "direct QID path (no search call); expect foundedBy incl. Robert F. Smith, officialWebsite" },
];
