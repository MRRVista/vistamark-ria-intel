/**
 * idfpr_licensee_search — Illinois Dept of Financial & Professional Regulation
 * "Professional Licensing" dataset on data.illinois.gov (Socrata pzzh-kp68, no key,
 * verified live 2026-10-21; refreshed daily).
 *
 * Columns: license_type, description, license_number, license_status, business (Y/N),
 * first_name, middle, last_name, suffix, business_name, businessdba, original_issue_date,
 * effective_date, expiration_date, city, state, zip, county, specialty_qualifier,
 * ever_disciplined, case_number/action/discipline_* (discipline detail).
 *
 * Address is the licensee's ADDRESS OF RECORD (city/zip only — no street), which is
 * often home for individuals. Attorneys are NOT here (ARDC, no API).
 */
import { IL_HOST, soda, soqlStr, soqlLike, soqlIn, str, clampLimit, strList } from "./socrata";

const DATASET = "pzzh-kp68";

/** Profession presets → description values (exact, as IDFPR writes them). */
export const IDFPR_PRESETS: Record<string, string[]> = {
  physician: ["LICENSED PHYSICIAN AND SURGEON"],
  dentist: ["LICENSED DENTIST", "LICENSED SPECIALIST IN DENTISTRY"],
  cpa: ["LICENSED CERTIFIED PUBLIC ACCOUNTANT"],
  cpa_registered: ["REGISTERED CERTIFIED PUBLIC ACCOUNTANT"],
  architect: ["LICENSED ARCHITECT"],
  engineer: ["LICENSED PROFESSIONAL ENGINEER", "LICENSED STRUCTURAL ENGINEER"],
  pharmacist: ["REGISTERED PHARMACIST"],
  veterinarian: ["LICENSED VETERINARIAN"],
  optometrist: ["LICENSED OPTOMETRIST"],
  podiatrist: ["LICENSED PODIATRIC PHYSICIAN"],
  psychologist: ["CLINICAL PSYCHOLOGIST"],
  chiropractor: ["LICENSED CHIROPRACTIC PHYSICIAN"],
  physician_assistant: ["LICENSED PHYSICIAN ASSISTANT"],
  nurse_practitioner: ["ADVANCED PRACTICE REGISTERED NURSE"],
  real_estate_managing_broker: ["LICENSED REAL ESTATE MANAGING BROKER"],
  appraiser: ["CERTIFIED GENERAL REAL ESTATE APPRAISER"],
  medical_corp: ["REGISTERED MEDICAL CORPORATION", "REGISTERED PROFESSIONAL SERVICE CORPORATION", "PROFESSIONAL LIMITED LIABILITY COMPANY"],
};

/** High-income default set for prospecting when no profession is given. */
const HIGH_INCOME_DEFAULT = ["physician", "dentist", "cpa", "architect", "podiatrist", "optometrist", "veterinarian", "psychologist"];

export interface IdfprArgs {
  professions?: string[];
  descriptions?: string[];
  licenseType?: string;
  city?: string;
  zip?: string | string[];
  county?: string;
  lastName?: string;
  firstName?: string;
  name?: string;
  licenseNumber?: string;
  status?: string;
  includeBusinesses?: boolean;
  disciplinedOnly?: boolean;
  summary?: boolean;
  /** Collapse multiple licenses held by one person (same first/last/zip) into one row. Default true. */
  dedupe?: boolean;
  limit?: number;
  offset?: number;
}

export async function idfprLicenseeSearch(args: IdfprArgs = {}) {
  const limit = clampLimit(args.limit, 50, 500);
  const where: string[] = [];
  const profs = strList(args.professions).map((p) => p.toLowerCase());
  const unknown = profs.filter((p) => !IDFPR_PRESETS[p]);
  if (unknown.length) throw new Error(`Unknown profession preset(s): ${unknown.join(", ")}. Valid: ${Object.keys(IDFPR_PRESETS).join(", ")}`);
  const pointLookup = !!(args.licenseNumber || args.lastName || args.name);
  let descs = [...profs.flatMap((p) => IDFPR_PRESETS[p]), ...strList(args.descriptions).map((d) => d.toUpperCase())];
  if (!descs.length && !args.licenseType && !pointLookup && !args.summary) descs = HIGH_INCOME_DEFAULT.flatMap((p) => IDFPR_PRESETS[p]);
  if (descs.length) where.push(`description in ${soqlIn(descs)}`);
  if (args.licenseType) where.push(`upper(license_type)=${soqlStr(args.licenseType.toUpperCase())}`);
  if (args.city) where.push(`city=${soqlStr(args.city.toUpperCase())}`);
  const zips = strList(args.zip).map((z) => z.replace(/\D/g, "").slice(0, 5)).filter(Boolean);
  if (zips.length) where.push(`zip in ${soqlIn(zips)}`);
  if (args.county) where.push(`upper(county)=${soqlStr(args.county.toUpperCase().replace(/\s+/g, ""))}`);
  if (args.lastName) where.push(`upper(last_name)=${soqlStr(args.lastName.toUpperCase())}`);
  if (args.firstName) where.push(`upper(first_name)=${soqlStr(args.firstName.toUpperCase())}`);
  if (args.name) where.push(`upper(business_name) like ${soqlLike(args.name)}`);
  if (args.licenseNumber) where.push(`license_number=${soqlStr(args.licenseNumber.replace(/\D/g, ""))}`);
  const status = args.status === undefined ? "ACTIVE" : args.status;
  if (status && status.toUpperCase() !== "ANY") where.push(`license_status=${soqlStr(status.toUpperCase())}`);
  if (!args.includeBusinesses) where.push("business='N'");
  if (args.disciplinedOnly) where.push("ever_disciplined='Y'");
  if (!args.city && !zips.length && !args.county && !pointLookup) {
    throw new Error("idfpr_licensee_search needs a geography (city, zip or county) or a name/licenseNumber — the statewide file is 1M+ rows");
  }

  if (args.summary) {
    const rows = await soda(IL_HOST, DATASET, {
      $select: "license_type,description,count(*) as n",
      $where: where.join(" AND "),
      $group: "license_type,description",
      $order: "n DESC",
      $limit: 35,
    });
    return {
      dataSource: "IDFPR Professional Licensing (data.illinois.gov pzzh-kp68)",
      query: { ...args, status },
      counts: rows.map((r: any) => ({ licenseType: r.license_type, description: r.description, count: Number(r.n) })),
      note: "Counts of licenses (not people — one physician typically holds both a medical and a controlled-substance license). Re-run without summary and with professions/descriptions for names.",
    };
  }

  const rows = await soda(IL_HOST, DATASET, {
    $select:
      "license_type,description,license_number,license_status,business,first_name,middle,last_name,suffix,business_name,businessdba,original_issue_date,expiration_date,city,state,zip,county,specialty_qualifier,ever_disciplined",
    $where: where.join(" AND "),
    $order: "last_name, first_name, license_number",
    $limit: limit,
    $offset: args.offset ? Math.max(0, Math.floor(Number(args.offset))) : undefined,
  });

  const licensees = rows.map((r: any) => {
    const issued = str(r.original_issue_date);
    const yr = issued ? Number(issued.slice(-4)) : NaN;
    return {
      name:
        r.business === "Y"
          ? str(r.business_name)
          : [str(r.first_name), str(r.middle), str(r.last_name), str(r.suffix)].filter(Boolean).join(" ") || str(r.business_name),
      firstName: str(r.first_name),
      lastName: str(r.last_name),
      profession: str(r.description),
      licenseType: str(r.license_type),
      licenseNumber: str(r.license_number),
      status: str(r.license_status),
      originallyIssued: issued,
      yearsLicensed: Number.isFinite(yr) ? new Date().getFullYear() - yr : null,
      expires: str(r.expiration_date),
      specialty: str(r.specialty_qualifier),
      dba: str(r.businessdba),
      city: str(r.city),
      zip: str(r.zip),
      county: str(r.county),
      everDisciplined: r.ever_disciplined === "Y" ? true : undefined,
    };
  });

  let people: any[] = licensees;
  if (args.dedupe !== false) {
    const byKey = new Map<string, any>();
    for (const l of licensees) {
      const k = `${l.firstName ?? l.name}|${l.lastName ?? ""}|${l.zip ?? ""}`;
      const prev = byKey.get(k);
      if (!prev) {
        byKey.set(k, { ...l, otherLicenses: undefined as any });
        continue;
      }
      prev.otherLicenses = [...(prev.otherLicenses ?? []), `${l.profession} #${l.licenseNumber}${l.specialty ? ` (${l.specialty})` : ""}`];
      if ((l.yearsLicensed ?? 0) > (prev.yearsLicensed ?? 0)) {
        prev.yearsLicensed = l.yearsLicensed;
        prev.originallyIssued = l.originallyIssued;
      }
      prev.specialty = prev.specialty ?? l.specialty;
    }
    people = [...byKey.values()];
  }

  return {
    dataSource: "IDFPR Professional Licensing (data.illinois.gov pzzh-kp68)",
    query: { ...args, status, descriptions: descs.length ? descs : undefined },
    count: people.length,
    licenseRows: licensees.length,
    licensees: people,
    note:
      (licensees.length === limit ? `Capped at ${limit} license rows; page with offset. ` : "") +
      "Address of record (city/zip only) — often the home for individuals, so a Hinsdale zip implies residence or practice there. yearsLicensed from original issue date is a seniority/income proxy. Attorneys are licensed by ARDC (not here). Professional-only use: pair with Hunter/Apollo for a work email, never infer a personal one.",
  };
}
