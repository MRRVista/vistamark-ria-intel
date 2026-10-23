/**
 * Census Bureau Data API (ACS 5-year Data Profile, ACS detailed tables, County
 * Business Patterns) and the Census Geocoder.
 *
 * Endpoints (verified live 2026-10-22):
 *   https://api.census.gov/data/<year>/acs/acs5/profile?get=...&for=...&in=...&key=...
 *   https://api.census.gov/data/<year>/acs/acs5?get=...&for=...          (detailed B/C tables)
 *   https://api.census.gov/data/<year>/acs/acs5[/profile]/variables/<VAR>.json  (label lookup, keyless)
 *   https://api.census.gov/data/<year>/cbp?get=NAME,NAICS2017_LABEL,ESTAB,EMP,PAYANN&for=county:043&in=state:17&NAICS2017=52&key=...
 *   https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=...&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json
 *
 * KEY: as of 2026 api.census.gov REQUIRES a key for every data request — a
 * keyless GET 302-redirects to /data/missing_key.html (HTTP 200, text/html).
 * The old "500/day keyless" allowance is gone. Keys are free and instant at
 * https://api.census.gov/data/key_signup.html. Metadata (variables.json,
 * geography.json, data.json) and the Geocoder stay keyless.
 *
 * Vintages seen in data.json: acs/acs5/profile 2015–2024; cbp 2014–2023
 * (ZIP level inside cbp via for=zip code:NNNNN from 2019; the separate /zbp
 * dataset stops at 2018).
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, clampInt, countyFips, DAY, HOUR, round, stateFips } from "./common";

const API = "https://api.census.gov/data";
const GEOCODER = "https://geocoding.geo.census.gov/geocoder";

function censusKey(): string {
  const k = process.env.CENSUS_API_KEY?.trim();
  if (!k) {
    throw new Error("CENSUS_API_KEY not configured — api.census.gov now requires a key on every data request; get a free one instantly at https://api.census.gov/data/key_signup.html and set CENSUS_API_KEY.");
  }
  return k;
}

/** GET a Census data endpoint; returns rows as objects keyed by the header row. */
async function censusRows(path: string, params: Record<string, string>, keyed = true): Promise<Record<string, string>[]> {
  const usp = new URLSearchParams(params);
  if (keyed) usp.set("key", censusKey());
  const url = `${API}/${path}?${usp.toString()}`;
  const res = await politeFetch(url, { timeoutMs: 20000, retries: 1, redirect: "follow", headers: { Accept: "application/json" } });
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(ct) || /^\s*</.test(text)) {
    const title = text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    if (/missing key/i.test(title ?? "")) throw new Error("Census API: request was redirected to 'Missing Key' — CENSUS_API_KEY is required.");
    if (/invalid key/i.test(title ?? "")) throw new Error("Census API: 'Invalid Key' — check CENSUS_API_KEY.");
    throw new Error(`Census API returned HTML (${title ?? "no title"}) for ${redactUrl(url)}`);
  }
  if (res.status === 204 || !text.trim()) {
    throw new Error(`Census API: no data (HTTP ${res.status}) for ${redactUrl(url)} — the geography or variable is probably not published in this vintage.`);
  }
  if (!res.ok) throw new Error(`Census API HTTP ${res.status} for ${redactUrl(url)}: ${redactUrl(text).slice(0, 200)}`);
  let arr: string[][];
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error(`Census API: unparseable response for ${redactUrl(url)}: ${text.slice(0, 120)}`);
  }
  const [header, ...rows] = arr;
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** Newest vintage that exists for a dataset path (probes variables.json, keyless, cached 1 day). */
function newestVintage(dataset: string, candidates: number[]): Promise<number> {
  return cached(`census:vintage:${dataset}`, 1 * DAY, async () => {
    for (const y of candidates) {
      try {
        const res = await politeFetch(`${API}/${y}/${dataset}/variables/NAME.json`, { timeoutMs: 8000, retries: 0 });
        if (res.ok) return y;
      } catch {
        /* try next */
      }
    }
    return candidates[candidates.length - 1]!;
  });
}

const thisYear = new Date().getFullYear();
const ACS_CANDIDATES = [thisYear - 1, thisYear - 2, thisYear - 3];
const CBP_CANDIDATES = [thisYear - 2, thisYear - 3, thisYear - 4];

/** Label lookup for one variable (keyless metadata), cached 7 days. */
export function variableLabel(dataset: string, year: number, v: string): Promise<{ label: string; concept?: string } | null> {
  return cached(`census:var:${year}:${dataset}:${v}`, 7 * DAY, async () => {
    try {
      const res = await politeFetch(`${API}/${year}/${dataset}/variables/${encodeURIComponent(v)}.json`, { timeoutMs: 8000, retries: 0 });
      if (!res.ok) return null;
      const j = (await res.json()) as { label?: string; concept?: string };
      return j.label ? { label: j.label.replace(/!!/g, " > "), concept: j.concept } : null;
    } catch {
      return null;
    }
  });
}

// ---------- geography resolution ----------

export interface Geo {
  kind: "zcta" | "county" | "place" | "state" | "tract" | "us" | "msa" | "zip";
  for: string;
  in?: string;
  label: string;
}

/** Build the for/in clauses from the tool args. */
export function resolveGeo(args: any): Geo {
  const zcta = args?.zcta ?? args?.zip ?? args?.zipcode;
  const place = args?.place;
  const county = args?.county ?? args?.countyFips;
  const tract = args?.tract;
  const msa = args?.msa ?? args?.cbsa;
  const st = stateFips(args?.state);
  if (zcta) {
    const z = String(zcta).replace(/\D/g, "").padStart(5, "0");
    if (z.length !== 5) throw new Error("zcta must be a 5-digit ZIP/ZCTA, e.g. 60521");
    return { kind: "zcta", for: `zip code tabulation area:${z}`, label: `ZCTA ${z}` };
  }
  if (tract) {
    const cf = countyFips(county, args?.state);
    if (!cf) throw new Error("tract requires county (5-digit FIPS, e.g. 17043); tract is the 6-digit code (e.g. 844601) or the 11-digit GEOID");
    const t = String(tract).replace(/\D/g, "");
    const t6 = t.length === 11 ? t.slice(5) : t.padStart(6, "0");
    return { kind: "tract", for: `tract:${t6}`, in: `state:${cf.state} county:${cf.county}`, label: `Tract ${t6}, county ${cf.state}${cf.county}` };
  }
  if (place) {
    const p = String(place).replace(/\D/g, "");
    if (p.length === 7) return { kind: "place", for: `place:${p.slice(2)}`, in: `state:${p.slice(0, 2)}`, label: `Place ${p}` };
    if (!st) throw new Error("place needs state (e.g. state:'IL', place:'35307' for Hinsdale village) or a 7-digit GEOID like 1735307");
    return { kind: "place", for: `place:${p.padStart(5, "0")}`, in: `state:${st}`, label: `Place ${st}${p.padStart(5, "0")}` };
  }
  if (msa) {
    const m = String(msa).replace(/\D/g, "");
    return { kind: "msa", for: `metropolitan statistical area/micropolitan statistical area:${m}`, label: `CBSA ${m}` };
  }
  if (county) {
    const cf = countyFips(county, args?.state);
    if (!cf) throw new Error("county must be a 5-digit FIPS (17043 DuPage, 17031 Cook) or a 3-digit code with state");
    return { kind: "county", for: `county:${cf.county}`, in: `state:${cf.state}`, label: `County ${cf.state}${cf.county}` };
  }
  if (st) return { kind: "state", for: `state:${st}`, label: `State ${st}` };
  if (args?.us) return { kind: "us", for: "us:1", label: "United States" };
  return { kind: "zcta", for: "zip code tabulation area:60521", label: "ZCTA 60521 (default: Hinsdale IL)" };
}

// ---------- ACS Data Profile ----------

/** Curated wealth-prospecting profile. Verified against 2024 acs5/profile variables.json. */
const PROFILE_VARS: Array<{ v: string; key: string; label: string; kind: "count" | "usd" | "pct" | "num" }> = [
  { v: "DP05_0001E", key: "population", label: "Total population", kind: "count" },
  { v: "DP02_0001E", key: "households", label: "Households", kind: "count" },
  { v: "DP02_0016E", key: "avgHouseholdSize", label: "Average household size", kind: "num" },
  { v: "DP05_0018E", key: "medianAge", label: "Median age", kind: "num" },
  { v: "DP05_0019PE", key: "pctUnder18", label: "% under 18", kind: "pct" },
  { v: "DP05_0024PE", key: "pct65Plus", label: "% 65 and over", kind: "pct" },
  { v: "DP02_0002PE", key: "pctMarriedCoupleHH", label: "% married-couple households", kind: "pct" },
  { v: "DP03_0062E", key: "medianHouseholdIncome", label: "Median household income", kind: "usd" },
  { v: "DP03_0063E", key: "meanHouseholdIncome", label: "Mean household income", kind: "usd" },
  { v: "DP03_0086E", key: "medianFamilyIncome", label: "Median family income", kind: "usd" },
  { v: "DP03_0088E", key: "perCapitaIncome", label: "Per capita income", kind: "usd" },
  { v: "DP03_0061PE", key: "pctHH200kPlus", label: "% households with income $200K+", kind: "pct" },
  { v: "DP03_0060PE", key: "pctHH150to200k", label: "% households $150K–$199,999", kind: "pct" },
  { v: "DP03_0068PE", key: "pctHHRetirementIncome", label: "% households with retirement income", kind: "pct" },
  { v: "DP03_0069E", key: "meanRetirementIncome", label: "Mean retirement income (of those with it)", kind: "usd" },
  { v: "DP03_0066PE", key: "pctHHSocialSecurity", label: "% households with Social Security", kind: "pct" },
  { v: "DP03_0119PE", key: "pctFamiliesPoverty", label: "% families below poverty", kind: "pct" },
  { v: "DP02_0068PE", key: "pctBachelorsPlus", label: "% 25+ with bachelor's or higher", kind: "pct" },
  { v: "DP02_0066PE", key: "pctGraduateDegree", label: "% 25+ with graduate/professional degree", kind: "pct" },
  { v: "DP03_0002PE", key: "pctInLaborForce", label: "% 16+ in labor force", kind: "pct" },
  { v: "DP03_0009PE", key: "unemploymentRate", label: "Unemployment rate (civilian LF)", kind: "pct" },
  { v: "DP03_0027PE", key: "pctMgmtBusSciArts", label: "% employed in management/business/science/arts occupations", kind: "pct" },
  { v: "DP03_0040PE", key: "pctFinanceInsRealEstate", label: "% employed in finance, insurance, real estate", kind: "pct" },
  { v: "DP03_0049PE", key: "pctSelfEmployedUnincorp", label: "% self-employed (unincorporated)", kind: "pct" },
  { v: "DP04_0001E", key: "housingUnits", label: "Housing units", kind: "count" },
  { v: "DP04_0046PE", key: "pctOwnerOccupied", label: "% owner-occupied", kind: "pct" },
  { v: "DP04_0089E", key: "medianHomeValue", label: "Median owner-occupied home value", kind: "usd" },
  { v: "DP04_0088PE", key: "pctHomes1MPlus", label: "% owner-occupied homes valued $1M+", kind: "pct" },
  { v: "DP04_0087PE", key: "pctHomes500kTo1M", label: "% owner-occupied homes $500K–$999,999", kind: "pct" },
  { v: "DP04_0091PE", key: "pctOwnersWithMortgage", label: "% owner units with a mortgage", kind: "pct" },
  { v: "DP04_0101E", key: "medianOwnerCostWithMortgage", label: "Median monthly owner cost (with mortgage)", kind: "usd" },
  { v: "DP04_0134E", key: "medianGrossRent", label: "Median gross rent", kind: "usd" },
  { v: "DP04_0003PE", key: "pctVacant", label: "% housing units vacant", kind: "pct" },
  { v: "DP02_0094PE", key: "pctForeignBorn", label: "% foreign-born", kind: "pct" },
  { v: "DP02_0070PE", key: "pctVeterans", label: "% civilian adults who are veterans", kind: "pct" },
];

const SECTIONS: Record<string, string[]> = {
  people: ["population", "households", "avgHouseholdSize", "medianAge", "pctUnder18", "pct65Plus", "pctMarriedCoupleHH", "pctForeignBorn", "pctVeterans"],
  income: ["medianHouseholdIncome", "meanHouseholdIncome", "medianFamilyIncome", "perCapitaIncome", "pctHH200kPlus", "pctHH150to200k", "pctHHRetirementIncome", "meanRetirementIncome", "pctHHSocialSecurity", "pctFamiliesPoverty"],
  education_work: ["pctBachelorsPlus", "pctGraduateDegree", "pctInLaborForce", "unemploymentRate", "pctMgmtBusSciArts", "pctFinanceInsRealEstate", "pctSelfEmployedUnincorp"],
  housing: ["housingUnits", "pctOwnerOccupied", "medianHomeValue", "pctHomes1MPlus", "pctHomes500kTo1M", "pctOwnersWithMortgage", "medianOwnerCostWithMortgage", "medianGrossRent", "pctVacant"],
};

function acsValue(raw: string | undefined, kind: string): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Census sentinel values: -666666666 (not available), -999999999 (suppressed), -888888888 (n/a), -222222222 (median too few)
  if (n <= -222222222) return null;
  return kind === "pct" || kind === "num" ? round(n, 1) : Math.round(n);
}

export async function censusAcsProfile(args: any): Promise<any> {
  censusKey();
  const geo = resolveGeo(args);
  const year = args?.year ? clampInt(args.year, thisYear - 1, 2015, thisYear) : await newestVintage("acs/acs5/profile", ACS_CANDIDATES);
  const sectionArg: string[] | null = Array.isArray(args?.sections) ? args.sections.map(String) : args?.sections ? [String(args.sections)] : null;
  let vars = PROFILE_VARS;
  if (sectionArg && sectionArg.length) {
    const keys = new Set(sectionArg.flatMap((s) => SECTIONS[s] ?? []));
    if (!keys.size) throw new Error(`sections must be among ${Object.keys(SECTIONS).join(", ")}`);
    vars = PROFILE_VARS.filter((p) => keys.has(p.key));
  }
  const compare = args?.compare !== false && geo.kind !== "state" && geo.kind !== "us";
  const stateCode = geo.in?.match(/state:(\d{2})/)?.[1] ?? (geo.kind === "state" ? geo.for.split(":")[1] : null);

  const fetchOne = (g: Geo) => {
    const params: Record<string, string> = { get: ["NAME", ...vars.map((p) => p.v)].join(","), for: g.for };
    if (g.in) params.in = g.in;
    return cached(`census:profile:${year}:${g.for}:${g.in ?? ""}:${vars.length}`, 7 * DAY, () => censusRows(`${year}/acs/acs5/profile`, params));
  };
  const targets: Array<{ role: string; geo: Geo }> = [{ role: "target", geo }];
  if (compare) {
    if (stateCode) targets.push({ role: "state", geo: { kind: "state", for: `state:${stateCode}`, label: `State ${stateCode}` } });
    targets.push({ role: "us", geo: { kind: "us", for: "us:1", label: "United States" } });
  }
  const results = await Promise.all(targets.map((t) => fetchOne(t.geo).then((rows) => ({ ...t, row: rows[0] }), (e: any) => ({ ...t, row: undefined as Record<string, string> | undefined, error: String(e?.message ?? e) }))));
  const target = results[0]!;
  if (!target.row) throw new Error((target as any).error ?? `Census ACS: no row for ${geo.label} in ${year} — ZCTAs/places not in the 5-year file return nothing`);

  const shape = (row: Record<string, string>) => {
    const o: Record<string, number | null> = {};
    for (const p of vars) o[p.key] = acsValue(row[p.v], p.kind);
    return o;
  };
  const tv = shape(target.row);
  const comparisons: Record<string, any> = {};
  for (const r of results.slice(1)) {
    if (r.row) comparisons[r.role] = { name: r.row.NAME, ...shape(r.row) };
  }
  return {
    source: `Census ACS 5-year Data Profile (DP02–DP05), ${year - 4}–${year} vintage`,
    fetchedAt: new Date().toISOString(),
    vintage: year,
    geography: { ...geo, name: target.row.NAME },
    profile: tv,
    comparisons: Object.keys(comparisons).length ? comparisons : undefined,
    fieldGuide: Object.fromEntries(vars.map((p) => [p.key, `${p.label} [${p.v}; ${p.kind}]`])),
    notes: [
      "Dollar figures are inflation-adjusted to the vintage year. ZCTA estimates carry wide margins of error (use census_acs_variable with the M suffix for MOE).",
      "ZIP ≠ ZCTA exactly: ZCTAs approximate USPS ZIP delivery areas.",
    ],
  };
}

// ---------- any ACS variable ----------

export async function censusAcsVariable(args: any): Promise<any> {
  const raw: unknown[] = Array.isArray(args?.variables) ? args.variables : args?.variables ? String(args.variables).split(",") : [];
  const vars = raw.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
  if (!vars.length) throw new Error("variables is required, e.g. ['B19013_001E','B25077_001E'] (detailed tables) or ['DP03_0062E'] (profile)");
  if (vars.length > 40) throw new Error("variables: at most 40 per call");
  censusKey();
  const geo = resolveGeo(args);
  const explicitDs = args?.dataset ? String(args.dataset) : null;
  const dataset = explicitDs ?? (vars.every((v) => /^DP\d{2}_/.test(v)) ? "acs/acs5/profile" : vars.every((v) => /^S\d{4}_/.test(v)) ? "acs/acs5/subject" : vars.every((v) => /^CP\d{2}_/.test(v)) ? "acs/acs5/cprofile" : "acs/acs5");
  const year = args?.year ? clampInt(args.year, thisYear - 1, 2010, thisYear) : await newestVintage(dataset, ACS_CANDIDATES);
  const wildcard = args?.all === true; // e.g. all counties in a state
  let forClause = geo.for;
  if (wildcard) {
    const [lvl] = geo.for.split(":");
    forClause = `${lvl}:*`;
  }
  const params: Record<string, string> = { get: ["NAME", ...vars].join(","), for: forClause };
  if (geo.in) params.in = geo.in;
  const rows = await cached(`census:var:${year}:${dataset}:${params.get}:${forClause}:${geo.in ?? ""}`, 7 * DAY, () => censusRows(`${year}/${dataset}`, params));
  const limit = clampInt(args?.limit, 25, 1, 200);
  const labels = await Promise.all(vars.slice(0, 12).map((v) => variableLabel(dataset, year, v).then((l) => [v, l?.label ?? null] as const)));
  const shaped = rows.map((r) => {
    const o: Record<string, unknown> = { name: r.NAME };
    for (const v of vars) o[v] = acsValue(r[v], /PE$|PM$/.test(v) ? "pct" : "count");
    return o;
  });
  const sortBy = args?.sortBy ? String(args.sortBy).toUpperCase() : null;
  if (sortBy && vars.includes(sortBy)) shaped.sort((a: any, b: any) => (Number(b[sortBy]) || -Infinity) - (Number(a[sortBy]) || -Infinity));
  return {
    source: `Census ${dataset} ${year}`,
    fetchedAt: new Date().toISOString(),
    vintage: year,
    geography: wildcard ? { ...geo, for: forClause, label: `all ${forClause.split(":")[0]} in ${geo.in ?? "US"}` } : geo,
    labels: Object.fromEntries(labels),
    rows: shaped.slice(0, limit),
    rowCount: shaped.length,
  };
}

// ---------- County Business Patterns ----------

export async function censusCbp(args: any): Promise<any> {
  censusKey();
  const year = args?.year ? clampInt(args.year, thisYear - 2, 2012, thisYear) : await newestVintage("cbp", CBP_CANDIDATES);
  const naicsRaw: string[] = Array.isArray(args?.naics) ? args.naics.map(String) : args?.naics != null ? String(args.naics).split(",").map((s: string) => s.trim()) : [];
  const naicsField = year >= 2017 ? "NAICS2017" : "NAICS2012";
  const limit = clampInt(args?.limit, 25, 1, 100);

  // Geography: zip (5-digit ZIP, in cbp since 2019), county, state, msa.
  let forClause: string;
  let inClause: string | undefined;
  let label: string;
  if (args?.zip ?? args?.zcta) {
    const z = String(args.zip ?? args.zcta).replace(/\D/g, "").padStart(5, "0");
    forClause = `zip code:${z}`;
    label = `ZIP ${z}`;
  } else {
    const geo = resolveGeo({ ...args, zcta: undefined, zip: undefined });
    if (geo.kind === "zcta") throw new Error("CBP needs a county (17043), state, msa or zip");
    forClause = geo.for;
    inClause = geo.in;
    label = geo.label;
  }
  const params: Record<string, string> = { get: ["NAME", `${naicsField}_LABEL`, "ESTAB", "EMP", "PAYANN"].join(","), for: forClause };
  if (inClause) params.in = inClause;
  params.LFO = "001";
  params.EMPSZES = "001";
  // Industry: explicit codes, or all 2-digit sectors + total.
  let rows: Record<string, string>[];
  if (naicsRaw.length) {
    const parts = await Promise.all(
      naicsRaw.map((n) => cached(`census:cbp:${year}:${forClause}:${inClause ?? ""}:${n}`, 7 * DAY, () => censusRows(`${year}/cbp`, { ...params, [naicsField]: n })))
    );
    rows = parts.flat();
  } else {
    rows = await cached(`census:cbp:${year}:${forClause}:${inClause ?? ""}:*`, 7 * DAY, () => censusRows(`${year}/cbp`, { ...params, [naicsField]: "*" }));
    rows = rows.filter((r) => {
      const c = r[naicsField] ?? "";
      return c === "00" || /^\d{2}(-\d{2})?$/.test(c);
    });
  }
  const shaped = rows.map((r) => ({
    naics: r[naicsField],
    industry: (r[`${naicsField}_LABEL`] ?? "").replace(/^Total for all sectors$/i, "Total, all sectors"),
    establishments: Number(r.ESTAB) || 0,
    employees: Number(r.EMP) || 0,
    annualPayrollUSD: (Number(r.PAYANN) || 0) * 1000,
    avgPayPerEmployeeUSD: Number(r.EMP) > 0 ? Math.round(((Number(r.PAYANN) || 0) * 1000) / Number(r.EMP)) : null,
  }));
  shaped.sort((a, b) => b.establishments - a.establishments);
  return {
    source: `Census County Business Patterns ${year}`,
    fetchedAt: new Date().toISOString(),
    vintage: year,
    geography: { label, name: rows[0]?.NAME },
    rows: shaped.slice(0, limit),
    rowCount: shaped.length,
    notes: [
      "March-12 employment and annual payroll for establishments with paid employees (excludes self-employed, most government, railroads, farms). PAYANN published in $1,000s — converted to USD here.",
      "EMP/PAYANN may be noise-infused or withheld (0) in small cells; ESTAB is always exact.",
    ],
  };
}

// ---------- Geocoder ----------

function pick(g: Record<string, any[]> | undefined, key: string) {
  const arr = g?.[key];
  const o = arr?.[0];
  return o ? { geoid: o.GEOID, name: o.NAME } : null;
}

export async function censusGeocode(args: any): Promise<any> {
  const address = args?.address ? String(args.address).trim() : "";
  const lat = args?.lat != null ? Number(args.lat) : null;
  const lon = args?.lon != null ? Number(args.lon) : args?.lng != null ? Number(args.lng) : null;
  let url: string;
  if (address) {
    const usp = new URLSearchParams({ address, benchmark: "Public_AR_Current", vintage: "Current_Current", layers: "all", format: "json" });
    url = `${GEOCODER}/geographies/onelineaddress?${usp}`;
  } else if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    const usp = new URLSearchParams({ x: String(lon), y: String(lat), benchmark: "Public_AR_Current", vintage: "Current_Current", layers: "all", format: "json" });
    url = `${GEOCODER}/geographies/coordinates?${usp}`;
  } else {
    throw new Error("address (one line, e.g. '15 Salt Creek Ln, Hinsdale, IL 60521') or lat+lon is required");
  }
  const j = await cached(`census:geocode:${url}`, 7 * DAY, async () => {
    const res = await politeFetch(url, { timeoutMs: 20000, retries: 1, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Census Geocoder HTTP ${res.status}`);
    return (await res.json()) as any;
  });
  let geogs: Record<string, any[]> | undefined;
  let matched: any = null;
  if (address) {
    const m = j?.result?.addressMatches?.[0];
    if (!m) return { source: "Census Geocoder (Public_AR_Current / Current_Current)", fetchedAt: new Date().toISOString(), input: address, matched: false, hint: "No match — include city/state/ZIP, spell out the street type, or try a nearby intersection." };
    matched = { address: m.matchedAddress, lat: m.coordinates?.y, lon: m.coordinates?.x, tigerLineId: m.tigerLine?.tigerLineId, side: m.tigerLine?.side };
    geogs = m.geographies;
  } else {
    geogs = j?.result?.geographies;
    matched = { lat, lon };
  }
  const county = pick(geogs, "Counties");
  const tract = pick(geogs, "Census Tracts");
  const block = pick(geogs, "2020 Census Blocks");
  const zcta = pick(geogs, "2020 Census ZIP Code Tabulation Areas");
  const place = pick(geogs, "Incorporated Places");
  const state = pick(geogs, "States");
  const cdKey = Object.keys(geogs ?? {}).find((k) => /Congressional Districts/.test(k));
  const sldu = Object.keys(geogs ?? {}).find((k) => /Legislative Districts - Upper/.test(k));
  const sldl = Object.keys(geogs ?? {}).find((k) => /Legislative Districts - Lower/.test(k));
  const out = {
    source: "Census Geocoder (benchmark Public_AR_Current, vintage Current_Current)",
    fetchedAt: new Date().toISOString(),
    matched: true,
    ...matched,
    state: state ? { fips: state.geoid, name: state.name } : null,
    county: county ? { fips: county.geoid, name: county.name } : null,
    place: place ? { geoid: place.geoid, name: place.name } : null,
    countySubdivision: pick(geogs, "County Subdivisions"),
    tract: tract ? { geoid: tract.geoid, name: tract.name } : null,
    blockGroup: tract && block ? { geoid: String(block.geoid).slice(0, 12) } : null,
    block: block ? { geoid: block.geoid } : null,
    zcta: zcta ? zcta.geoid : null,
    msa: pick(geogs, "Metropolitan Statistical Areas"),
    csa: pick(geogs, "Combined Statistical Areas"),
    congressionalDistrict: cdKey ? { ...pick(geogs, cdKey), congress: cdKey.match(/^(\d+)/)?.[1] } : null,
    stateSenateDistrict: sldu ? pick(geogs, sldu) : null,
    stateHouseDistrict: sldl ? pick(geogs, sldl) : null,
    schoolDistricts: {
      unified: pick(geogs, "Unified School Districts"),
      elementary: pick(geogs, "Elementary School Districts"),
      secondary: pick(geogs, "Secondary School Districts"),
    },
    nextSteps: county ? `census_acs_profile {county:'${county.geoid}'}${zcta ? ` or {zcta:'${zcta.geoid}'}` : ""}; census_cbp {county:'${county.geoid}'}; bls_qcew_county {area:'${county.geoid}'}` : undefined,
  };
  return out;
}
