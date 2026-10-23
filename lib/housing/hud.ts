/**
 * HUD User API (keyed: HUD_API_KEY, a free bearer token from
 * https://www.huduser.gov/hudapi/public/register — account + "Create New Token").
 *
 * Fair Market Rents (verified reachable 2026-10-22: 401 {"error":"Unauthenticated"}
 * without a token; response shapes below follow HUD's published docs, NOT verified
 * with a live token from the sandbox):
 *   GET https://www.huduser.gov/hudapi/public/fmr/data/{entityid}?year=YYYY
 *     entityid = 10-digit county FIPS code + "99999"  (DuPage IL: 1704399999)
 *                or metro code "METRO16980M16980" (CBSA-based), from listMetroAreas
 *     -> { data: { county_name|area_name, year, basicdata: { Efficiency, One-Bedroom,
 *          Two-Bedroom, Three-Bedroom, Four-Bedroom, ... } | [ {zip_code, Efficiency, ...} ] } }
 *        (Small Area FMR metros return an ARRAY of zip rows in basicdata)
 *   GET .../fmr/statedata/{stateCode}?year=   -> all counties + metros in a state
 *   GET .../fmr/listCounties/{stateCode}      -> [{fips_code, county_name, town_name, ...}]
 *   GET .../fmr/listMetroAreas                -> [{cbsa_code, area_name, category}]
 * USPS ZIP crosswalk (same token):
 *   GET https://www.huduser.gov/hudapi/public/usps?type=N&query=Q[&year=&quarter=]
 *     type 1 zip->tract, 2 zip->county, 3 zip->cbsa, 4 zip->cbsadiv, 5 zip->cd,
 *          6 tract->zip, 7 county->zip, 8 cbsa->zip, 9 cbsadiv->zip, 10 cd->zip,
 *          11 zip->countysub, 12 countysub->zip
 *     -> { data: { year, quarter, input, crosswalk_type, results: [ {geoid|zip, res_ratio,
 *          bus_ratio, oth_ratio, tot_ratio, city, state} ] } }
 * Limits: HUD documents 1,200 queries per minute per token. Data is annual (FMR
 * fiscal year, published ~Aug/Sep for the following Oct 1), crosswalk quarterly.
 */
import { jsonFetch } from "../data/http";
import { cached, HOUR, round } from "./common";

const BASE = "https://www.huduser.gov/hudapi/public";

function token(): string {
  const t = process.env.HUD_API_KEY?.trim();
  if (!t) {
    throw new Error("HUD_API_KEY not configured — register free at https://www.huduser.gov/hudapi/public/register, create a token, and set HUD_API_KEY in the environment.");
  }
  return t;
}

function hudGet<T = any>(path: string, ttl = 24 * HOUR): Promise<T> {
  const t = token();
  return cached(`hud:${path}`, ttl, async () => {
    const res = await jsonFetch<any>(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
      timeoutMs: 15000,
      retries: 1,
    }).catch((e: Error) => {
      if (/HTTP 401/.test(e.message)) throw new Error("HUD API rejected the token (401 Unauthenticated) — check HUD_API_KEY.");
      if (/HTTP 404/.test(e.message)) throw new Error(`HUD API: not found for ${path} — check the entity id / state code / year.`);
      throw e;
    });
    return res as T;
  });
}

const STATE_RE = /^[A-Za-z]{2}$/;

export interface FmrArgs {
  entityId?: string;
  countyFips?: string | number;
  cbsa?: string | number;
  state?: string;
  county?: string;
  year?: number | string;
  list?: string;
  limit?: number;
}

export async function hudFairMarketRents(args: FmrArgs) {
  token(); // fail fast before any network
  const year = args.year != null ? String(args.year).replace(/\D/g, "") : "";
  const yq = year ? `?year=${year}` : "";
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));

  if (args.list) {
    const kind = String(args.list).toLowerCase();
    if (kind === "metros") {
      const rows = await hudGet<any[]>(`/fmr/listMetroAreas`);
      const q = args.county ? String(args.county).toLowerCase() : args.state ? `, ${args.state.toUpperCase()}` : "";
      const out = (Array.isArray(rows) ? rows : []).filter((r) => !q || String(r.area_name ?? "").toLowerCase().includes(q.toLowerCase())).slice(0, limit);
      return { source: "HUD FMR API listMetroAreas", count: out.length, metros: out.map((r) => ({ entityId: r.cbsa_code, name: r.area_name, category: r.category })) };
    }
    if (kind === "counties") {
      if (!args.state || !STATE_RE.test(args.state)) throw new Error("list:'counties' needs state (2-letter code).");
      const rows = await hudGet<any[]>(`/fmr/listCounties/${args.state.toUpperCase()}`);
      const q = args.county ? String(args.county).toLowerCase() : "";
      const out = (Array.isArray(rows) ? rows : []).filter((r) => !q || String(r.county_name ?? "").toLowerCase().includes(q)).slice(0, limit);
      return { source: "HUD FMR API listCounties", state: args.state.toUpperCase(), count: out.length, counties: out.map((r) => ({ entityId: r.fips_code, county: r.county_name, town: r.town_name || undefined, metroStatus: r.metro_status, metroName: r.metro_name || undefined })) };
    }
    throw new Error("list must be 'metros' or 'counties'.");
  }

  // Resolve entity id
  let entityId = args.entityId ? String(args.entityId).trim() : "";
  if (!entityId && args.countyFips != null) {
    const f = String(args.countyFips).replace(/\D/g, "");
    entityId = f.length === 5 ? `${f}99999` : f;
  }
  if (!entityId && args.cbsa != null) {
    const c = String(args.cbsa).replace(/\D/g, "");
    entityId = `METRO${c}M${c}`;
  }
  if (!entityId && args.state && STATE_RE.test(args.state) && !args.county) {
    // whole-state table
    const data = await hudGet<any>(`/fmr/statedata/${args.state.toUpperCase()}${yq}`);
    const d = data?.data ?? data;
    const counties: any[] = d?.counties ?? [];
    const metros: any[] = d?.metroareas ?? [];
    const shape = (r: any) => ({
      name: r.county_name ?? r.metro_name ?? r.area_name,
      entityId: r.fips_code ?? r.code,
      fmr: { studio: round(Number(r.Efficiency), 0), br1: round(Number(r["One-Bedroom"]), 0), br2: round(Number(r["Two-Bedroom"]), 0), br3: round(Number(r["Three-Bedroom"]), 0), br4: round(Number(r["Four-Bedroom"]), 0) },
      fmrPercentile: r.FMR_Percentile ?? r.fmr_percentile,
      statename: undefined,
    });
    return {
      source: "HUD FMR API statedata",
      state: args.state.toUpperCase(),
      year: d?.year ?? year ?? "latest",
      units: "USD per month, whole dollars (gross rent incl. utilities), 40th percentile unless FMR_Percentile says 50",
      counties: counties.slice(0, limit).map(shape),
      metros: metros.slice(0, limit).map(shape),
    };
  }
  if (!entityId && args.county && args.state) {
    const rows = await hudGet<any[]>(`/fmr/listCounties/${args.state.toUpperCase()}`);
    const q = String(args.county).toLowerCase().replace(/\bcounty\b/g, "").trim();
    const hit = (Array.isArray(rows) ? rows : []).find((r) => String(r.county_name ?? "").toLowerCase().replace(/\bcounty\b/g, "").trim() === q) ?? (Array.isArray(rows) ? rows : []).find((r) => String(r.county_name ?? "").toLowerCase().includes(q));
    if (!hit) throw new Error(`No HUD county named '${args.county}' in ${args.state.toUpperCase()}; use list:'counties' to see names.`);
    entityId = hit.fips_code;
  }
  if (!entityId) throw new Error("Pass entityId (e.g. 1704399999 or METRO16980M16980), countyFips (17043), cbsa (16980), county+state, or state alone for the whole state.");

  const data = await hudGet<any>(`/fmr/data/${encodeURIComponent(entityId)}${yq}`);
  const d = data?.data ?? data;
  const basic = d?.basicdata;
  const pick = (r: any) => ({ studio: round(Number(r.Efficiency), 0), br1: round(Number(r["One-Bedroom"]), 0), br2: round(Number(r["Two-Bedroom"]), 0), br3: round(Number(r["Three-Bedroom"]), 0), br4: round(Number(r["Four-Bedroom"]), 0) });
  const out: Record<string, unknown> = {
    source: "HUD Fair Market Rents API (huduser.gov/hudapi/public/fmr), keyed",
    entityId,
    area: d?.county_name ?? d?.area_name ?? d?.metro_name,
    state: d?.statename ?? d?.state_name,
    year: d?.year ?? year ?? "latest",
    smallAreaFmr: Array.isArray(basic),
    units: "USD per month, whole dollars (gross rent incl. utilities); FMR is the 40th percentile of standard-quality rents (50th where noted)",
  };
  if (Array.isArray(basic)) {
    const rows = basic as any[];
    const zips = rows.map((r) => ({ zip: r.zip_code, year: r.year, ...pick(r) }));
    out.zipCount = zips.length;
    out.zips = zips.slice(0, limit);
    const metroRow = rows.find((r) => /metro|area/i.test(String(r.zip_code ?? ""))) ?? null;
    if (metroRow) out.metroWide = pick(metroRow);
  } else if (basic) {
    out.fmr = pick(basic);
    out.fmrPercentile = basic.FMR_Percentile ?? basic.fmr_percentile;
    out.smallAreaStatus = basic.smallarea_status;
  } else {
    out.raw = d;
  }
  return out;
}

export interface UspsArgs {
  zip?: string | number;
  type?: string | number;
  query?: string;
  year?: number | string;
  quarter?: number | string;
  limit?: number;
}

const TYPES: Record<string, number> = {
  "zip-tract": 1, "zip-county": 2, "zip-cbsa": 3, "zip-cbsadiv": 4, "zip-cd": 5,
  "tract-zip": 6, "county-zip": 7, "cbsa-zip": 8, "cbsadiv-zip": 9, "cd-zip": 10,
  "zip-countysub": 11, "countysub-zip": 12,
};

export async function hudUspsCrosswalk(args: UspsArgs) {
  token();
  let type = 2;
  if (args.type != null) {
    const t = String(args.type).toLowerCase().trim();
    type = /^\d+$/.test(t) ? Number(t) : TYPES[t] ?? 0;
    if (!(type >= 1 && type <= 12)) throw new Error(`type must be 1-12 or one of ${Object.keys(TYPES).join(", ")}`);
  }
  const query = args.query ? String(args.query).trim() : args.zip != null ? String(args.zip).replace(/\D/g, "").slice(0, 5) : "";
  if (!query) throw new Error("Pass zip (for zip->X types 1-5, 11) or query (tract/county FIPS/CBSA for the reverse types).");
  const qs = new URLSearchParams({ type: String(type), query });
  if (args.year) qs.set("year", String(args.year));
  if (args.quarter) qs.set("quarter", String(args.quarter));
  const data = await hudGet<any>(`/usps?${qs.toString()}`, 24 * HOUR);
  const d = data?.data ?? data;
  const results: any[] = Array.isArray(d?.results) ? d.results : [];
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 25));
  return {
    source: "HUD USPS ZIP Code Crosswalk API (huduser.gov/hudapi/public/usps), keyed",
    type,
    typeName: Object.entries(TYPES).find(([, v]) => v === type)?.[0],
    query: d?.input ?? query,
    year: d?.year,
    quarter: d?.quarter,
    count: results.length,
    results: results
      .sort((a, b) => Number(b.tot_ratio ?? 0) - Number(a.tot_ratio ?? 0))
      .slice(0, limit)
      .map((r) => ({
        geoid: r.geoid ?? r.zip,
        city: r.city,
        state: r.state,
        resRatioPct: round(Number(r.res_ratio) * 100, 1),
        busRatioPct: round(Number(r.bus_ratio) * 100, 1),
        totRatioPct: round(Number(r.tot_ratio) * 100, 1),
      })),
    units: "ratios = share of the source area's residential / business / total addresses that fall in each target geography (percent)",
  };
}
