/**
 * NPPES NPI Registry API v2.1 — https://npiregistry.cms.hhs.gov/api/?version=2.1
 *
 * Keyless, JSON, updated weekly by CMS. Max 200 results per call, `skip` up to
 * 1000 (so at most 1,200 rows per criteria set). Wildcards (`*`) are allowed
 * at the end of names and 5-digit postal codes once ≥2 characters are given.
 * Errors come back 200 with {"Errors":[...]}.
 *
 * Output is deliberately professional-only: we keep the LOCATION (practice)
 * address and drop MAILING addresses (which are frequently a physician's home
 * or a PO box) unless the record has no practice address at all.
 */
import { cached, clampInt, fetchJson, HOUR, nz, str } from "./common";

const BASE = "https://npiregistry.cms.hhs.gov/api/";
const SOURCE = "NPPES NPI Registry API v2.1 (CMS)";

interface NppesAddress {
  address_1?: string;
  address_2?: string;
  address_purpose?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country_code?: string;
  telephone_number?: string;
  fax_number?: string;
}

interface NppesRecord {
  number: string;
  enumeration_type: "NPI-1" | "NPI-2";
  basic: Record<string, string>;
  addresses?: NppesAddress[];
  practiceLocations?: NppesAddress[];
  taxonomies?: Array<{ code: string; desc: string; primary: boolean; state?: string | null; license?: string | null }>;
  identifiers?: Array<{ identifier: string; desc: string; state?: string; issuer?: string }>;
  other_names?: Array<{ type?: string; organization_name?: string; first_name?: string; last_name?: string; credential?: string }>;
  endpoints?: Array<{ endpointType?: string; endpoint?: string }>;
}

interface NppesResponse {
  result_count?: number;
  results?: NppesRecord[];
  Errors?: Array<{ description: string; field?: string; number?: string }>;
}

async function nppesGet(params: Record<string, string | number | undefined>): Promise<NppesResponse> {
  const p = new URLSearchParams({ version: "2.1" });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const url = `${BASE}?${p.toString()}`;
  const res = await cached(`nppes:${p.toString()}`, 6 * HOUR, () => fetchJson<NppesResponse>(url, 20000, 2));
  if (res.Errors?.length) {
    throw new Error(`NPPES rejected the query: ${res.Errors.map((e) => `${e.field ? e.field + ": " : ""}${e.description}`).join("; ")}`);
  }
  return res;
}

function fmtAddress(a: NppesAddress | undefined) {
  if (!a) return null;
  const zip = (a.postal_code ?? "").replace(/\D/g, "");
  return {
    line1: nz(a.address_1),
    line2: nz(a.address_2),
    city: nz(a.city),
    state: nz(a.state),
    zip: zip.length >= 5 ? zip.slice(0, 5) : nz(a.postal_code),
    phone: nz(a.telephone_number),
    fax: nz(a.fax_number),
  };
}

function practiceAddress(r: NppesRecord): NppesAddress | undefined {
  const addrs = r.addresses ?? [];
  return addrs.find((a) => a.address_purpose === "LOCATION") ?? r.practiceLocations?.[0] ?? addrs[0];
}

function displayName(r: NppesRecord): string {
  const b = r.basic ?? {};
  if (r.enumeration_type === "NPI-2") return b.organization_name ?? "";
  return [b.name_prefix && b.name_prefix !== "--" ? b.name_prefix : null, b.first_name, b.middle_name, b.last_name, b.name_suffix && b.name_suffix !== "--" ? b.name_suffix : null]
    .filter(Boolean)
    .join(" ");
}

export function compactRecord(r: NppesRecord) {
  const b = r.basic ?? {};
  const primary = (r.taxonomies ?? []).find((t) => t.primary) ?? r.taxonomies?.[0];
  const addr = practiceAddress(r);
  const isOrg = r.enumeration_type === "NPI-2";
  return {
    npi: r.number,
    type: isOrg ? "organization" : "individual",
    name: displayName(r),
    credential: isOrg ? undefined : nz(b.credential),
    sex: isOrg ? undefined : nz(b.sex),
    soleProprietor: isOrg ? undefined : nz(b.sole_proprietor),
    authorizedOfficial: isOrg && b.authorized_official_last_name
      ? `${b.authorized_official_first_name ?? ""} ${b.authorized_official_last_name}`.trim() + (b.authorized_official_title_or_position ? ` (${b.authorized_official_title_or_position})` : "")
      : undefined,
    primaryTaxonomy: primary ? { code: primary.code, desc: primary.desc, licenseState: nz(primary.state) } : null,
    taxonomyCount: r.taxonomies?.length ?? 0,
    practiceAddress: fmtAddress(addr),
    status: nz(b.status),
    enumerationDate: nz(b.enumeration_date),
    lastUpdated: nz(b.last_updated),
  };
}

/** Trimmed row for search listings (~250 chars). */
function searchRecord(r: NppesRecord) {
  const c = compactRecord(r);
  const pa = c.practiceAddress;
  return {
    npi: c.npi,
    type: c.type,
    name: c.name,
    credential: c.credential,
    authorizedOfficial: c.authorizedOfficial,
    taxonomy: c.primaryTaxonomy?.desc,
    taxonomyCode: c.primaryTaxonomy?.code,
    licenseState: c.primaryTaxonomy?.licenseState,
    practice: pa ? { line1: pa.line1, line2: pa.line2, city: pa.city, state: pa.state, zip: pa.zip, phone: pa.phone } : null,
    status: c.status === "A" ? undefined : c.status,
    enumerated: c.enumerationDate,
  };
}

/** ~100-char row for cohort enumeration: fields="brief". */
function briefRecord(r: NppesRecord) {
  const c = compactRecord(r);
  return {
    npi: c.npi,
    name: c.name + (c.credential ? `, ${c.credential}` : ""),
    taxonomy: c.primaryTaxonomy?.desc,
    city: c.practiceAddress?.city,
    zip: c.practiceAddress?.zip,
  };
}

export interface NppesSearchArgs {
  fields?: "brief" | "standard";
  first_name?: string;
  last_name?: string;
  organization_name?: string;
  taxonomy_description?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  enumeration_type?: "NPI-1" | "NPI-2";
  limit?: number;
  skip?: number;
  max_pages?: number;
}

/**
 * nppes_search — paginate NPPES (200/page) until `limit` rows or the registry
 * stops returning full pages. Any-name matching (`use_first_name_alias`) stays
 * on so "Bill" finds "William".
 */
export async function nppesSearch(args: NppesSearchArgs) {
  const a = args ?? {};
  const hasCriteria = ["first_name", "last_name", "organization_name", "taxonomy_description", "city", "state", "postal_code"].some(
    (k) => str((a as any)[k])
  );
  if (!hasCriteria) throw new Error("nppes_search needs at least one of: last_name, first_name, organization_name, taxonomy_description, city, state, postal_code");
  if (a.state && !a.city && !a.postal_code && !a.last_name && !a.organization_name && !a.taxonomy_description && !a.first_name) {
    throw new Error("NPPES does not allow state as the only criterion — add a city, postal_code, name or taxonomy_description");
  }
  const brief = a.fields === "brief";
  const limit = clampInt(a.limit, brief ? 40 : 12, 1, brief ? 45 : 16);
  const skip = clampInt(a.skip, 0, 0, 1000);
  const perPage = Math.min(200, limit);
  const out: any[] = [];
  let cursor = skip;
  let pages = 0;
  const maxPages = clampInt(a.max_pages, 2, 1, 6);
  let lastCount = 0;
  while (out.length < limit && pages < maxPages && cursor <= 1000) {
    const res = await nppesGet({
      first_name: str(a.first_name) ?? undefined,
      last_name: str(a.last_name) ?? undefined,
      organization_name: str(a.organization_name) ?? undefined,
      taxonomy_description: str(a.taxonomy_description) ?? undefined,
      city: str(a.city) ?? undefined,
      state: str(a.state)?.toUpperCase(),
      postal_code: str(a.postal_code) ?? undefined,
      enumeration_type: a.enumeration_type,
      use_first_name_alias: a.first_name ? "True" : undefined,
      limit: perPage,
      skip: cursor,
    });
    const rows = res.results ?? [];
    lastCount = rows.length;
    for (const r of rows) {
      if (out.length >= limit) break;
      out.push(brief ? briefRecord(r) : searchRecord(r));
    }
    pages++;
    cursor += rows.length;
    if (rows.length < perPage) break;
  }
  const exhausted = lastCount < perPage || cursor > 1000;
  return {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    criteria: {
      first_name: a.first_name, last_name: a.last_name, organization_name: a.organization_name,
      taxonomy_description: a.taxonomy_description, city: a.city, state: a.state, postal_code: a.postal_code, enumeration_type: a.enumeration_type,
    },
    returned: out.length,
    fields: brief ? "brief" : "standard",
    nextSkip: exhausted ? null : cursor,
    note: exhausted ? undefined : `More rows: call again with skip=${cursor} (registry cap 1,200 rows/criteria set).`,
    results: out,
  };
}

/** nppes_lookup — full detail for one NPI. */
export async function nppesLookup(args: { npi: string | number }) {
  const npi = String(args?.npi ?? "").trim();
  if (!/^\d{10}$/.test(npi)) throw new Error(`npi must be a 10-digit NPI (got "${npi}")`);
  const res = await nppesGet({ number: npi });
  const r = res.results?.[0];
  if (!r) return { source: SOURCE, fetchedAt: new Date().toISOString(), npi, found: false };
  const b = r.basic ?? {};
  const c = compactRecord(r);
  const addrs = r.addresses ?? [];
  const location = addrs.find((x) => x.address_purpose === "LOCATION");
  const mailing = addrs.find((x) => x.address_purpose === "MAILING");
  // Keep a mailing address only when it looks like a business address (same as practice, or an org record).
  const mailingIsBusiness = mailing && (r.enumeration_type === "NPI-2" || (location && mailing.address_1 === location.address_1));
  return {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    found: true,
    ...c,
    namePrefix: nz(b.name_prefix),
    certificationDate: nz(b.certification_date),
    deactivationDate: nz(b.deactivation_date),
    reactivationDate: nz(b.reactivation_date),
    parentOrganization: nz(b.parent_organization_legal_business_name),
    organizationalSubpart: nz(b.organizational_subpart),
    taxonomies: (r.taxonomies ?? []).map((t) => ({ code: t.code, desc: t.desc, primary: t.primary, licenseState: nz(t.state), license: nz(t.license) })),
    otherPracticeLocations: (r.practiceLocations ?? []).slice(0, 5).map(fmtAddress),
    mailingAddress: mailingIsBusiness ? fmtAddress(mailing) : undefined,
    otherNames: (r.other_names ?? []).slice(0, 5).map((o) => ({
      type: nz(o.type),
      name: o.organization_name ?? [o.first_name, o.last_name].filter(Boolean).join(" "),
      credential: nz(o.credential),
    })),
    otherIdentifiers: (r.identifiers ?? []).slice(0, 10).map((i) => ({ desc: i.desc, state: nz(i.state), issuer: nz(i.issuer), identifier: i.identifier })),
    directEndpoints: (r.endpoints ?? []).filter((e) => e.endpointType === "DIRECT").slice(0, 3).map((e) => e.endpoint),
    affiliationHint: (r.endpoints ?? []).map((e) => e.endpoint ?? "").map((e) => e.split("@")[1] ?? "").filter(Boolean)[0] ?? undefined,
  };
}
