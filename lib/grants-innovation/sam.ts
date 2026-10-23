/**
 * SAM.gov Entity Management API v3 — GET https://api.sam.gov/entity-information/v3/entities
 * ?api_key=…&legalBusinessName=…&physicalAddressProvinceOrStateCode=IL&registrationStatus=A
 * Spec: https://open.gsa.gov/api/entity-api/. Key = DATA_GOV_API_KEY (api.data.gov).
 * Rate limit: 10 req/day for a personal key without a SAM.gov role, 1,000/day
 * with a role or system account. The sandbox got HTTP 404 (empty body) for every
 * request including DEMO_KEY — the host appears to reject our egress — so the
 * response mapping follows the published spec and is UNVERIFIED live.
 */
import { cached, clampInt, HOUR, iso, jsonGet, requireKey } from "./common";

const BASE = "https://api.sam.gov/entity-information/v3/entities";

export async function samEntitySearch(args: any) {
  const apiKey = requireKey("DATA_GOV_API_KEY", "free key at https://api.data.gov/signup; SAM.gov entity API allows 10 req/day without a SAM role");
  const q = new URLSearchParams();
  if (args?.name) q.set("legalBusinessName", String(args.name));
  if (args?.uei) q.set("ueiSAM", String(args.uei).toUpperCase());
  if (args?.cage) q.set("cageCode", String(args.cage).toUpperCase());
  if (args?.city) q.set("physicalAddressCity", String(args.city));
  if (args?.state) q.set("physicalAddressProvinceOrStateCode", String(args.state).toUpperCase());
  if (args?.zip) q.set("physicalAddressZipPostalCode", String(args.zip).slice(0, 5));
  if (args?.naics) q.set("primaryNaics", String(args.naics));
  if (![...q.keys()].length) throw new Error("sam_entity_search needs name, uei, cage, zip, city+state or naics");
  q.set("registrationStatus", String(args?.status ?? "A").toUpperCase());
  q.set("includeSections", "entityRegistration,coreData,assertions");
  q.set("size", String(clampInt(args?.limit, 10, 1, 25)));
  q.set("page", String(clampInt(args?.page, 0, 0, 1000)));
  const url = `${BASE}?api_key=${encodeURIComponent(apiKey)}&${q.toString()}`;
  const data = await cached(`sam:${q.toString()}`, 24 * HOUR, () => jsonGet<any>(url, { retries: 0 }));
  const rows = (data?.entityData ?? []).map((e: any) => {
    const reg = e.entityRegistration ?? {};
    const core = e.coreData ?? {};
    const addr = core.physicalAddress ?? {};
    const info = core.entityInformation ?? {};
    const gs = e.assertions?.goodsAndServices ?? {};
    const naics = (gs.naicsList ?? []).map((n: any) => `${n.naicsCode}${n.sbaSmallBusiness === "Y" ? "*" : ""}${n.naicsDescription ? " " + n.naicsDescription : ""}`.trim());
    return {
      uei: reg.ueiSAM,
      cage: reg.cageCode ?? null,
      legalName: reg.legalBusinessName,
      dba: reg.dbaName ?? null,
      status: reg.registrationStatus,
      purpose: reg.purposeOfRegistrationDesc ?? null,
      registered: iso(reg.activationDate),
      expires: iso(reg.registrationExpirationDate),
      entityStart: iso(info.entityStartDate),
      url: info.entityURL ?? null,
      structure: core.generalInformation?.entityStructureDesc ?? null,
      organizationType: core.generalInformation?.organizationStructureDesc ?? null,
      address: [addr.addressLine1, addr.city, addr.stateOrProvinceCode, addr.zipCode?.slice(0, 5)].filter(Boolean).join(", "),
      congressionalDistrict: core.congressionalDistrict ?? null,
      primaryNaics: gs.primaryNaics ?? null,
      naics: naics.slice(0, 8),
      businessTypes: (core.businessTypes?.businessTypeList ?? []).map((b: any) => b.businessTypeDesc).filter(Boolean).slice(0, 6),
    };
  });
  return {
    source: "SAM.gov Entity Management API v3 (api.sam.gov)",
    fetchedAt: new Date().toISOString(),
    total: data?.totalRecords ?? rows.length,
    returned: rows.length,
    entities: rows,
    note: "Public-sensitivity fields only. '*' after a NAICS code = SBA small-business size status. Entities that opted out of public display are omitted. Pair with usaspending_awards_search (by recipient/UEI) for the dollars.",
  };
}
