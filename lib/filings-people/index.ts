/**
 * Filings People family — people and relationships buried in regulatory
 * filings: SEC Section 16 insiders (Forms 3/4/5), Form D related persons,
 * Form ADV Part 2 brochures, and DOL Form 5500 Schedule C service providers.
 *
 * Live: insider_transactions, insider_by_location, formd_related_persons, adv_brochures
 * Postgres (ingest via api/admin/refresh-dol-sch-c.ts, migration 0009):
 *   dol_sch_c_providers_by_plan, dol_sch_c_plans_by_provider
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { insiderByLocation, insiderTransactions } from "./insiders";
import { formdRelatedPersons } from "./formd";
import { advBrochures } from "./adv-brochures";
import { schCPlansByProvider, schCProvidersByPlan } from "./schedule-c";

export const FILPEOPLE_TOOLS: ToolDef[] = [
  {
    name: "insider_transactions",
    description:
      "SEC Section 16 insider filings (Forms 3/4/5) parsed from EDGAR ownership XML, live. Two modes: (1) ISSUER — pass ticker / issuerCik / issuerName → the company's most recent Form 4s: reporting owner name + CIK, relationship (Director / Officer + title / 10% Owner), owner address on the filing (street, city, state, ZIP), and each transaction: date, code (P=open-market buy, S=sale, A=grant, M=option exercise, F=tax withholding, G=gift...), shares, price, value, shares owned after, direct (D) vs indirect (I) ownership + nature (e.g. 'By Trust'). (2) OWNER — pass ownerCik or ownerName (EDGAR stores people as 'Last First', e.g. 'Cook Timothy') → that person's filings across ALL issuers (board seats, holdings), plus their EDGAR mailing address. " +
      "Optional ownerCity/ownerState/ownerZip keep only filings whose reporting-owner address matches (e.g. ownerZip '60521' for Hinsdale residents) — applied to the filings parsed in this call only. codes='P,S' keeps only open-market trades (liquidity events). forms='3,4,5' widens beyond Form 4. Caps at 20 filings parsed per call (maxFilings, default 6 to stay compact); sinceDate YYYY-MM-DD bounds it. " +
      "Use for: liquidity-event prospecting (large S sales), board/insider rosters, 'what does this executive own and where'. For 'which insiders live in town X' start with insider_by_location instead.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "Issuer ticker, e.g. 'AAPL'" },
        issuerCik: { type: "string", description: "Issuer CIK (any padding)" },
        issuerName: { type: "string", description: "Listed company name (resolved via SEC ticker map)" },
        ownerCik: { type: "string", description: "Reporting owner (person/entity) CIK → their filings across issuers" },
        ownerName: { type: "string", description: "Reporting owner name, EDGAR style 'Last First' (resolved via EDGAR entity search; first match used, others returned)" },
        forms: { type: "string", description: "Comma list of ownership forms, default '4' (amendments included). e.g. '3,4,5'" },
        sinceDate: { type: "string", description: "Only filings on/after YYYY-MM-DD" },
        codes: { type: "string", description: "Keep only these transaction codes, e.g. 'P,S'" },
        ownerCity: { type: "string", description: "Keep only reporting owners whose filing address city matches" },
        ownerState: { type: "string", description: "Two-letter state filter on owner address" },
        ownerZip: { type: "string", description: "5-digit ZIP filter on owner address" },
        includeHoldings: { type: "boolean", description: "Also return holdings-only rows (Form 3/5 positions), default false" },
        maxFilings: { type: "number", description: "Filings to parse, default 6, max 20" },
      },
    },
    handler: (args) => insiderTransactions(args ?? {}),
  },
  {
    name: "insider_by_location",
    description:
      "Find corporate insiders (officers, directors, 10% owners) whose SEC Form 3/4/5 filing ADDRESS is in a given town or ZIP — e.g. location 'Hinsdale' + ownerState 'IL', or '60521'. Runs EDGAR full-text search for the place name over ownership forms in a date range (default last 5 years), parses each hit's ownership XML, and keeps only reporting owners whose address actually matches (rejects false positives where the town appears elsewhere in the filing). Returns one row per verified owner: name, CIK, street address, roles, issuers (ticker/name), latest filing date, and up to 3 recent filings with transactions. " +
      "Recall limits: most insiders file c/o the company HQ, so only those who file with a home/family-office address surface; a town that hosts a public company HQ (e.g. Oak Brook) returns that company's executives. Parses at most maxFilings hits (default 20, max 30) — ftsTotalMatches shows how many exist; narrow startDate/endDate to page. Follow up on a person with insider_transactions {ownerCik}.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Town name (e.g. 'Hinsdale', 'Oak Brook') or 5-digit ZIP" },
        ownerState: { type: "string", description: "Two-letter state to verify against (recommended)" },
        ownerCity: { type: "string", description: "Override the city used for verification (defaults to location)" },
        ownerZip: { type: "string", description: "ZIP to verify against (defaults to location when it is a ZIP)" },
        forms: { type: "string", description: "Default '3,4,5'" },
        startDate: { type: "string", description: "YYYY-MM-DD, default 5 years ago" },
        endDate: { type: "string", description: "YYYY-MM-DD, default today" },
        maxFilings: { type: "number", description: "Hits to parse, default 20, max 30" },
      },
      required: ["location"],
    },
    handler: (args) => insiderByLocation(args ?? {}),
  },
  {
    name: "formd_related_persons",
    description:
      "People behind private offerings: parses SEC Form D primary_doc.xml and returns RELATED PERSONS (name, relationships: Executive Officer / Director / Promoter, clarification such as 'Managing Member of the GP', and address) plus offering economics: issuer address, industry group / fund type (hedge, PE, VC, real estate), entity type, year of incorporation, total offering amount, amount sold, minimum investment, number of investors, first-sale date, exemptions (06b, 06c, 3C.1, 3C.7), sales-compensation brokers, signer. " +
      "Modes: (a) accession — one filing; (b) issuerCik / issuerName — that issuer's latest D (filingsPerIssuer up to 5 shows the raise progressing through amendments); (c) query — EDGAR full-text search over Form D (e.g. 'Hinsdale', '\"Burr Ridge\"', a GP's name), newest first, one filing per issuer, top N parsed (limit default 8, max 10), default window last 2 years (startDate/endDate). personState/personCity keep only people at that location. " +
      "Use for: finding local founders, fund GPs and executives raising capital (liquidity / wealth signals). formd_search returns just the filing list; use this when you need the names. Form D never lists investors.",
    inputSchema: {
      type: "object",
      properties: {
        accession: { type: "string", description: "Form D accession number, e.g. '0002151710-26-000001'" },
        issuerCik: { type: "string", description: "Issuer CIK" },
        issuerName: { type: "string", description: "Issuer name (resolved via EDGAR entity search)" },
        query: { type: "string", description: "Search mode: place or name keywords over Form D full text" },
        personState: { type: "string", description: "Search mode: keep only related persons in this state" },
        personCity: { type: "string", description: "Search mode: keep only related persons in this city" },
        startDate: { type: "string", description: "Search mode: YYYY-MM-DD, default 2 years ago" },
        endDate: { type: "string", description: "Search mode: YYYY-MM-DD, default today" },
        includeAmendments: { type: "boolean", description: "Search mode: include D/A (default true)" },
        limit: { type: "number", description: "Search mode: issuers to parse, default 8, max 10" },
        filingsPerIssuer: { type: "number", description: "Issuer mode: how many recent D/D-A filings, default 1, max 5" },
      },
    },
    handler: (args) => formdRelatedPersons(args ?? {}),
  },
  {
    name: "adv_brochures",
    description:
      "Form ADV Part 2 brochures for an investment adviser from SEC IAPD, live: by CRD (or firmName → best active IAPD match, alternates listed). Returns each filed brochure (name, brochure version id, date submitted, direct PDF URL), whether the firm is Part-2 exempt, and the IAPD firm summary: legal/other names, SEC file number, scope (active/inactive), latest ADV filing date, main office address, SEC vs state registration history, notice-filing states, Form CRS id, IAPD + full ADV PDF links. " +
      "AUM / accounts / employees are attached from this app's Form ADV Part 1 ingest (firms table) when available — IAPD's JSON doesn't carry them; use search_rias for screening. extractText=true is accepted but text extraction is NOT supported (brochure PDFs need a real PDF parser; none bundled) — the response says so and returns the newest URL. Part 2B supplements are rarely filed with the SEC.",
    inputSchema: {
      type: "object",
      properties: {
        crd: { type: "string", description: "Firm CRD number, e.g. '335309'" },
        firmName: { type: "string", description: "Firm name (IAPD search) when CRD unknown" },
        extractText: { type: "boolean", description: "Attempt brochure text extraction (not supported — returns URL + reason)" },
      },
    },
    handler: (args) => advBrochures(args ?? {}),
  },
  {
    name: "dol_sch_c_providers_by_plan",
    description:
      "Who services a retirement plan: DOL Form 5500 Schedule C service providers for a plan (by ackId from dol_plan_search) or sponsor (sponsorName contains / sponsorEin) → each plan's sponsor, location, assets, participants, and its providers: name, EIN, relation (free text: RECORDKEEPER, INVESTMENT ADVISOR...), official service codes decoded (27 investment advisory to plan, 26 to participants, 28 investment management, 15/64 recordkeeping, 16/17/70 consulting, 22/33 brokerage...), direct comp and indirect comp in USD. " +
      "role filter: adviser | recordkeeper | broker | trustee | auditor | actuary | legal. limitPlans default 3, max 10 (largest plans first). sponsorName matches the sponsor OR plan name. Identifies the INCUMBENT adviser/consultant/recordkeeper on a plan. Postgres-backed — returns an empty/explanatory result until the Schedule C ingest (refresh-dol-sch-c) has run; sponsor filters also need the Form 5500 plans table for the same year. Schedule C is filed mostly by 100+ participant plans and only lists providers paid $5K+.",
    inputSchema: {
      type: "object",
      properties: {
        ackId: { type: "string", description: "DOL filing ACK_ID (from dol_plan_search)" },
        sponsorName: { type: "string", description: "Plan sponsor name contains" },
        sponsorEin: { type: "string", description: "Plan sponsor EIN" },
        state: { type: "string", description: "Sponsor state filter" },
        filingYear: { type: "number", description: "DOL file year filter" },
        role: { type: "string", description: "adviser | recordkeeper | broker | trustee | auditor | actuary | legal" },
        limitPlans: { type: "number", description: "Plans to return, default 3, max 10" },
      },
    },
    handler: (args) => schCProvidersByPlan(args ?? {}),
  },
  {
    name: "dol_sch_c_plans_by_provider",
    description:
      "Reverse lookup on DOL Form 5500 Schedule C: which plans pay a given service provider (providerName contains — normalized, suffix-insensitive — or providerEin) → plan sponsor, sponsor EIN, plan name, city/state, plan assets EOY, active participants, the provider's relation, decoded service codes, and direct/indirect comp. Filters: state, city (sponsor), minAssets (USD), role (adviser | recordkeeper | broker | trustee | auditor | actuary | legal), filingYear. Returns a summary (plan count, total comp, total plan assets) and providerNameVariants (free-text spellings + EINs — switch to providerEin once known). limit default 25, max 100; offset pages. " +
      "Prospecting payoff: a competitor RIA/consultant's book of plan clients in a state, e.g. providerName 'CAPTRUST' state 'IL' minAssets 20000000 role 'adviser'. Postgres-backed — empty until refresh-dol-sch-c runs; sponsor/assets need the Form 5500 plans table for the same year (plan assets are currently NOT populated by that ingest, so avoid minAssets and size plans by activeParticipants / comp).",
    inputSchema: {
      type: "object",
      properties: {
        providerName: { type: "string", description: "Provider name contains (e.g. 'MERCER', 'CAPTRUST')" },
        providerEin: { type: "string", description: "Provider EIN" },
        state: { type: "string", description: "Plan sponsor state" },
        city: { type: "string", description: "Plan sponsor city" },
        minAssets: { type: "number", description: "Minimum plan total assets EOY, USD" },
        role: { type: "string", description: "adviser | recordkeeper | broker | trustee | auditor | actuary | legal" },
        filingYear: { type: "number", description: "DOL file year filter" },
        limit: { type: "number", description: "Default 25, max 100" },
        offset: { type: "number", description: "Paging offset" },
      },
    },
    handler: (args) => schCPlansByProvider(args ?? {}),
  },
];

export const FILPEOPLE_DOMAIN: CatalogDomain = {
  id: "filingspeople",
  label: "Filings People (Insiders · Form D · ADV Brochures · 5500 Sch C)",
  source:
    "SEC EDGAR Forms 3/4/5 + Form D XML (data.sec.gov, sec.gov Archives, efts full-text search) · SEC IAPD (api/files.adviserinfo.sec.gov) · DOL EBSA Form 5500 Schedule C Part I Item 2 bulk files (askebsa.dol.gov FOIA) → Postgres dol_sch_c_providers",
  tools: [
    { name: "insider_transactions", backing: "live-api", probe: "unprobed" },
    {
      name: "insider_by_location",
      backing: "live-api",
      probe: "unprobed",
      note: "Recall limited to insiders who file with a home/local address; EDGAR FTS hits are re-verified against the owner address",
    },
    { name: "formd_related_persons", backing: "live-api", probe: "unprobed" },
    { name: "adv_brochures", backing: "hybrid", probe: "unprobed", note: "Live IAPD; AUM attached from local firms table when present; no PDF text extraction" },
    {
      name: "dol_sch_c_providers_by_plan",
      backing: "postgres",
      probe: "unprobed",
      note: "Empty until migration 0009 + POST /api/admin/refresh-dol-sch-c?year=YYYY",
    },
    {
      name: "dol_sch_c_plans_by_provider",
      backing: "postgres",
      probe: "unprobed",
      note: "Empty until migration 0009 + POST /api/admin/refresh-dol-sch-c?year=YYYY",
    },
  ],
};

export const FILPEOPLE_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "insider form4 AAPL (3 filings)", tool: "insider_transactions", args: { ticker: "AAPL", maxFilings: 3 } },
  { name: "adv brochures CRD 335309", tool: "adv_brochures", args: { crd: "335309" } },
  {
    name: "sch C providers by ackId (tolerates empty/missing table)",
    tool: "dol_sch_c_providers_by_plan",
    args: { ackId: "20250618101311NAL0005563682001" },
    note: "Returns empty:true with an ingest hint until refresh-dol-sch-c has run",
  },
];
