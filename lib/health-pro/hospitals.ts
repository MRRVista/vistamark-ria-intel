/**
 * CMS Provider Data Catalog — Hospital General Information (dataset xubh-q36u)
 *   https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0
 *
 * DKAN datastore, keyless, refreshed quarterly with Care Compare. ~5,400 rows,
 * one per Medicare-certified hospital (CCN) with type, ownership, emergency
 * services, overall star rating (1–5 or "Not Available") and the counts of
 * mortality / safety / readmission measures better/worse than national.
 */
import { assertState, assertZip5, cached, clampInt, dkanFetch, DAY, likePattern, num, nz, str, titleCase } from "./common";

const BASE = "https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0";
const SOURCE = "CMS Care Compare — Hospital General Information (data.cms.gov/provider-data, xubh-q36u)";

type Row = Record<string, string>;

const COLS = [
  "facility_id", "facility_name", "address", "citytown", "state", "zip_code", "countyparish", "telephone_number",
  "hospital_type", "hospital_ownership", "emergency_services", "hospital_overall_rating",
  "count_of_facility_mort_measures", "count_of_mort_measures_better", "count_of_mort_measures_worse",
  "count_of_facility_safety_measures", "count_of_safety_measures_better", "count_of_safety_measures_worse",
  "count_of_facility_readm_measures", "count_of_readm_measures_better", "count_of_readm_measures_worse",
];

function compact(r: Row) {
  const rating = num(r.hospital_overall_rating);
  return {
    ccn: r.facility_id,
    name: titleCase(r.facility_name),
    address: titleCase(r.address),
    city: titleCase(r.citytown),
    state: nz(r.state),
    zip: nz(r.zip_code),
    county: titleCase(r.countyparish),
    phone: nz(r.telephone_number),
    type: nz(r.hospital_type),
    ownership: nz(r.hospital_ownership),
    emergencyServices: r.emergency_services === "Yes",
    overallStarRating: rating,
    measures: {
      mortality: { n: num(r.count_of_facility_mort_measures), better: num(r.count_of_mort_measures_better), worse: num(r.count_of_mort_measures_worse) },
      safety: { n: num(r.count_of_facility_safety_measures), better: num(r.count_of_safety_measures_better), worse: num(r.count_of_safety_measures_worse) },
      readmission: { n: num(r.count_of_facility_readm_measures), better: num(r.count_of_readm_measures_better), worse: num(r.count_of_readm_measures_worse) },
    },
  };
}

export interface HospitalArgs {
  zip?: string;
  zip_prefix?: string;
  city?: string;
  state?: string;
  county?: string;
  name?: string;
  ccn?: string;
  hospital_type?: string;
  ownership?: string;
  min_rating?: number;
  limit?: number;
  offset?: number;
}

export async function cmsHospitalGeneralInfo(args: HospitalArgs) {
  const a = args ?? {};
  const limit = clampInt(a.limit, 20, 1, 25);
  const offset = clampInt(a.offset, 0, 0, 10000);
  const conditions: Array<{ property: string; value: string | number; operator?: any }> = [];
  const where: string[] = [];
  if (a.ccn) { conditions.push({ property: "facility_id", value: String(a.ccn).trim() }); where.push(`ccn=${a.ccn}`); }
  if (a.zip) { conditions.push({ property: "zip_code", value: assertZip5(a.zip) }); where.push(`zip=${a.zip}`); }
  if (a.zip_prefix) {
    const p = String(a.zip_prefix).replace(/\D/g, "");
    if (p.length < 2 || p.length > 4) throw new Error("zip_prefix must be 2–4 digits (e.g. '605' for the western Chicago suburbs)");
    conditions.push({ property: "zip_code", value: `${p}%`, operator: "like" });
    where.push(`zip^${p}`);
  }
  if (a.state) { conditions.push({ property: "state", value: assertState(a.state) }); where.push(`state=${a.state}`); }
  if (a.city) { conditions.push({ property: "citytown", value: String(a.city).trim().toUpperCase() }); where.push(`city=${a.city}`); }
  if (a.county) { conditions.push({ property: "countyparish", value: likePattern(String(a.county).trim()), operator: "like" }); where.push(`county~${a.county}`); }
  if (a.name) { conditions.push({ property: "facility_name", value: likePattern(String(a.name).trim()), operator: "like" }); where.push(`name~${a.name}`); }
  if (a.hospital_type) { conditions.push({ property: "hospital_type", value: likePattern(String(a.hospital_type).trim()), operator: "like" }); where.push(`type~${a.hospital_type}`); }
  if (a.ownership) { conditions.push({ property: "hospital_ownership", value: likePattern(String(a.ownership).trim()), operator: "like" }); where.push(`ownership~${a.ownership}`); }
  if (!conditions.length) throw new Error("cms_hospital_general_info needs at least one filter: zip, zip_prefix, city+state, state, county, name or ccn");
  if (a.city && !a.state) throw new Error("city filter requires state");

  const minRating = a.min_rating != null ? clampInt(a.min_rating, 1, 1, 5) : null;
  // Over-fetch when filtering on rating client-side (rating is text in the datastore).
  const fetchLimit = minRating ? Math.min(500, Math.max(limit * 5, 100)) : limit;
  const res = await cached(`hosp:${JSON.stringify(conditions)}:${fetchLimit}:${offset}`, DAY, () =>
    dkanFetch<Row>(BASE, { limit: fetchLimit, offset, properties: COLS, conditions, count: true, sorts: [{ property: "facility_name", order: "asc" }] }, 20000)
  );
  let rows = res.results.map(compact);
  if (minRating) rows = rows.filter((r) => (r.overallStarRating ?? 0) >= minRating).sort((x, y) => (y.overallStarRating ?? 0) - (x.overallStarRating ?? 0));
  const total = res.count;
  return {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    filters: where.concat(minRating ? [`rating>=${minRating}`] : []),
    matched: total,
    returned: Math.min(rows.length, limit),
    nextOffset: !minRating && total != null && offset + rows.length < total ? offset + rows.length : null,
    results: rows.slice(0, limit),
  };
}
