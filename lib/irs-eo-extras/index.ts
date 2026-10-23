/**
 * IRS EO Extras family — Publication 78 · Automatic Revocation · 990-N e-Postcard.
 *
 *   irs_pub78_lookup          — is this EIN / org eligible for deductible gifts, and under which limit (PC 50%, PF 30%, SO…)?
 *   irs_revocation_search     — orgs that lost exemption under 6033(j), with reinstatement flag
 *   irs_990n_search           — small (<= $50K) orgs by name / place / officer / tax year
 *   irs_990n_officers_search  — principal officers of small orgs by surname + state/zip (prospect index)
 *   irs_eo_extras_status      — row counts + last load per dataset
 *
 * Backing: Postgres tables from migrations/0011_irs_eo_extras.sql, loaded
 * monthly by .github/workflows/irs-eo-extras-ingest.yml (scripts/irs-eo-extras-ingest.ts).
 * Every query is to_regclass-guarded, so the tools answer clean-empty until
 * the migration and first load land. See README.md for the file layouts.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import {
  irsPub78Lookup,
  irsRevocationSearch,
  irs990nSearch,
  irs990nOfficersSearch,
  irsEoExtrasStatus,
} from "./queries";

export { PUB78_CODES, decodePub78 } from "./queries";

const einProp = { oneOf: [{ type: "string" }, { type: "number" }], description: "EIN as 9 digits or 'XX-XXXXXXX'" };

export const IRSEOX_TOOLS: ToolDef[] = [
  {
    name: "irs_pub78_lookup",
    description:
      "Deductibility check against IRS Publication 78 (Tax Exempt Organization Search bulk file, ingested monthly; keyless). Give an EIN, or a name plus state, and get whether the org is currently eligible to receive tax-deductible charitable contributions and under which code(s), decoded: PC = public charity (50%/60% AGI limit), PF = private foundation (30%), POF = private operating foundation, SO/SONFI/SOUNK = supporting organization types (SONFI is excluded from most DAF and private-foundation grants), EO = other 170(c) org, GROUP, LODGE, FORGN, UNKWN. When an EIN is NOT listed the result says why when it can (latest auto-revocation, 990-N filer, BMF row). Use this before advising a client gift or DAF grant; use irs_eo_lookup for the full BMF record and irs990_filing_get for financials.",
    inputSchema: {
      type: "object",
      properties: {
        ein: einProp,
        name: { type: "string", description: "Org name (fuzzy, trigram). Pair with state." },
        state: { type: "string", description: "2-letter state, narrows a name search" },
        city: { type: "string" },
        limit: { type: "number", default: 10, maximum: 25 },
      },
    },
    handler: irsPub78Lookup,
  },
  {
    name: "irs_revocation_search",
    description:
      "Search the IRS Automatic Revocation of Exemption list (orgs that lost tax-exempt status under IRC 6033(j) for three consecutive missed 990/990-EZ/990-N filings; ~1.25M rows since 2010, refreshed monthly; keyless). Filter by EIN, name (fuzzy), state, city, zip, exemption type (BMF subsection: 3 = 501(c)(3)), revocation date range (YYYY, YYYY-MM or YYYY-MM-DD), and reinstated true/false. Returns revocation date, IRS posting date, reinstatement date and a reinstated flag. Use for diligence on a grantee or prospect org ('was this charity ever revoked?'), to spot a client's dormant family foundation before it is revoked, or to list recent revocations in a state. Needs at least one filter.",
    inputSchema: {
      type: "object",
      properties: {
        ein: einProp,
        name: { type: "string" },
        state: { type: "string" },
        city: { type: "string" },
        zip: { type: "string", description: "5-digit prefix match" },
        exemptionType: { oneOf: [{ type: "string" }, { type: "number" }], description: "BMF subsection code, e.g. 3 or '03' for 501(c)(3)" },
        revokedFrom: { type: "string", description: "inclusive, YYYY / YYYY-MM / YYYY-MM-DD" },
        revokedTo: { type: "string" },
        reinstated: { type: "boolean", description: "true = only orgs later reinstated; false = still revoked" },
        sortBy: { type: "string", enum: ["revocation_date", "posting_date", "name"], default: "revocation_date" },
        limit: { type: "number", default: 25, maximum: 100 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: irsRevocationSearch,
  },
  {
    name: "irs_990n_search",
    description:
      "Search 990-N e-Postcard filers — the ~1.5M small exempt orgs with gross receipts normally <= $50K that file no 990/990-EZ (IRS TEOS bulk file, each org's most recent postcard; refreshed monthly; keyless). Filter by EIN, org name (fuzzy), state, city, zip, principal-officer name (fuzzy), tax year or minimum tax year, hasWebsite; terminated filers excluded by default. Returns tax year, period, under-$50K flag, website, principal officer name with officer city/state/zip (street address withheld), org city/state/zip, DBAs. These orgs are invisible to irs990_filing_search; use this for local small-org landscape (booster clubs, PTOs, scholarship funds, small family foundations) and irs_990n_officers_search for the people angle. Needs at least one filter.",
    inputSchema: {
      type: "object",
      properties: {
        ein: einProp,
        name: { type: "string" },
        state: { type: "string" },
        city: { type: "string" },
        zip: { type: "string", description: "5-digit prefix match on the org zip" },
        officerName: { type: "string", description: "fuzzy match on the principal officer" },
        taxYear: { type: "number" },
        minTaxYear: { type: "number", description: "e.g. 2024 to keep only recently active filers" },
        includeTerminated: { type: "boolean", default: false },
        hasWebsite: { type: "boolean", default: false },
        limit: { type: "number", default: 25, maximum: 100 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: irs990nSearch,
  },
  {
    name: "irs_990n_officers_search",
    description:
      "Principal officers of 990-N (<= $50K receipts) filers by surname or full name, scoped to a state and/or zip — the small-organization counterpart of irs990_people_search, and a secondary board/officer prospect index (e.g. every small-org officer in Hinsdale IL 60521). Matches the officer's own mailing city/state/zip (street withheld) or, failing that, the org's. Returns the org name, tax year of the last postcard, and officer city/state/zip. Surname = last token of the free-text name; pass `name` for multi-word surnames. Requires state or zip; with a zip alone it lists every small-org officer in that zip (newest filers first). Refreshed monthly from the IRS TEOS bulk file; keyless.",
    inputSchema: {
      type: "object",
      properties: {
        surname: { type: "string", description: "last name, exact (case-insensitive)" },
        name: { type: "string", description: "full name, fuzzy (trigram)" },
        state: { type: "string" },
        zip: { type: "string", description: "5-digit prefix" },
        city: { type: "string" },
        minTaxYear: { type: "number", description: "e.g. 2023 for currently active officers" },
        limit: { type: "number", default: 25, maximum: 100 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: irs990nOfficersSearch,
  },
  {
    name: "irs_eo_extras_status",
    description:
      "Health of the IRS EO extras tables (Pub 78, Auto-Revocation, 990-N): whether migration 0011 is applied, row counts per table, the latest load per dataset from the irs_eo_extras_loads ledger (status, rows, rejects, source Last-Modified, runner), 990-N filers by tax year and revocations by year. Zero rows with migrationApplied:true means the monthly 'IRS EO extras ingest' GitHub Actions workflow has not run yet. Use when the three irs_pub78_/irs_revocation_/irs_990n_ tools return nothing.",
    inputSchema: { type: "object", properties: {} },
    handler: irsEoExtrasStatus,
  },
];

export const IRSEOX_DOMAIN: CatalogDomain = {
  id: "irseox",
  label: "IRS EO Extras (Pub 78 · Auto-Revocation · 990-N e-Postcard officers)",
  source: "IRS Tax Exempt Organization Search bulk downloads — Publication 78, Automatic Revocation list, 990-N e-Postcard filers (ingested monthly via GitHub Actions; migration 0011)",
  tools: [
    { name: "irs_pub78_lookup", backing: "postgres", probe: "unprobed", note: "Deductibility status + decoded codes (PC/PF/SO…). Empty until the 'IRS EO extras ingest' workflow first runs; explains a miss via revocation / 990-N / BMF context." },
    { name: "irs_revocation_search", backing: "postgres", probe: "unprobed", note: "6033(j) auto-revocations since 2010 with reinstatement flag; (ein, revocation_date) keyed." },
    { name: "irs_990n_search", backing: "postgres", probe: "unprobed", note: "Most recent e-Postcard per EIN (~1.5M). Officer street address stored but never emitted." },
    { name: "irs_990n_officers_search", backing: "postgres", probe: "unprobed", note: "Secondary board-member index for orgs too small to file a 990; requires state or zip." },
    { name: "irs_eo_extras_status", backing: "postgres", probe: "unprobed", note: "Ledger + counts; safe before migration 0011 (reports migrationApplied:false)." },
  ],
};

export const IRSEOX_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "irseox: status", tool: "irs_eo_extras_status", args: {}, note: "to_regclass-guarded; before migration 0011 expect migrationApplied:false, afterwards three row counts + latest loads" },
  { name: "irseox: Pub 78 by EIN (American Red Cross)", tool: "irs_pub78_lookup", args: { ein: "53-0196605" }, note: "PK lookup; expect eligible:true with code PC once loaded, tableReady:false before" },
  { name: "irseox: 990-N officers Hinsdale 60521", tool: "irs_990n_officers_search", args: { zip: "60521", state: "IL", minTaxYear: 2023, limit: 5 }, note: "indexed (officer_state, officer_zip) scan; expect a handful of small-org officers once loaded" },
];
