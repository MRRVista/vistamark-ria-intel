/**
 * Physicians & Health Economy family — national physician / practitioner
 * records and the public money trails around them. All live, keyless.
 *
 *   nppes_search                        — NPI Registry search (name, org, taxonomy, city/state/ZIP)
 *   nppes_lookup                        — single-NPI detail (all taxonomies, identifiers, practice locations)
 *   cms_open_payments                   — Open Payments (Sunshine Act) industry payments by NPI / name / ZIP
 *   cms_medicare_provider_utilization   — Medicare Part B billing volume by NPI, or ranked by ZIP / city / specialty
 *   cms_hospital_general_info           — Care Compare hospital directory with star ratings and ownership
 *
 * Why it exists: physicians are a dense HNW cohort (Hinsdale 60521 alone has
 * ~550 IDFPR-licensed physicians). NPPES gives the canonical professional
 * record and practice address; Open Payments and Medicare utilization are
 * public, per-person prominence/wealth signals (speaking fees, royalties,
 * ownership interests, billing scale). Practice addresses only — mailing /
 * home addresses are dropped.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { nppesSearch, nppesLookup } from "./nppes";
import { cmsOpenPayments, LATEST_PROGRAM_YEAR } from "./open-payments";
import { cmsMedicareProviderUtilization, LATEST_YEAR } from "./medicare";
import { cmsHospitalGeneralInfo } from "./hospitals";

export const HEALTHPRO_TOOLS: ToolDef[] = [
  {
    name: "nppes_search",
    description:
      "Search the national NPI Registry (CMS NPPES API v2.1; live, keyless, updated weekly) for individual practitioners (NPI-1) or organizations (NPI-2) by last/first name, organization name, taxonomy description (e.g. 'Orthopaedic Surgery', 'Dermatology', 'Internal Medicine'), city, state and/or postal_code (5-digit; trailing * wildcard allowed, e.g. '6052*'). Returns NPI, name, credential (M.D./D.O./D.D.S.), primary taxonomy with license state, PRACTICE address and phone, enumeration date and status — mailing/home addresses are omitted. Returns 12 rows by default (max 16; `fields`='brief' returns up to 45 compact rows per call) and pages via `skip`/nextSkip; the registry caps at 1,200 rows per criteria set, so narrow a whole ZIP by taxonomy or enumeration_type. Use to enumerate the physician cohort in a town, confirm a prospect's specialty/practice, or get the NPI that cms_open_payments and cms_medicare_provider_utilization key on. State alone is not a valid search; add city/ZIP/name/taxonomy.",
    inputSchema: {
      type: "object",
      properties: {
        last_name: { type: "string" },
        first_name: { type: "string", description: "nickname aliases are matched (Bill → William)" },
        organization_name: { type: "string", description: "NPI-2 legal business name (trailing * wildcard ok)" },
        taxonomy_description: { type: "string", description: "specialty words, e.g. 'Orthopaedic Surgery', 'Cardiovascular Disease', 'Plastic Surgery'" },
        city: { type: "string" },
        state: { type: "string", description: "2-letter" },
        postal_code: { type: "string", description: "5-digit ZIP (or prefix with *)" },
        enumeration_type: { type: "string", enum: ["NPI-1", "NPI-2"], description: "NPI-1 individuals, NPI-2 organizations" },
        fields: { type: "string", enum: ["standard", "brief"], default: "standard", description: "brief = npi/name/taxonomy/city/zip only (cohort enumeration, up to 45 rows per call)" },
        limit: { type: "number", default: 12, maximum: 45, description: "≤16 standard, ≤45 brief" },
        skip: { type: "number", default: 0, maximum: 1000, description: "pagination cursor from a previous nextSkip" },
      },
    },
    handler: nppesSearch,
  },
  {
    name: "nppes_lookup",
    description:
      "Full NPPES record for one 10-digit NPI (CMS NPI Registry API v2.1; live, keyless): name, credential, all taxonomies with state license numbers, practice location(s), other names (former/professional), other identifiers (Medicaid, legacy payer IDs), Direct-messaging endpoints (the domain often reveals the health system or group, e.g. dulyhealthandcare), enumeration/certification dates and deactivation status. Practice/business addresses only. Use after nppes_search or when you already have an NPI from Open Payments / Medicare data.",
    inputSchema: { type: "object", properties: { npi: { type: "string", description: "10-digit NPI" } }, required: ["npi"] },
    handler: nppesLookup,
  },
  {
    name: "cms_open_payments",
    description:
      `CMS Open Payments (Sunshine Act) general payments from drug/device manufacturers and GPOs to physicians, dentists, NPs/PAs and other covered recipients (openpaymentsdata.cms.gov DKAN datastore; live, keyless; program years 2019–${LATEST_PROGRAM_YEAR}, refreshed each June with a January update). Three modes: (1) \`npi\` → that recipient's total USD and payment-line count for program_year (default ${LATEST_PROGRAM_YEAR}; set years=3 for a multi-year total), breakdown by nature of payment (consulting, speaking fees, royalties/licenses, food & beverage, travel, ownership interest), top manufacturers, top products and the largest individual payments; (2) \`last_name\`+\`state\` (optional first_name, city) → resolves to an NPI via the Covered Recipient Profile Supplement, returning candidates when ambiguous; (3) \`zip\` → ranks recipients with a business address in that ZIP by total payments (full-table aggregate upstream: 20–60 s cold, then cached 24 h; keep limit ≤ 25). Royalty/license income, large consulting/speaking totals and physician_ownership flags are the strongest wealth signals. Amounts are USD as reported by manufacturers.`,
    inputSchema: {
      type: "object",
      properties: {
        npi: { type: "string", description: "10-digit NPI (preferred)" },
        last_name: { type: "string" },
        first_name: { type: "string" },
        state: { type: "string", description: "2-letter; required with last_name" },
        city: { type: "string", description: "narrow a name lookup" },
        zip: { type: "string", description: "5-digit ZIP ranking mode (slow)" },
        program_year: { type: "number", default: LATEST_PROGRAM_YEAR, minimum: 2019, maximum: LATEST_PROGRAM_YEAR },
        years: { type: "number", default: 1, maximum: 5, description: "number of program years back from program_year to summarize (npi mode)" },
        top: { type: "number", default: 8, maximum: 25, description: "rows per breakdown" },
        limit: { type: "number", default: 15, maximum: 25, description: "zip mode rows" },
      },
    },
    handler: cmsOpenPayments,
  },
  {
    name: "cms_medicare_provider_utilization",
    description:
      `Medicare Part B fee-for-service billing by provider from data.cms.gov 'Medicare Physician & Other Practitioners - by Provider' (annual; latest data year ${LATEST_YEAR}, released May 2026; years 2019–${LATEST_YEAR}; live, keyless). Mode 1: \`npi\` → beneficiaries, services, submitted charges, Medicare allowed/paid/standardized USD, drug vs medical split, patient avg age & HCC risk score, optional multi-year trend (years=3) and top HCPCS codes by volume (from the by-Provider-and-Service file). Mode 2: rank providers by \`zip\` (e.g. 60521), city+state, state+provider_type (CMS specialty, e.g. 'Orthopedic Surgery', 'Dermatology', 'Ophthalmology') or last_name, sorted by medicare_paid (default), services, beneficiaries or allowed; \`individuals_only\` drops organizations/ASCs. Returns practice address (no home addresses). Part B FFS only — excludes Medicare Advantage, commercial and facility revenue, so treat as a relative prominence/scale signal within a specialty, not income. Providers with ≤10 beneficiaries are suppressed by CMS.`,
    inputSchema: {
      type: "object",
      properties: {
        npi: { type: "string", description: "10-digit NPI" },
        zip: { type: "string", description: "5-digit practice ZIP" },
        city: { type: "string" },
        state: { type: "string", description: "2-letter" },
        provider_type: { type: "string", description: "CMS provider type / specialty (substring match)" },
        last_name: { type: "string", description: "starts-with match" },
        first_name: { type: "string" },
        individuals_only: { type: "boolean", default: false },
        sort: { type: "string", enum: ["medicare_paid", "services", "beneficiaries", "allowed"], default: "medicare_paid" },
        year: { type: "number", default: LATEST_YEAR, minimum: 2019, maximum: LATEST_YEAR },
        years: { type: "number", default: 1, maximum: 6, description: "npi mode: trend length" },
        include_services: { type: "boolean", default: true, description: "npi mode: include top HCPCS" },
        services_limit: { type: "number", default: 8, maximum: 25 },
        limit: { type: "number", default: 15, maximum: 25 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: cmsMedicareProviderUtilization,
  },
  {
    name: "cms_hospital_general_info",
    description:
      "Medicare-certified hospital directory from CMS Care Compare 'Hospital General Information' (data.cms.gov/provider-data dataset xubh-q36u; ~5,400 hospitals; live, keyless; refreshed quarterly). Filter by zip, zip_prefix (e.g. '605' = western Chicago suburbs), city+state, state, county, name substring, CCN, hospital_type (Acute Care, Critical Access, Psychiatric, Children's) or ownership (Voluntary non-profit, Proprietary, Government, Physician). Returns CCN, name, address, phone, type, ownership, emergency services, overall star rating (1–5) and counts of mortality/safety/readmission measures better or worse than national; `min_rating` filters client-side. Use for the hospital landscape around a prospect ZIP (e.g. UChicago Medicine AdventHealth Hinsdale is a 5-star non-profit), to identify physician-owned hospitals, or to resolve a health system's footprint in a state.",
    inputSchema: {
      type: "object",
      properties: {
        zip: { type: "string" },
        zip_prefix: { type: "string", description: "2–4 digit ZIP prefix" },
        city: { type: "string" },
        state: { type: "string", description: "2-letter" },
        county: { type: "string" },
        name: { type: "string", description: "substring, e.g. 'AdventHealth'" },
        ccn: { type: "string", description: "CMS Certification Number, e.g. 140122" },
        hospital_type: { type: "string" },
        ownership: { type: "string", description: "e.g. 'Physician', 'Proprietary', 'non-profit'" },
        min_rating: { type: "number", minimum: 1, maximum: 5 },
        limit: { type: "number", default: 20, maximum: 25 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: cmsHospitalGeneralInfo,
  },
];

export const HEALTHPRO_DOMAIN: CatalogDomain = {
  id: "healthpro",
  label: "Physicians & Health Economy (NPPES · CMS Open Payments · Medicare utilization)",
  source:
    "CMS NPPES NPI Registry API v2.1 (weekly), CMS Open Payments DKAN datastore (program years 2019–" + LATEST_PROGRAM_YEAR + "), data.cms.gov Medicare Physician & Other Practitioners by Provider / by Provider and Service (annual, 2019–" + LATEST_YEAR + "), CMS Care Compare Hospital General Information — all live, keyless, cached in-memory 6–24h",
  tools: [
    { name: "nppes_search", backing: "live-api", probe: "unprobed", note: "200/page, skip ≤ 1000; practice addresses only" },
    { name: "nppes_lookup", backing: "live-api", probe: "unprobed", note: "single NPI; Direct endpoint domain hints at employer" },
    { name: "cms_open_payments", backing: "live-api", probe: "unprobed", note: "NPI mode ~2–4 s; ZIP ranking is a 20–60 s upstream aggregate, cached 24h" },
    { name: "cms_medicare_provider_utilization", backing: "live-api", probe: "unprobed", note: "data-api filter/sort; by-Provider + top HCPCS from by-Provider-and-Service" },
    { name: "cms_hospital_general_info", backing: "live-api", probe: "unprobed", note: "provider-data DKAN datastore xubh-q36u" },
  ],
};

export const HEALTHPRO_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "healthpro: NPPES orthopaedic surgeons in 60521", tool: "nppes_search", args: { postal_code: "60521", taxonomy_description: "Orthopaedic Surgery", enumeration_type: "NPI-1", limit: 5 }, note: "expect a handful of M.D.s with Hinsdale practice addresses" },
  { name: "healthpro: Medicare top billers in 60521", tool: "cms_medicare_provider_utilization", args: { zip: "60521", limit: 3 }, note: `data year ${LATEST_YEAR}; expect ~400 matched rows, top row > $1M Medicare paid` },
  { name: "healthpro: hospitals in Hinsdale IL", tool: "cms_hospital_general_info", args: { zip: "60521" }, note: "expect UChicago Medicine AdventHealth Hinsdale, 5-star non-profit" },
];
