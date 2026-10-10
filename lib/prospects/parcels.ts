/**
 * County parcel ingests — DuPage + Cook — feeding the prospects database.
 *
 * v0.23.0. Turns the public property rolls for a municipality (default
 * Hinsdale) into owner-occupied resident records and loads them through the
 * same importRecords() path every other list uses, so dedupe, merge rules,
 * consent flags and the import ledger all behave identically.
 *
 * Sources (both free, public, no key):
 *   - DuPage County GIS "ParcelsWithRealEstateCC" FeatureServer (weekly):
 *     PIN, billing name + address, property address, property class, assessed
 *     value. County terms: internal use only, no resale/redistribution.
 *   - Cook County Assessor "Parcel Addresses" (Socrata 3723-97qp, monthly):
 *     owner of record + taxpayer of record, each with a mailing address.
 *
 * Resident test: the tax bill (DuPage) or the owner/taxpayer mailing address
 * (Cook) goes to the property itself. Absentee owners are skipped unless
 * includeAbsentee is set. Entity owners (land trusts, LLCs, banks, churches,
 * governments) are counted, not loaded — they need Secretary of State or
 * deed work to resolve to a person.
 */

import { importRecords, type ImportSummary } from "./store";
import { normalizeAddressLine, titleCase, type ProspectInput } from "./normalize";

export const DUPAGE_PARCELS_URL =
  "https://gis.dupageco.org/arcgis/rest/services/DuPage_County_IL/ParcelsWithRealEstateCC/FeatureServer/0";
export const COOK_PARCEL_ADDRESSES_URL = "https://datacatalog.cookcountyil.gov/resource/3723-97qp.json";

export type County = "dupage" | "cook";

export interface ParcelIngestOptions {
  /** Municipality as it appears on the county roll, upper-case. Default HINSDALE. */
  city?: string;
  dryRun?: boolean;
  /** Load owners whose bill/mailing address is elsewhere (rentals, second homes). Default false. */
  includeAbsentee?: boolean;
  submittedBy?: string | null;
  /** Cap rows fetched (testing). */
  limit?: number;
}

export interface ParcelIngestResult {
  county: County;
  city: string;
  sourceUrl: string;
  rollYear?: string | null;
  parcelsFetched: number;
  residential: number;
  residentRecords: number;
  skipped: { nonResidential: number; absentee: number; entityOwned: number; noName: number };
  entitySample: string[];
  import: ImportSummary | null;
}

// ---------------------------------------------------------------------------
// Owner-name cleanup
// ---------------------------------------------------------------------------

/** Tokens that mark a non-person owner. Matched as whole words on the raw roll name. */
const ENTITY_RE = new RegExp(
  "\\b(" +
    [
      "LLC", "L L C", "INC", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LP", "LLP", "PARTNERS", "PARTNERSHIP",
      "BANK", "BK", "NATL", "NATIONAL", "TITLE", "LAND TR", "LAND TRUST", "TRUST CO", "TR CO", "TRUSTEE OF",
      "CHICAGO TITLE", "CHGO", "CTLTC", "CTTC", "ATG", "MB FIN", "FIRST MIDWEST", "ASSN", "ASSOC", "ASSOCIATION", "CONDO", "CONDOMINIUM", "HOA", "CLUB",
      "CHURCH", "PARISH", "DIOCESE", "ARCHBISHOP", "SCHOOL", "DIST", "DISTRICT", "VILLAGE", "CITY OF", "COUNTY",
      "STATE OF", "FOREST PRESERVE", "PARK DIST", "PARK DISTRICT", "HOSPITAL", "HOSPIT", "FOUNDATION", "FDN", "UNIVERSITY", "COLLEGE",
      "PROPERTIES", "PROPERTY", "HOLDINGS", "INVESTMENTS", "INVESTMENT", "DEVELOPMENT", "DEV", "BUILDERS",
      "HOMES", "REALTY", "MANAGEMENT", "MGMT", "ENTERPRISES", "GROUP", "VENTURES", "CAPITAL", "FUND",
      "TAXPAYER", "CURRENT OWNER", "OCCUPANT", "UNKNOWN", "COMMONWEALTH", "COMED", "NICOR", "RAILROAD", "RR",
    ].join("|") +
    ")\\b"
);

/** Trust / title noise stripped from the END of a person's name. */
const TRAILING_NOISE_RE =
  /\s+(TRUSTEES?|TRSTEES?|TRSTS?|TRST|TRS|TR|TRUST|TRUSTS|DECL|DECLARATION|REV|REVOC|REVOCABLE|LIV|LIVING|FAMILY|FAM|ETAL|ET AL|ET UX|EST|ESTATE|EX|EXEC|CUST|C\/O|T|TTEE|TTEES|U\/A|UTD|DTD|AS)\.?$/;

export interface CleanedOwner {
  /** Display name for the household, e.g. "Richard & Maria Loeber". */
  householdName: string;
  firstName: string;
  lastName: string;
  hasTrust: boolean;
}

export function isEntityName(raw: string): boolean {
  const s = raw.toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return true;
  if (/#\s*\d/.test(s) || /\bNO\s*\d/.test(s)) return true; // "TR #12345" = land trust number
  return ENTITY_RE.test(s);
}

function stripNoise(s: string): { name: string; hasTrust: boolean } {
  let hasTrust = /\b(TR|TRS|TRST|TRUST|TRUSTEE|TRUSTEES|TTEE|DECL|REV|LIVING)\b/.test(s);
  let prev = "";
  let out = s.trim();
  // Peel trailing tokens until stable ("SMITH JOHN TR DECL" -> "SMITH JOHN").
  while (out !== prev) {
    prev = out;
    out = out.replace(TRAILING_NOISE_RE, "").trim();
  }
  // "BASHAR ATTAR TRUSTEE T" style: cut at the first TRUSTEE/TRUST word.
  const cut = out.search(/\s(TRUST\w*|TTEE)\b/);
  if (cut > 0) {
    out = out.slice(0, cut).trim();
    hasTrust = true;
  }
  return { name: out.replace(/\s+/g, " ").replace(/[&,]\s*$/, "").trim(), hasTrust };
}

/**
 * Clean a raw roll name into a person. order:
 *   "last-first" — DuPage billing names: "LOEBER, RICHARD &MARIA TR", "STEIN, F & S KUHLMAN"
 *   "first-last" — Cook names: "JAMES CHASE", "SHAFOAT HK SYED"
 * Returns null when the name is an entity or unusable.
 */
export function cleanOwnerName(raw: string | null | undefined, order: "last-first" | "first-last"): CleanedOwner | null {
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/\s+/g, " ").trim();
  if (!upper || isEntityName(upper)) return null;
  const { name: stripped, hasTrust } = stripNoise(upper.replace(/\s+AND\s+/g, " & ").replace(/\s*&\s*/g, " & "));
  // Generational suffixes confuse surname picking in first-last names ("PETER S KRUSLAK III").
  const name = stripped.replace(/\s(JR|SR|II|III|IV)\b/g, "").trim();
  if (!name) return null;

  let firstName = "";
  let lastName = "";
  let householdName = "";

  if (order === "last-first" && name.includes(",")) {
    const [lastRaw, restRaw = ""] = name.split(",", 2).map((p) => p.trim());
    const people = restRaw.split("&").map((p) => p.trim()).filter(Boolean);
    lastName = lastRaw;
    const firstTokens = (people[0] ?? "").split(" ").filter(Boolean);
    firstName = firstTokens[0] ?? "";
    // "RICHARD & MARIA" -> "Richard & Maria Loeber"; "F & S KUHLMAN" -> "F Stein & S Kuhlman"
    const second = people[1]?.split(" ").filter(Boolean) ?? [];
    if (second.length >= 2 && second[second.length - 1].length > 2) {
      householdName = `${titleCase(people[0])} ${titleCase(lastName)} & ${titleCase(second.join(" "))}`;
    } else if (second.length >= 1) {
      householdName = `${titleCase(people[0])} & ${titleCase(second.join(" "))} ${titleCase(lastName)}`;
    } else {
      householdName = `${titleCase(people[0] ?? "")} ${titleCase(lastName)}`.trim();
    }
  } else if (order === "last-first") {
    // No comma: "SMITH JOHN" — surname first.
    const toks = name.replace(/&.*$/, "").split(" ").filter(Boolean);
    lastName = toks[0] ?? "";
    firstName = toks[1] ?? "";
    householdName = `${titleCase(firstName)} ${titleCase(lastName)}`.trim();
  } else {
    // first-last. Joint: "JOHN & MARY SMITH" or "JOHN SMITH & MARY JONES".
    const people = name.split("&").map((p) => p.trim()).filter(Boolean);
    const firstPerson = (people[0] ?? "").split(" ").filter(Boolean);
    const lastPerson = (people[people.length - 1] ?? "").split(" ").filter(Boolean);
    if (firstPerson.length >= 2) {
      firstName = firstPerson[0];
      lastName = firstPerson[firstPerson.length - 1];
    } else {
      firstName = firstPerson[0] ?? "";
      lastName = lastPerson.length >= 2 ? lastPerson[lastPerson.length - 1] : "";
    }
    householdName = people.map((p) => titleCase(p)).join(" & ");
  }

  // Initials-only first names ("F") are kept; a missing first name or surname is not usable.
  if (!firstName || !lastName || lastName.length < 2) return null;
  return {
    householdName: householdName || `${titleCase(firstName)} ${titleCase(lastName)}`.trim(),
    firstName: titleCase(firstName),
    lastName: titleCase(lastName),
    hasTrust,
  };
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeAddressLine(a ?? null);
  const y = normalizeAddressLine(b ?? null);
  if (!x || !y) return false;
  // Rolls misspell street names ("JUSIINA" vs "JUSTINA"); house number + first 4 street chars is enough.
  if (x === y) return true;
  const [nx, ...sx] = x.split(" ");
  const [ny, ...sy] = y.split(" ");
  return nx === ny && /^\d/.test(nx) && sx.join("").slice(0, 4) === sy.join("").slice(0, 4);
}

const t = (v: unknown): string => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "vistamark-ria-intel/0.23" } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${url.split("?")[0]}`);
  const j: any = await r.json();
  if (j && j.error) throw new Error(`ArcGIS error ${j.error.code}: ${j.error.message}`);
  return j;
}

// ---------------------------------------------------------------------------
// DuPage
// ---------------------------------------------------------------------------

const DUPAGE_FIELDS = [
  "PIN", "BILLNAME", "BILLADDRL1", "BILLCITY", "BILLSTATE", "BILLZIP",
  "PROPADDRL1", "PROPCITY", "PROPSTATE", "PROPZIP", "PROPZIPSUF",
  "REA017_PROP_CLASS", "REA017_FCV_TOTAL", "BILLVALUE", "ACREAGE", "EXEMPTCODE", "MUNICIPALITY",
].join(",");

export async function fetchDupageParcels(city: string, limit?: number): Promise<any[]> {
  const out: any[] = [];
  const page = 1000; // layer maxRecordCount
  for (let offset = 0; ; offset += page) {
    const qs = new URLSearchParams({
      where: `PROPCITY='${city.replace(/'/g, "''")}'`,
      outFields: DUPAGE_FIELDS,
      returnGeometry: "false",
      orderByFields: "OBJECTID",
      resultOffset: String(offset),
      resultRecordCount: String(page),
      f: "json",
    });
    const j = await getJson(`${DUPAGE_PARCELS_URL}/query?${qs}`);
    const feats: any[] = (j.features ?? []).map((f: any) => f.attributes);
    out.push(...feats);
    if (limit && out.length >= limit) return out.slice(0, limit);
    if (feats.length < page && !j.exceededTransferLimit) break;
    if (!feats.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cook
// ---------------------------------------------------------------------------

export async function cookLatestRollYear(city: string): Promise<string | null> {
  const qs = new URLSearchParams({
    $select: "year",
    $where: `prop_address_city_name='${city.replace(/'/g, "''")}'`,
    $group: "year",
    $order: "year DESC",
    $limit: "1",
  });
  const j = await getJson(`${COOK_PARCEL_ADDRESSES_URL}?${qs}`);
  return j?.[0]?.year ?? null; // note: Socrata currently returns e.g. "2026.0" for the newest roll
}

export async function fetchCookParcels(city: string, year: string, limit?: number): Promise<any[]> {
  const out: any[] = [];
  const page = 5000;
  for (let offset = 0; ; offset += page) {
    const qs = new URLSearchParams({
      $where: `prop_address_city_name='${city.replace(/'/g, "''")}' AND year='${year.replace(/'/g, "''")}'`,
      $order: "pin",
      $limit: String(page),
      $offset: String(offset),
    });
    const rows: any[] = await getJson(`${COOK_PARCEL_ADDRESSES_URL}?${qs}`);
    out.push(...rows);
    if (limit && out.length >= limit) return out.slice(0, limit);
    if (rows.length < page) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row -> ProspectInput
// ---------------------------------------------------------------------------

function blankResult(county: County, city: string, sourceUrl: string): ParcelIngestResult {
  return {
    county,
    city,
    sourceUrl,
    parcelsFetched: 0,
    residential: 0,
    residentRecords: 0,
    skipped: { nonResidential: 0, absentee: 0, entityOwned: 0, noName: 0 },
    entitySample: [],
    import: null,
  };
}

export function dupageRowToInput(
  a: any,
  res: ParcelIngestResult,
  includeAbsentee: boolean
): ProspectInput | null {
  // DuPage property class "R" = residential; E = exempt, C = commercial, I = industrial, F/A = farm.
  if (t(a.REA017_PROP_CLASS).toUpperCase() !== "R") {
    res.skipped.nonResidential++;
    return null;
  }
  res.residential++;
  const billName = t(a.BILLNAME);
  const occupied = sameAddress(a.BILLADDRL1, a.PROPADDRL1);
  if (!occupied && !includeAbsentee) {
    res.skipped.absentee++;
    return null;
  }
  if (isEntityName(billName)) {
    res.skipped.entityOwned++;
    if (res.entitySample.length < 25) res.entitySample.push(billName);
    return null;
  }
  const person = cleanOwnerName(billName, "last-first");
  if (!person) {
    res.skipped.noName++;
    return null;
  }
  const assessed = Number(a.REA017_FCV_TOTAL) || null;
  const zip = t(a.PROPZIP);
  const zip4 = t(a.PROPZIPSUF);
  return {
    firstName: person.firstName,
    lastName: person.lastName,
    householdName: person.householdName,
    addressLine1: t(a.PROPADDRL1),
    city: titleCase(t(a.PROPCITY) || "HINSDALE"),
    state: t(a.PROPSTATE) || "IL",
    zip: zip4 ? `${zip}-${zip4}` : zip,
    county: "DuPage",
    // Illinois assesses residential property at 1/3 of market value outside Cook.
    homeValue: assessed ? assessed * 3 : null,
    homeValueSource: assessed ? "dupage-assessed-x3" : null,
    homeValueAsOf: new Date().toISOString().slice(0, 10),
    lotAcres: a.ACREAGE ?? null,
    ownerOccupied: occupied,
    hasTrust: person.hasTrust,
    wealthSignals: {
      dupageAssessedValue: assessed,
      dupageBillValue: Number(a.BILLVALUE) || null,
      dupageExemptCode: t(a.EXEMPTCODE) || null,
    },
    source: "dupage-parcels",
    sourceDetail: "DuPage County GIS ParcelsWithRealEstateCC",
    sourceRecordId: t(a.PIN),
    tags: ["parcel:dupage", occupied ? "owner-occupied" : "absentee-owner", ...(person.hasTrust ? ["trust-titled"] : [])],
    raw: { pin: t(a.PIN), billName, billAddress: [t(a.BILLADDRL1), t(a.BILLCITY), t(a.BILLSTATE), t(a.BILLZIP)].filter(Boolean).join(", ") },
  };
}

export function cookRowToInput(r: any, res: ParcelIngestResult, includeAbsentee: boolean): ProspectInput | null {
  // Parcel Addresses carries no property class; every Hinsdale situs row counts as residential
  // here, and entity names / non-matching mail addresses filter out the rest.
  res.residential++;
  const prop = t(r.prop_address_full);
  const ownerName = t(r.owner_address_name);
  const mailName = t(r.mail_address_name);
  const ownerHere = sameAddress(r.owner_address_full, prop);
  const mailHere = sameAddress(r.mail_address_full, prop);
  const occupied = ownerHere || mailHere;
  if (!occupied && !includeAbsentee) {
    res.skipped.absentee++;
    return null;
  }
  // Best evidence first: a person-named party whose address is the property.
  // Owner of record first: it is the untruncated field. The taxpayer (mail) name is cut at
  // 22 characters, so a full-length one loses its last, probably partial, token.
  const mailClean = mailName.length >= 22 ? mailName.replace(/\s+\S*$/, "") : mailName;
  const candidates: Array<{ name: string; here: boolean }> = [
    { name: ownerName, here: ownerHere },
    { name: mailClean, here: mailHere },
  ];
  let person: CleanedOwner | null = null;
  let used = "";
  for (const c of candidates) {
    person = cleanOwnerName(c.name, "first-last");
    if (person) {
      used = c.name;
      break;
    }
  }
  if (!person) {
    if (isEntityName(ownerName) || isEntityName(mailName)) {
      res.skipped.entityOwned++;
      if (res.entitySample.length < 25) res.entitySample.push(ownerName || mailName);
    } else {
      res.skipped.noName++;
    }
    return null;
  }
  const other = used === ownerName ? mailName : ownerName;
  return {
    firstName: person.firstName,
    lastName: person.lastName,
    householdName: person.householdName,
    addressLine1: prop,
    city: titleCase(t(r.prop_address_city_name) || "HINSDALE"),
    state: t(r.prop_address_state) || "IL",
    zip: t(r.prop_address_zipcode_1),
    county: "Cook",
    ownerOccupied: occupied,
    hasTrust: person.hasTrust,
    wealthSignals: other && other !== used ? { cookOtherPartyName: other } : null,
    source: "cook-parcels",
    sourceDetail: `Cook County Assessor Parcel Addresses (roll ${t(r.year)})`,
    sourceRecordId: t(r.pin),
    tags: [
      "parcel:cook",
      occupied ? "owner-occupied" : "absentee-owner",
      ...(person.hasTrust ? ["trust-titled"] : []),
      // Cook's name fields stop at 22 characters; the surname may be cut short.
      ...(used.length >= 22 ? ["name-truncated"] : []),
    ],
    raw: { pin: t(r.pin), ownerName, mailName, year: t(r.year) },
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function ingestCountyParcels(county: County, opts: ParcelIngestOptions = {}): Promise<ParcelIngestResult> {
  const city = (opts.city ?? "HINSDALE").toUpperCase();
  const includeAbsentee = !!opts.includeAbsentee;
  let inputs: ProspectInput[] = [];
  let res: ParcelIngestResult;

  if (county === "dupage") {
    res = blankResult(county, city, DUPAGE_PARCELS_URL);
    const rows = await fetchDupageParcels(city, opts.limit);
    res.parcelsFetched = rows.length;
    for (const a of rows) {
      const inp = dupageRowToInput(a, res, includeAbsentee);
      if (inp) inputs.push(inp);
    }
  } else {
    res = blankResult(county, city, COOK_PARCEL_ADDRESSES_URL);
    const year = await cookLatestRollYear(city);
    res.rollYear = year;
    if (!year) return res;
    const rows = await fetchCookParcels(city, year, opts.limit);
    res.parcelsFetched = rows.length;
    for (const r of rows) {
      const inp = cookRowToInput(r, res, includeAbsentee);
      if (inp) inputs.push(inp);
    }
  }

  res.residentRecords = inputs.length;
  if (!inputs.length) return res;
  res.import = await importRecords(inputs, {
    via: "json",
    source: county === "dupage" ? "dupage-parcels" : "cook-parcels",
    sourceDetail: county === "dupage" ? "DuPage County GIS ParcelsWithRealEstateCC" : `Cook County Assessor Parcel Addresses ${res.rollYear ?? ""}`.trim(),
    submittedBy: opts.submittedBy ?? "ingest-parcels",
    dryRun: !!opts.dryRun,
  });
  // Keep the response small; the ledger row holds the detail.
  if (res.import) delete (res.import as Partial<ImportSummary>).ids;
  return res;
}
