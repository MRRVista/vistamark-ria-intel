/**
 * Research Grants, Patents & Higher-Ed family — prominence and affluence
 * signals for individual prospects (physician-scientists, inventor-founders)
 * and institutional clients (universities, research nonprofits, federal
 * contractors).
 *
 *   nih_reporter_search        — NIH grants by PI / org / city+state / keyword (keyless)
 *   nih_reporter_publications  — PubMed IDs linked to an NIH core project (keyless)
 *   nsf_awards_search          — NSF awards by PI / awardee / keyword (keyless)
 *   grants_gov_search          — open + forecasted federal funding opportunities (keyless)
 *   patentsview_search         — US patents by inventor name+city, assignee, keyword (PATENTSVIEW_API_KEY)
 *   college_scorecard          — cost / earnings / admissions / size per school (DATA_GOV_API_KEY)
 *   sam_entity_search          — SAM.gov registrants: UEI, CAGE, NAICS, address (DATA_GOV_API_KEY)
 *
 * Complements lib/usaspending (dollars by recipient) and lib/ipeds (endowments):
 * this family answers "who are the PIs / inventors / registrants" questions.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { nihReporterSearch, nihReporterPublications } from "./nih";
import { nsfAwardsSearch } from "./nsf";
import { grantsGovSearch } from "./grantsgov";
import { patentsviewSearch } from "./patentsview";
import { collegeScorecard } from "./scorecard";
import { samEntitySearch } from "./sam";

export const GRANTS_TOOLS: ToolDef[] = [
  {
    name: "nih_reporter_search",
    description:
      "NIH RePORTER (api.reporter.nih.gov v2, live, keyless; all NIH-administered grants FY1985+, refreshed weekly). Search by PI name (pi_name any-name match, or pi_first_name/pi_last_name), organization name (substring), org city+state, keyword (title/terms/abstract), fiscal_years, award range, activity codes (R01, R44/SBIR, P30, U01…). Returns project #, core project #, PI(s) with contact-PI flag, org/department/city/UEI, FY, award amount (whole USD per FY record), institute, dates, title; plus page totals by org, PI and FY. Default sort award_amount desc, limit 15. Prospecting use: a Hinsdale physician-scientist with a funded R01 (prominence + stable academic income), an SBIR-funded biotech founder, a university or hospital client's NIH pipeline by department. For the dollars NIH sent a recipient across all federal agencies use usaspending_awards_search; for NSF use nsf_awards_search.",
    inputSchema: {
      type: "object",
      properties: {
        pi_name: { type: "string", description: "any part of a PI's name, e.g. 'Griffith' or 'James Griffith'" },
        pi_first_name: { type: "string" },
        pi_last_name: { type: "string" },
        org_name: { type: "string", description: "organization substring, e.g. 'University of Chicago', 'Northwestern', 'Advocate'" },
        city: { type: "string", description: "organization city, e.g. 'Hinsdale' (combine with state)" },
        state: { type: "string", description: "2-letter state, e.g. 'IL'" },
        keyword: { type: "string", description: "text search in title/terms/abstract (all words must match)" },
        fiscal_years: { type: "array", items: { type: "number" }, description: "e.g. [2024,2025,2026]; omit for all years" },
        min_award: { type: "number" },
        max_award: { type: "number" },
        activity_codes: { type: "string", description: "comma list, e.g. 'R01,R35' or 'R41,R42,R43,R44' for SBIR/STTR" },
        active_only: { type: "boolean", description: "only currently active projects" },
        sort: { type: "string", enum: ["award_amount", "fiscal_year", "project_start_date"], default: "award_amount" },
        limit: { type: "number", default: 15, maximum: 50 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: nihReporterSearch,
  },
  {
    name: "nih_reporter_publications",
    description:
      "NIH RePORTER publications link table (live, keyless): PubMed IDs that acknowledge a given NIH core project number (e.g. 'R01DK130963' — take coreProjectNum from nih_reporter_search), or look up which core projects a list of PMIDs cite. Returns total count and PubMed URLs; RePORTER does not return titles, so follow the URL for the paper. Use as a research-productivity signal for a PI prospect after nih_reporter_search.",
    inputSchema: {
      type: "object",
      properties: {
        core_project_num: { type: "string", description: "NIH core project number, e.g. R01DK130963" },
        pmids: { type: "string", description: "comma list of PubMed IDs (alternative to core_project_num)" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: nihReporterPublications,
  },
  {
    name: "nsf_awards_search",
    description:
      "NSF Awards API (api.nsf.gov v1, live, keyless; all NSF awards since 1976, updated daily). Search by keyword (title/abstract), PI first/last name, awardee organization (exact-phrase match), awardee city + 2-letter state, start-date window, active_only. Returns award id, title, PI (+ email when published), awardee/city/state/UEI, funds obligated to date and estimated total (whole USD), start/expiry dates, program, directorate/division, award type, total hit count, and page totals by awardee and PI. Page with offset (0-based record offset) in steps of limit (max 25); active_only filters the returned page. Use for a professor/engineer prospect's grant record, an SBIR-funded startup founder, or a university client's NSF pipeline; NIH is nih_reporter_search, all-agency dollars by recipient is usaspending_awards_search.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        pi_first_name: { type: "string" },
        pi_last_name: { type: "string" },
        awardee_name: { type: "string", description: "organization name phrase, e.g. 'University of Chicago'" },
        city: { type: "string", description: "awardee city (use with state)" },
        state: { type: "string", description: "2-letter awardee state" },
        start_date_from: { type: "string", description: "YYYY-MM-DD — awards starting on/after" },
        start_date_to: { type: "string", description: "YYYY-MM-DD" },
        active_only: { type: "boolean" },
        limit: { type: "number", default: 15, maximum: 25 },
        offset: { type: "number", default: 0, description: "0-based record offset for paging" },
      },
    },
    handler: nsfAwardsSearch,
  },
  {
    name: "grants_gov_search",
    description:
      "Grants.gov Search2 API (api.grants.gov, live, keyless; every federal discretionary funding opportunity, updated continuously). Search open and forecasted opportunities by keyword, agency codes (e.g. 'NEH|IMLS|HHS|ED|NSF'), funding_categories (e.g. 'HU' humanities, 'ED' education, 'HL' health, 'AR' arts), eligibilities, CFDA/ALN number, or statuses ('posted', 'forecasted', 'closed'). Returns opportunity id/number, title, agency, status, open/close dates, CFDA list, plus facet counts by status, agency and category. Pass opportunity_id for the full synopsis: estimated funding, award ceiling/floor, expected number of awards, cost-sharing, eligible applicant types, contact and description. Use when advising a nonprofit, museum, school or research client on fundable programs or when a client's board asks about federal grant pipelines; for grants already awarded see usaspending_awards_search / nih_reporter_search / nsf_awards_search.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string" },
        agencies: { type: "string", description: "pipe/comma list of agency codes, e.g. 'NEH|IMLS' or 'HHS'" },
        funding_categories: { type: "string", description: "codes e.g. 'HU','ED','HL','AR','CD' (community development), 'ST' (science)" },
        eligibilities: { type: "string", description: "codes e.g. '12' nonprofits w/501(c)(3), '20' private higher-ed, '06' public higher-ed, '25' others" },
        cfda: { type: "string", description: "Assistance Listing number, e.g. 45.041" },
        statuses: { type: "string", default: "forecasted|posted", description: "pipe list of posted|forecasted|closed|archived" },
        sort: { type: "string", default: "openDate|desc", description: "openDate|desc, closeDate|asc, …" },
        opportunity_id: { type: "string", description: "numeric Grants.gov id (from a prior search) for full synopsis detail" },
        limit: { type: "number", default: 15, maximum: 25 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: grantsGovSearch,
  },
  {
    name: "patentsview_search",
    description:
      "USPTO granted-patent search via the PatentsView PatentSearch API (search.patentsview.org, weekly refresh; KEYED — needs PATENTSVIEW_API_KEY, free from PatentsView; fails fast when unset). Search by inventor last name (+ first-name prefix), inventor city + state at grant (e.g. inventors living in Hinsdale, IL), assignee organization (substring), title/abstract keyword, and patent_date window. Returns patent number, title, grant date, type, forward citations, inventors with city/state, assignees, and a top-assignee tally. Prospecting use: an inventor-founder (many patents assigned to his own LLC or unassigned = personally owned IP), an engineer prospect at a large assignee, or a local-area scan of prolific inventors. Patent counts signal technical prominence, not wealth; pair with usaspending/sba tools for the company.",
    inputSchema: {
      type: "object",
      properties: {
        inventor_last_name: { type: "string" },
        inventor_first_name: { type: "string", description: "prefix match" },
        inventor_city: { type: "string", description: "inventor city on the patent, e.g. 'Hinsdale'" },
        inventor_state: { type: "string", description: "2-letter state" },
        assignee: { type: "string", description: "assignee organization substring, e.g. 'Abbott'" },
        keyword: { type: "string", description: "any word in title or abstract" },
        date_from: { type: "string", description: "YYYY-MM-DD grant date on/after" },
        date_to: { type: "string" },
        limit: { type: "number", default: 15, maximum: 50 },
      },
    },
    handler: patentsviewSearch,
  },
  {
    name: "college_scorecard",
    description:
      "U.S. Dept. of Education College Scorecard (api.data.gov/ed/collegescorecard v1; annual release; KEYED — DATA_GOV_API_KEY, free at api.data.gov/signup; fails fast when unset). Look up degree-granting schools by name substring, IPEDS unit id, zip, or city/state. Returns ownership, enrollment, admission rate, average SAT, in/out-of-state tuition, cost of attendance, average net price, median debt of completers, Pell share, completion rate, median earnings 6 and 10 years after entry, and the IPEDS endowment begin/end values for the latest year (USD; rates as decimals). Use for college-funding conversations with client families (true cost vs sticker, earnings outcomes) and as a quick profile of a university client; for multi-year endowment history and peer ranking use the ipeds endowment tools.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "school name substring, e.g. 'Northwestern University'" },
        unit_id: { type: "number", description: "IPEDS UNITID" },
        state: { type: "string" },
        city: { type: "string" },
        zip: { type: "string" },
        min_size: { type: "number", description: "minimum undergraduate enrollment" },
        degree_granting_only: { type: "boolean", default: true, description: "restrict to predominantly associate/bachelor/graduate institutions" },
        sort: { type: "string", default: "latest.student.size:desc", description: "Scorecard field:asc|desc" },
        limit: { type: "number", default: 10, maximum: 25 },
      },
    },
    handler: collegeScorecard,
  },
  {
    name: "sam_entity_search",
    description:
      "SAM.gov Entity Management API v3 (api.sam.gov; live registrations of every entity eligible for federal contracts or grants; KEYED — DATA_GOV_API_KEY; fails fast when unset; only 10 requests/day for a personal key without a SAM.gov role, 1,000/day with one). Search by legal business name (partial), UEI, CAGE, city/state, 5-digit zip, or primary NAICS; status A (active, default) or E (expired). Returns UEI, CAGE, legal/DBA name, registration purpose, activation/expiration, entity start date, legal structure, address, congressional district, primary and listed NAICS (with SBA small-business flags) and business types (e.g. nonprofit, woman-owned, veteran-owned). Prospecting use: find the federal contractors and grant-registered nonprofits in a zip, confirm a business owner's entity before a liquidity-event conversation, or get the UEI to feed usaspending_awards_search.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "legal business name (partial)" },
        uei: { type: "string", description: "12-char UEI" },
        cage: { type: "string" },
        city: { type: "string" },
        state: { type: "string", description: "2-letter state" },
        zip: { type: "string", description: "5-digit zip, e.g. 60521" },
        naics: { type: "string", description: "6-digit primary NAICS, e.g. 523940 (investment advice)" },
        status: { type: "string", enum: ["A", "E"], default: "A" },
        limit: { type: "number", default: 10, maximum: 25 },
        page: { type: "number", default: 0 },
      },
    },
    handler: samEntitySearch,
  },
];

export const GRANTS_DOMAIN: CatalogDomain = {
  id: "grants",
  label: "Research Grants, Patents & Higher-Ed (NIH · NSF · Grants.gov · PatentsView · College Scorecard)",
  source:
    "NIH RePORTER v2, NSF Awards API v1 and Grants.gov Search2 (all live, keyless); PatentsView PatentSearch (PATENTSVIEW_API_KEY); College Scorecard and SAM.gov Entity Management (DATA_GOV_API_KEY) — in-memory cache 6–24h",
  tools: [
    { name: "nih_reporter_search", backing: "live-api", probe: "unprobed", note: "POST JSON; weekly refresh; cached 12h" },
    { name: "nih_reporter_publications", backing: "live-api", probe: "unprobed", note: "PMIDs per core project; cached 24h" },
    { name: "nsf_awards_search", backing: "live-api", probe: "unprobed", note: "GET; no total count upstream; rpp ≤ 25" },
    { name: "grants_gov_search", backing: "live-api", probe: "unprobed", note: "search2 + fetchOpportunity; cached 6h" },
    { name: "patentsview_search", backing: "live-api", probe: "unprobed", note: "needs PATENTSVIEW_API_KEY; host unreachable from build sandbox — unverified live" },
    { name: "college_scorecard", backing: "live-api", probe: "unprobed", note: "needs DATA_GOV_API_KEY; verified with DEMO_KEY" },
    { name: "sam_entity_search", backing: "live-api", probe: "unprobed", note: "needs DATA_GOV_API_KEY; 10 req/day without SAM role; 404 from sandbox — unverified live" },
  ],
};

export const GRANTS_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "grants: NIH RePORTER Hinsdale IL", tool: "nih_reporter_search", args: { city: "Hinsdale", state: "IL", limit: 3 }, note: "expect ~12 project-year records (SBIR LLCs); amounts in USD" },
  { name: "grants: NSF awards Hinsdale IL", tool: "nsf_awards_search", args: { city: "Hinsdale", state: "IL", limit: 3 }, note: "expect Hinsdale Central HS teacher awards etc." },
  { name: "grants: Grants.gov NEH posted", tool: "grants_gov_search", args: { agencies: "NEH", statuses: "posted", limit: 3 }, note: "expect hitCount > 0 with open/close dates" },
  { name: "grants: College Scorecard (keyed)", tool: "college_scorecard", args: { name: "Northwestern University", limit: 2 }, note: "fails fast with 'DATA_GOV_API_KEY not configured' until the key is set" },
];
