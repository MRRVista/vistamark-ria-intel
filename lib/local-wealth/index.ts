/**
 * Local Wealth family — Hinsdale-area (60521; DuPage + Cook, IL) wealth signals and
 * low-cost professional contact tools.
 *
 *   cook_parcel_sales      — Cook Assessor Parcel Sales + addresses + residential characteristics (Socrata, no key)
 *   dupage_parcel_sales    — IDOR PTAX-203 filtered to DuPage, joined to DuPage GIS parcels (no key)
 *   il_ptax_transfers      — IDOR PTAX-203 transfer declarations statewide (data.illinois.gov, no key)
 *   idfpr_licensee_search  — IDFPR Professional Licensing (data.illinois.gov, no key)
 *   hunter_domain_search / hunter_email_finder / hunter_email_verifier / hunter_account — HUNTER_API_KEY
 *   zerobounce_validate / zerobounce_credits — ZEROBOUNCE_API_KEY
 *
 * Not built (see README.md): Illinois SOS business entity search (no free API; bulk data
 * is sold), ARDC attorney search (no API). FEC contribution data is deliberately excluded.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { cookParcelSales } from "./cook";
import { ilPtaxTransfers, dupageParcelSales } from "./ptax";
import { idfprLicenseeSearch, IDFPR_PRESETS } from "./idfpr";
import {
  hunterDomainSearch,
  hunterEmailFinder,
  hunterEmailVerifier,
  hunterAccount,
  zerobounceValidate,
  zerobounceCredits,
} from "./contact";

const dateProps = {
  startDate: { type: "string", description: "YYYY-MM-DD inclusive. Area scans default to 12 months ago; PIN/address/name lookups default to full history." },
  endDate: { type: "string", description: "YYYY-MM-DD inclusive." },
};

const ptaxProps = {
  city: { type: "string", description: "Property city as written on the form, e.g. HINSDALE, OAK BROOK, BURR RIDGE, CLARENDON HILLS, WESTERN SPRINGS (case-insensitive)." },
  zip: { type: "string", description: "5-digit zip, e.g. 60521 (form zips are 9-digit; prefix-matched)." },
  township: { type: "string", description: "Township name on the form, e.g. Downers Grove, York, Lyons." },
  pin: { type: ["string", "array"], items: { type: "string" }, description: "Primary PIN(s), any punctuation: DuPage 10-digit (09-12-129-011), Cook 14-digit." },
  address: { type: "string", description: "Street fragment, e.g. '33 EAST 1ST' (matched against the full situs address)." },
  buyerName: { type: "string", description: "Substring of the grantee name (case-insensitive), e.g. a surname or trust name." },
  sellerName: { type: "string", description: "Substring of the grantor name." },
  ...dateProps,
  minPrice: { type: "number", description: "Min full consideration (line 11), $. Area scans default to $10,000. When set (and no pin/address), results sort by price DESC instead of date." },
  maxPrice: { type: "number" },
  useCodes: {
    type: "array",
    items: { type: "string", enum: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"] },
    description: "Form line 8 current use: A land, B residence (SFR/condo/townhome), C mobile home, D apt ≤6, E apt >6, F office, G retail, H commercial, I industrial, J farm, K other.",
  },
  principalResidenceOnly: { type: "boolean", description: "Only transfers where the buyer declared it their principal residence (line 6) — i.e. the buyer is moving in." },
  marketOnly: { type: "boolean", description: "Exclude related-party, partial-interest, court-ordered, in-lieu-of-foreclosure, condemnation and short-sale transfers. Default true for area scans, false for pin/address/name lookups." },
  limit: { type: "number", default: 25, maximum: 200 },
};

export const LOCALWEALTH_TOOLS: ToolDef[] = [
  {
    name: "cook_parcel_sales",
    description:
      "Cook County, IL recorded property sales (Cook County Assessor open data, live, no key): sale date, price, deed type, document number, BUYER and SELLER names (from MyDec/PTAX, present on most arm's-length sales since 2013), property class and township — joined to the parcel's situs address, current owner-of-record and taxpayer names (latest roll) and residential characteristics (year built, building/land sq ft, beds, baths, style, quality). Look up by pin (10/14 digit, any punctuation), by address fragment (e.g. '603 JUSTINA', optionally with city), or scan an area by city/zip (e.g. city:'HINSDALE' or zip:'60521' → the ~1,090 Cook-side Hinsdale parcels) or township (e.g. 'Lyons', 'New Trier'), with startDate/endDate (area scans default to last 12 months), minPrice/maxPrice, deedTypes (Warranty, Trustee, Executor, Quit claim, Other), buyerName/sellerName substrings. Area scans drop sub-$10k and non-arm's-length deed rows unless includeFiltered=true. Use case: recent $1.5M+ buyers in Cook-side Hinsdale/Western Springs/LaGrange = liquidity-event and new-resident prospects; sellers = money in motion. Data lags recording by ~2 months — for last-week recordings use il_ptax_transfers (county 'Cook'); for the DuPage side of Hinsdale use dupage_parcel_sales. Names are as recorded (land trusts / LLCs common).",
    inputSchema: {
      type: "object",
      properties: {
        pin: { type: ["string", "array"], items: { type: "string" }, description: "Cook PIN(s): 14-digit or 10-digit, dashes OK." },
        address: { type: "string", description: "Situs street fragment, roll spelling (abbreviated suffixes ST/AVE/RD)." },
        city: { type: "string", description: "Situs city (e.g. HINSDALE, WESTERN SPRINGS, LA GRANGE, BURR RIDGE). Cities over 6,000 parcels (Chicago) are refused — use township." },
        zip: { type: "string", description: "Situs 5-digit zip, e.g. 60521." },
        township: { type: "string", description: "Cook township name or 2-digit code (Lyons=21 covers Cook-side Hinsdale, Western Springs, LaGrange, Burr Ridge)." },
        ...dateProps,
        minPrice: { type: "number", description: "Min sale price $." },
        maxPrice: { type: "number" },
        deedTypes: { type: "array", items: { type: "string" }, description: "Warranty, Trustee, Executor, Quit claim, Other." },
        buyerName: { type: "string" },
        sellerName: { type: "string" },
        includeFiltered: { type: "boolean", description: "Keep sub-$10k and non-arm's-length deed rows (default false for area scans)." },
        includeCharacteristics: { type: "boolean", default: true },
        includeAddresses: { type: "boolean", default: true },
        limit: { type: "number", default: 25, maximum: 200 },
      },
    },
    handler: cookParcelSales,
  },
  {
    name: "dupage_parcel_sales",
    description:
      "DuPage County, IL property sales (live, no key). DuPage publishes no open sale-price layer, so this queries the Illinois Dept of Revenue PTAX-203 transfer declarations (weekly, ~1 week lag, since 2013) filtered to DuPage, and joins each primary PIN to DuPage GIS ParcelsWithRealEstateCC for the CURRENT tax-bill name and mailing address, property class (R residential) and assessed value (×3 ≈ market value). Returns recorded date, full consideration (sale price), instrument type, buyer and seller names (+ additional buyers), principal-residence flag, use code, non-market flags. Filter by city (HINSDALE, OAK BROOK, CLARENDON HILLS, BURR RIDGE, WESTMONT, DOWNERS GROVE…), zip (60521, 60523, 60514), township (Downers Grove, York), pin, address, buyerName/sellerName, dates, price band, useCodes, principalResidenceOnly. Default area scan: last 12 months, ≥$10k, market transfers only, newest first (set minPrice to sort by price). Use case: who just bought/sold a $2M+ Hinsdale home — new-resident and liquidity-event prospects. Cook-side Hinsdale is in cook_parcel_sales. County GIS terms: internal use only.",
    inputSchema: { type: "object", properties: { ...ptaxProps, includeParcel: { type: "boolean", default: true, description: "Join DuPage GIS parcel detail." } } },
    handler: dupageParcelSales,
  },
  {
    name: "il_ptax_transfers",
    description:
      "Illinois PTAX-203 Real Estate Transfer Declarations, statewide incl. Cook (IL Dept of Revenue via data.illinois.gov, live, no key; every declaration since 2013-01-01, refreshed weekly, newest recordings ~1 week old). Returns declaration id, document number, recorded and instrument dates, situs address, county, township, primary PIN, full and net consideration (sale price), instrument type (Warranty Deed, Trustee Deed, Deed in Trust, Executor Deed…), line-8 use code, principal-residence flag, new-construction flag, BUYER and SELLER names (+ additional buyers) and non-market circumstance flags. Filter by county (DuPage, Cook, Lake, Will, Kane, McHenry…), city, zip, township, pin, address, buyerName/sellerName, dates, price band, useCodes, principalResidenceOnly, marketOnly. Use for the freshest sales anywhere in IL, for name-based lookups ('did the Smith trust buy anything?'), or for collar counties beyond DuPage. For DuPage with current-owner/assessed-value join use dupage_parcel_sales; for Cook with building characteristics use cook_parcel_sales. Buyer mailing addresses are not published.",
    inputSchema: {
      type: "object",
      properties: { county: { type: "string", description: "County name, e.g. DuPage, Cook, Lake, Will, Kane, McHenry." }, ...ptaxProps },
    },
    handler: ilPtaxTransfers,
  },
  {
    name: "idfpr_licensee_search",
    description:
      `Illinois professional licensees (IDFPR Professional Licensing on data.illinois.gov, live, no key, refreshed daily): name, profession, license number/status, original issue date (→ yearsLicensed seniority proxy), expiration, specialty, DBA, city/zip/county of the address of record (city-level only — often the home for individuals), discipline flag. Find high-income professionals living/practicing in an area: e.g. {zip:'60521'} defaults to ACTIVE physicians, dentists, CPAs, architects, podiatrists, optometrists, veterinarians and clinical psychologists (Hinsdale 60521 has ~550 active physicians, ~140 CPAs, ~60 dentists). Filter with professions presets (${Object.keys(IDFPR_PRESETS).join(", ")}) or exact IDFPR descriptions, licenseType, city, zip (one or several), county, lastName/firstName, name substring, licenseNumber, status (default ACTIVE; 'ANY' for all), includeBusinesses (professional corps/PLLCs), disciplinedOnly. summary:true returns license counts by profession for the area instead of names. Requires a geography or a name. Attorneys are not here (ARDC, no API). Results are licensing records, not contact info — use hunter_email_finder with the practice domain for a professional email.`,
    inputSchema: {
      type: "object",
      properties: {
        professions: { type: "array", items: { type: "string", enum: Object.keys(IDFPR_PRESETS) } },
        descriptions: { type: "array", items: { type: "string" }, description: "Exact IDFPR description values, e.g. 'LICENSED PHYSICIAN AND SURGEON'." },
        licenseType: { type: "string", description: "IDFPR license_type, e.g. MEDICAL BOARD, DENTAL, PUBLIC ACCOUNTANT." },
        city: { type: "string" },
        zip: { type: ["string", "array"], items: { type: "string" } },
        county: { type: "string", description: "e.g. DUPAGE, COOK." },
        lastName: { type: "string" },
        firstName: { type: "string" },
        name: { type: "string", description: "Substring of the full/business name." },
        licenseNumber: { type: "string" },
        status: { type: "string", description: "Default ACTIVE. Others: INACTIVE, EXPIRED, NOT RENEWED, DECEASED… or ANY." },
        includeBusinesses: { type: "boolean", default: false },
        disciplinedOnly: { type: "boolean", default: false },
        summary: { type: "boolean", default: false },
        dedupe: { type: "boolean", default: true, description: "Merge a person's multiple licenses (e.g. dentist + specialist) into one row with otherLicenses." },
        limit: { type: "number", default: 50, maximum: 500 },
        offset: { type: "number" },
      },
    },
    handler: idfprLicenseeSearch,
  },
  {
    name: "hunter_domain_search",
    description:
      "Hunter.io Domain Search (live, keyed HUNTER_API_KEY; 1 search credit per call): PROFESSIONAL email addresses published at a company domain — email, type (personal = a named person, generic = role mailbox), confidence 0-100, name, position, seniority, department, LinkedIn, Hunter's last verification status — plus the domain's email pattern (e.g. {first}.{last}) and accept-all flag. Filter seniority (junior/senior/executive), department (executive, finance, management, legal, health, operations…), type; limit ≤100, offset to page. Use to map decision-makers at a medical practice, CPA firm or business found via idfpr_licensee_search / PTAX buyers, or to learn the pattern before hunter_email_finder. Webmail addresses are dropped; there is no personal-email option. Validation (zerobounce_validate) is the required step before anything sends.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Company domain, e.g. hinsdaleortho.com (URLs are stripped to the host)." },
        company: { type: "string", description: "Company name when the domain is unknown (less precise)." },
        seniority: { type: "array", items: { type: "string", enum: ["junior", "senior", "executive"] } },
        department: { type: "array", items: { type: "string" } },
        type: { type: "string", enum: ["personal", "generic"] },
        limit: { type: "number", default: 10, maximum: 100 },
        offset: { type: "number" },
      },
    },
    handler: hunterDomainSearch,
  },
  {
    name: "hunter_email_finder",
    description:
      "Hunter.io Email Finder (live, keyed HUNTER_API_KEY; 1 search credit only when found): most likely PROFESSIONAL email for a named person at a company domain — email, score 0-100, position, company, accept-all flag, last verification status. Pass domain (preferred) or company plus firstName+lastName (or fullName). Typical chain: idfpr_licensee_search (Dr. Jane Smith, Hinsdale) → practice website domain → hunter_email_finder → zerobounce_validate. Score <70 or acceptAll=true is a pattern guess. Work domains only — no personal-email lookup. Validation is the required step before anything sends.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        company: { type: "string" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        fullName: { type: "string" },
        maxDuration: { type: "number", description: "3-20 s Hunter-side search budget (default 10)." },
      },
    },
    handler: hunterEmailFinder,
  },
  {
    name: "hunter_email_verifier",
    description:
      "Hunter.io Email Verifier (live, keyed HUNTER_API_KEY; 1 verification credit): deliverability check of one address — status (valid, invalid, accept_all, webmail, disposable, unknown), score, MX/SMTP checks, accept-all, block. Polls automatically while Hunter returns 202 (in progress). Use for a single spot check; for lists and as the canonical pre-send gate prefer zerobounce_validate. status 'webmail' means a personal address — out of scope for professional outreach. Validation is the required step before anything sends.",
    inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
    handler: hunterEmailVerifier,
  },
  {
    name: "hunter_account",
    description:
      "Hunter.io account status (live, keyed HUNTER_API_KEY; free call): plan name, reset date and used/available search and verification credits. Check before a batch of hunter_* lookups.",
    inputSchema: { type: "object", properties: {} },
    handler: hunterAccount,
  },
  {
    name: "zerobounce_validate",
    description:
      "ZeroBounce email validation (live, keyed ZEROBOUNCE_API_KEY; 1 credit per email, unknowns free) — THE REQUIRED VALIDATION STEP BEFORE ANYTHING SENDS. 1-50 emails per call (single → /v2/validate, 2+ → /v2/validatebatch). Per email: status (valid, invalid, catch-all, unknown, spamtrap, abuse, do_not_mail), sub_status (mailbox_not_found, role_based, disposable, toxic, global_suppression, possible_typo…), free_email (personal webmail), catch-all domain, did_you_mean typo fix, mx_found/mx_record, smtp_provider, domain age, and sendable (= valid AND not free_email). Only sendable=true addresses may go on to the draft-then-approve gate; invalid/spamtrap/abuse/do_not_mail must never be sent and should be marked; catch-all/unknown are held. Check zerobounce_credits before large batches.",
    inputSchema: {
      type: "object",
      properties: {
        emails: { type: "array", items: { type: "string" }, maxItems: 50 },
        email: { type: "string", description: "Single address (alternative to emails)." },
        timeout: { type: "number", description: "Seconds ZeroBounce may spend per call (3-60 single, 10-120 batch) before returning unknown." },
      },
    },
    handler: zerobounceValidate,
  },
  {
    name: "zerobounce_credits",
    description: "ZeroBounce remaining validation credits (live, keyed ZEROBOUNCE_API_KEY; free call). Run before a zerobounce_validate batch; an invalid key errors (ZeroBounce returns Credits -1).",
    inputSchema: { type: "object", properties: {} },
    handler: zerobounceCredits,
  },
];

const KEYED_NOTE_H = "Keyed: HUNTER_API_KEY. Professional emails only.";
const KEYED_NOTE_Z = "Keyed: ZEROBOUNCE_API_KEY. Required pre-send validation.";

export const LOCALWEALTH_DOMAIN: CatalogDomain = {
  id: "localwealth",
  label: "Local Wealth Signals & Contact Tools (Cook/DuPage · IDFPR · Hunter · ZeroBounce)",
  source:
    "Cook County Assessor open data (Parcel Sales, Parcel Addresses, Residential Characteristics) · IL Dept of Revenue PTAX-203 + IDFPR Professional Licensing (data.illinois.gov) · DuPage County GIS parcels · Hunter.io · ZeroBounce",
  tools: [
    { name: "cook_parcel_sales", backing: "live-api", probe: "unprobed", note: "Socrata wvhk-k5uv + 3723-97qp + x54s-btds" },
    { name: "dupage_parcel_sales", backing: "live-api", probe: "unprobed", note: "PTAX-203 (it54-y4c6) × DuPage GIS" },
    { name: "il_ptax_transfers", backing: "live-api", probe: "unprobed", note: "data.illinois.gov it54-y4c6" },
    { name: "idfpr_licensee_search", backing: "live-api", probe: "unprobed", note: "data.illinois.gov pzzh-kp68" },
    { name: "hunter_domain_search", backing: "live-api", probe: "unprobed", note: KEYED_NOTE_H },
    { name: "hunter_email_finder", backing: "live-api", probe: "unprobed", note: KEYED_NOTE_H },
    { name: "hunter_email_verifier", backing: "live-api", probe: "unprobed", note: KEYED_NOTE_H },
    { name: "hunter_account", backing: "live-api", probe: "unprobed", note: KEYED_NOTE_H },
    { name: "zerobounce_validate", backing: "live-api", probe: "unprobed", note: KEYED_NOTE_Z },
    { name: "zerobounce_credits", backing: "live-api", probe: "unprobed", note: KEYED_NOTE_Z },
  ],
};

export const LOCALWEALTH_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  {
    name: "localwealth: Cook Lyons twp $1.5M+ sales",
    tool: "cook_parcel_sales",
    args: { township: "Lyons", minPrice: 1500000, limit: 3, includeCharacteristics: false },
  },
  {
    name: "localwealth: DuPage Hinsdale PTAX sales",
    tool: "dupage_parcel_sales",
    args: { zip: "60521", limit: 3 },
  },
  {
    name: "localwealth: IDFPR Hinsdale summary",
    tool: "idfpr_licensee_search",
    args: { zip: "60521", summary: true },
  },
];
