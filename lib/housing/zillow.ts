/**
 * Zillow Research public CSVs (keyless, refreshed monthly ~3rd week for the
 * prior month; verified live 2026-10-22, Last-Modified 2026-10-16).
 *
 *   https://files.zillowstatic.com/research/public_csvs/<dataset>/<Geo>_<file>.csv
 *
 * Wide layout: metadata columns, then one column per month-end date.
 *   zip:    RegionID,SizeRank,RegionName,RegionType,StateName,State,City,Metro,CountyName,<dates>
 *   city:   RegionID,SizeRank,RegionName,RegionType,StateName,State,Metro,CountyName,<dates>
 *   county: RegionID,SizeRank,RegionName,RegionType,StateName,State,Metro,StateCodeFIPS,MunicipalCodeFIPS,<dates>
 *   metro:  RegionID,SizeRank,RegionName ("Chicago, IL"; row 0 = United States),RegionType,StateName,<dates>
 *   state:  same as metro
 * Rows are sorted by SizeRank, NOT by zip, so a zip lookup must scan the file.
 *
 * Size and strategy (measured in the sandbox, Node 22, through the proxy):
 *   Zip ZHVI 117-125 MB, City ZHVI 95 MB, Neighborhood 104 MB -> stream + filter,
 *     ~3.5 s and <100 MB RSS; the matched rows are cached 12 h per query.
 *   Everything else (0.05-20 MB) -> downloaded once, parsed into compact
 *     Float64Array rows and cached 12 h.
 * The alternative (one 12 h {zip -> row} index per lambda) would cost ~75 MB of
 * heap per tier/type combination and only pay off after the first call in a
 * warm lambda, so per-query streaming was kept: cold cost is the same, warm
 * repeat lookups of the same place are served from cache either way.
 */
import { cached, clampInt, HOUR, norm, round, shapeSeries, splitCsv, streamCsvLines, wideRowToSeries, type SeriesPoint, type SeriesShape } from "./common";

const BASE = "https://files.zillowstatic.com/research/public_csvs";
const STREAM_THRESHOLD_BYTES = 20 * 1024 * 1024;

export type Geo = "zip" | "city" | "county" | "metro" | "state" | "neighborhood";
const GEO_FILE: Record<Geo, string> = { zip: "Zip", city: "City", county: "County", metro: "Metro", state: "State", neighborhood: "Neighborhood" };

export interface ZillowDatasetDef {
  key: string;
  dir: string;
  /** file stem after the geo prefix, with {geo} already stripped */
  stem: string;
  geos: Geo[];
  unit: "usd" | "pct_share" | "days" | "count" | "index" | "ratio" | "pct";
  label: string;
  note?: string;
  /** large files (approx bytes) by geo; anything missing is assumed small */
  big?: Partial<Record<Geo, number>>;
  forecast?: boolean;
}

/** Verified live 2026-10-22 (HEAD 200 with content-length) unless noted. */
export const ZILLOW_DATASETS: ZillowDatasetDef[] = [
  { key: "zhvi", dir: "zhvi", stem: "zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month", geos: ["zip", "city", "county", "metro", "state", "neighborhood"], unit: "usd", label: "ZHVI typical home value, mid tier (35th-65th pct), SFR+condo, smoothed, SA", big: { zip: 124e6, city: 95e6, neighborhood: 104e6 } },
  { key: "zhvi_top", dir: "zhvi", stem: "zhvi_uc_sfrcondo_tier_0.67_1.0_sm_sa_month", geos: ["zip", "city", "county", "metro", "state"], unit: "usd", label: "ZHVI top tier (65th-95th pct)", big: { zip: 125e6, city: 95e6 } },
  { key: "zhvi_bottom", dir: "zhvi", stem: "zhvi_uc_sfrcondo_tier_0.0_0.33_sm_sa_month", geos: ["zip", "city", "county", "metro", "state"], unit: "usd", label: "ZHVI bottom tier (5th-35th pct)", big: { zip: 117e6, city: 95e6 } },
  { key: "zhvi_sfr", dir: "zhvi", stem: "zhvi_uc_sfr_tier_0.33_0.67_sm_sa_month", geos: ["zip", "city", "county", "metro", "state"], unit: "usd", label: "ZHVI single-family only, mid tier", big: { zip: 123e6, city: 95e6 } },
  { key: "zhvi_sfr_top", dir: "zhvi", stem: "zhvi_uc_sfr_tier_0.67_1.0_sm_sa_month", geos: ["zip", "city", "county", "metro", "state"], unit: "usd", label: "ZHVI single-family, top tier", big: { zip: 124e6, city: 95e6 } },
  { key: "zhvi_condo", dir: "zhvi", stem: "zhvi_uc_condo_tier_0.33_0.67_sm_sa_month", geos: ["zip", "city", "county", "metro", "state"], unit: "usd", label: "ZHVI condo/co-op only, mid tier", big: { zip: 31e6, city: 30e6 } },
  { key: "zhvi_4br", dir: "zhvi", stem: "zhvi_bdrmcnt_4_uc_sfrcondo_tier_0.33_0.67_sm_sa_month", geos: ["zip", "city", "county", "metro", "state"], unit: "usd", label: "ZHVI 4-bedroom homes", big: { zip: 77e6, city: 60e6 } },
  { key: "zhvi_5br", dir: "zhvi", stem: "zhvi_bdrmcnt_5_uc_sfrcondo_tier_0.33_0.67_sm_sa_month", geos: ["zip", "city", "county", "metro", "state"], unit: "usd", label: "ZHVI 5+ bedroom homes", big: { zip: 42e6, city: 35e6 } },
  { key: "zhvf_growth", dir: "zhvf_growth", stem: "zhvf_growth_uc_sfrcondo_tier_0.33_0.67_sm_sa_month", geos: ["zip", "metro"], unit: "pct", label: "Zillow Home Value Forecast: expected % growth 1m / 3m / 12m from BaseDate", forecast: true },
  { key: "zori", dir: "zori", stem: "zori_uc_sfrcondomfr_sm_sa_month", geos: ["zip", "city", "county", "metro"], unit: "usd", label: "ZORI observed asking rent, all homes (SFR+condo+multifamily), smoothed, SA; since 2015" },
  { key: "zori_sfr", dir: "zori", stem: "zori_uc_sfr_sm_sa_month", geos: ["metro"], unit: "usd", label: "ZORI single-family rent" },
  { key: "inventory", dir: "invt_fs", stem: "invt_fs_uc_sfrcondo_sm_month", geos: ["zip", "county", "metro"], unit: "count", label: "For-sale inventory (active listings, monthly avg), smoothed; since 2018" },
  { key: "inventory_weekly", dir: "invt_fs", stem: "invt_fs_uc_sfrcondo_sm_week", geos: ["metro"], unit: "count", label: "For-sale inventory, weekly" },
  { key: "new_listings", dir: "new_listings", stem: "new_listings_uc_sfrcondo_sm_month", geos: ["zip", "county", "metro"], unit: "count", label: "New listings per month" },
  { key: "new_pending", dir: "new_pending", stem: "new_pending_uc_sfrcondo_sm_month", geos: ["county", "metro"], unit: "count", label: "Newly pending listings per month" },
  { key: "median_sale_price", dir: "median_sale_price", stem: "median_sale_price_uc_sfrcondo_sm_sa_month", geos: ["zip", "county", "metro"], unit: "usd", label: "Median sale price, smoothed, SA; since 2008" },
  { key: "median_sale_price_raw", dir: "median_sale_price", stem: "median_sale_price_uc_sfrcondo_month", geos: ["metro"], unit: "usd", label: "Median sale price, raw" },
  { key: "sales_count", dir: "sales_count_now", stem: "sales_count_now_uc_sfrcondo_month", geos: ["metro"], unit: "count", label: "Home sales count (nowcast); since 2008" },
  { key: "median_list_price", dir: "mlp", stem: "mlp_uc_sfrcondo_sm_month", geos: ["zip", "county", "metro"], unit: "usd", label: "Median list price, smoothed" },
  { key: "days_to_pending_mean", dir: "mean_doz_pending", stem: "mean_doz_pending_uc_sfrcondo_sm_month", geos: ["zip", "county", "metro"], unit: "days", label: "Mean days to pending" },
  { key: "days_to_pending_median", dir: "med_doz_pending", stem: "med_doz_pending_uc_sfrcondo_sm_month", geos: ["zip", "county", "metro"], unit: "days", label: "Median days to pending" },
  { key: "days_to_close_mean", dir: "mean_days_to_close", stem: "mean_days_to_close_uc_sfrcondo_sm_month", geos: ["metro"], unit: "days", label: "Mean days to close" },
  { key: "pct_listings_price_cut", dir: "perc_listings_price_cut", stem: "perc_listings_price_cut_uc_sfrcondo_sm_month", geos: ["zip", "county", "metro"], unit: "pct_share", label: "Share of listings with a price cut (%)" },
  { key: "mean_price_cut_amt", dir: "mean_listings_price_cut_amt", stem: "mean_listings_price_cut_amt_uc_sfrcondo_sm_month", geos: ["metro"], unit: "usd", label: "Mean price cut, $" },
  { key: "mean_price_cut_pct", dir: "mean_listings_price_cut_perc", stem: "mean_listings_price_cut_perc_uc_sfrcondo_sm_month", geos: ["metro"], unit: "pct_share", label: "Mean price cut, % of list" },
  { key: "sale_to_list", dir: "median_sale_to_list", stem: "median_sale_to_list_uc_sfrcondo_sm_month", geos: ["county", "metro"], unit: "ratio", label: "Median sale-to-list ratio" },
  { key: "pct_sold_above_list", dir: "pct_sold_above_list", stem: "pct_sold_above_list_uc_sfrcondo_sm_month", geos: ["metro"], unit: "pct_share", label: "Share of sales above list (%)" },
  { key: "pct_sold_below_list", dir: "pct_sold_below_list", stem: "pct_sold_below_list_uc_sfrcondo_sm_month", geos: ["metro"], unit: "pct_share", label: "Share of sales below list (%)" },
  { key: "market_heat", dir: "market_temp_index", stem: "market_temp_index_uc_sfrcondo_month", geos: ["zip", "county", "metro"], unit: "index", label: "Zillow Market Heat Index (higher = seller's market; ~70+ strong sellers, <44 buyers); since 2019" },
  { key: "new_construction_median_price", dir: "new_con_median_sale_price", stem: "new_con_median_sale_price_uc_sfrcondo_month", geos: ["metro"], unit: "usd", label: "New-construction median sale price" },
  { key: "new_construction_sales", dir: "new_con_sales_count_raw", stem: "new_con_sales_count_raw_uc_sfrcondo_month", geos: ["metro"], unit: "count", label: "New-construction sales count" },
  { key: "income_needed", dir: "new_homeowner_income_needed", stem: "new_homeowner_income_needed_downpayment_0.20_uc_sfrcondo_tier_0.33_0.67_sm_sa_month", geos: ["metro"], unit: "usd", label: "Income needed to afford the typical home (20% down)" },
  { key: "affordability", dir: "new_homeowner_affordability", stem: "new_homeowner_affordability_downpayment_0.20_uc_sfrcondo_tier_0.33_0.67_sm_sa_month", geos: ["metro"], unit: "pct_share", label: "New-homeowner affordability: mortgage payment as % of median income (20% down)" },
  { key: "monthly_payment", dir: "total_monthly_payment", stem: "total_monthly_payment_downpayment_0.20_uc_sfrcondo_tier_0.33_0.67_sm_sa_month", geos: ["metro"], unit: "usd", label: "Total monthly payment on the typical home (20% down)" },
];

const BY_KEY = new Map(ZILLOW_DATASETS.map((d) => [d.key, d]));

export function zillowUrl(def: ZillowDatasetDef, geo: Geo): string {
  return `${BASE}/${def.dir}/${GEO_FILE[geo]}_${def.stem}.csv`;
}

interface Meta {
  regionId: string;
  sizeRank: number;
  name: string;
  type: string;
  state: string;
  city?: string;
  metro?: string;
  county?: string;
  fips?: string;
}

interface Row {
  meta: Meta;
  values: Float64Array; // aligned to header dates, NaN = missing
}

interface Table {
  header: string[];
  dates: string[];
  firstDateCol: number;
  rows: Row[];
  fetchedAt: string;
}

function headerInfo(header: string[]) {
  let firstDateCol = header.findIndex((h) => /^\d{4}-\d{2}-\d{2}$/.test(h));
  if (firstDateCol < 0) firstDateCol = header.length;
  const idx = (n: string) => header.indexOf(n);
  const cols = {
    id: idx("RegionID"),
    rank: idx("SizeRank"),
    name: idx("RegionName"),
    type: idx("RegionType"),
    state: idx("State") >= 0 ? idx("State") : idx("StateName"),
    city: idx("City"),
    metro: idx("Metro"),
    county: idx("CountyName"),
    stFips: idx("StateCodeFIPS"),
    muFips: idx("MunicipalCodeFIPS"),
  };
  return { firstDateCol, cols };
}

function metaOf(cells: string[], cols: ReturnType<typeof headerInfo>["cols"]): Meta {
  const g = (i: number) => (i >= 0 ? (cells[i] ?? "") : "");
  const m: Meta = {
    regionId: g(cols.id),
    sizeRank: Number(g(cols.rank)) || 0,
    name: g(cols.name),
    type: g(cols.type),
    state: g(cols.state),
  };
  if (cols.city >= 0) m.city = g(cols.city);
  if (cols.metro >= 0) m.metro = g(cols.metro);
  if (cols.county >= 0) m.county = g(cols.county);
  if (cols.stFips >= 0 && cols.muFips >= 0) m.fips = g(cols.stFips).padStart(2, "0") + g(cols.muFips).padStart(3, "0");
  return m;
}

function valuesOf(cells: string[], firstDateCol: number, n: number): Float64Array {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const raw = cells[firstDateCol + i];
    v[i] = raw == null || raw === "" ? NaN : Number(raw);
  }
  return v;
}

function loadSmallTable(url: string): Promise<Table> {
  return cached(`zillow:table:${url}`, 12 * HOUR, async () => {
    let header: string[] = [];
    let info: ReturnType<typeof headerInfo> | null = null;
    const rows: Row[] = [];
    await streamCsvLines(url, (line, i) => {
      if (i === 0) {
        header = splitCsv(line);
        info = headerInfo(header);
        return;
      }
      if (!line) return;
      const cells = splitCsv(line);
      rows.push({ meta: metaOf(cells, info!.cols), values: valuesOf(cells, info!.firstDateCol, header.length - info!.firstDateCol) });
    });
    if (!info) throw new Error(`Zillow file had no header: ${url}`);
    const fd = (info as ReturnType<typeof headerInfo>).firstDateCol;
    return { header, dates: header.slice(fd), firstDateCol: fd, rows, fetchedAt: new Date().toISOString() };
  });
}

export interface RegionQuery {
  zip?: string;
  name?: string;
  state?: string;
  regionId?: string;
}

type Matcher = (m: Meta) => number; // 0 = no match, higher = better

function buildMatcher(geo: Geo, q: RegionQuery): Matcher {
  const st = q.state ? q.state.trim().toUpperCase() : "";
  const zip = q.zip ? String(q.zip).replace(/\D/g, "").slice(0, 5) : "";
  const nm = norm(q.name);
  const nmNoSuffix = nm.replace(/\b(county|parish|borough|msa|metro|city|village|town)\b/g, "").trim();
  const rid = q.regionId ? String(q.regionId) : "";
  return (m: Meta): number => {
    if (rid) return m.regionId === rid ? 100 : 0;
    if (st && m.state && m.state.toUpperCase() !== st && norm(m.state) !== norm(st)) {
      // metro names carry the state in the name ("Chicago, IL"); allow those through
      if (!(geo === "metro" && norm(m.name).endsWith(norm(st)))) return 0;
    }
    if (geo === "zip") {
      if (zip) return m.name === zip ? 100 : 0;
      if (nm) {
        const c = norm(m.city);
        if (c === nm) return 80;
        if (c && c.startsWith(nm)) return 40;
      }
      return 0;
    }
    if (!nm) return 0;
    const n = norm(m.name);
    const nNoSuffix = n.replace(/\b(county|parish|borough)\b/g, "").trim();
    if (geo === "metro") {
      const city = n.split(" ")[0] ?? "";
      if (n === nm) return 100;
      if (n.replace(/ [a-z]{2}( [a-z]{2})*$/, "") === nmNoSuffix) return 95; // "chicago il" -> "chicago"
      if (n.startsWith(nm)) return 85;
      if (city === nmNoSuffix.split(" ")[0] && nmNoSuffix.split(" ").length === 1) return 70;
      if (n.includes(nm)) return 50;
      return 0;
    }
    if (geo === "county") {
      if (n === nm || nNoSuffix === nmNoSuffix) return 100;
      if (nNoSuffix.startsWith(nmNoSuffix)) return 60;
      return 0;
    }
    if (n === nm) return 100;
    if (n.startsWith(nm)) return 60;
    if (n.includes(nm)) return 30;
    return 0;
  };
}

interface Matched {
  meta: Meta;
  score: number;
  series: SeriesPoint[];
}

/** Find matching regions in a dataset file: stream big files, cache small ones. */
async function findRegions(def: ZillowDatasetDef, geo: Geo, q: RegionQuery, max = 25): Promise<{ matches: Matched[]; dates: string[]; fetchedAt: string; streamed: boolean; ms?: number }> {
  const url = zillowUrl(def, geo);
  const size = def.big?.[geo] ?? 0;
  const matcher = buildMatcher(geo, q);
  if (size <= STREAM_THRESHOLD_BYTES) {
    const t = await loadSmallTable(url);
    const matches: Matched[] = [];
    for (const r of t.rows) {
      const s = matcher(r.meta);
      if (s > 0) {
        const series: SeriesPoint[] = [];
        for (let i = 0; i < t.dates.length; i++) if (!Number.isNaN(r.values[i]!)) series.push({ date: t.dates[i]!, value: r.values[i]! });
        matches.push({ meta: r.meta, score: s, series });
      }
    }
    matches.sort((a, b) => b.score - a.score || a.meta.sizeRank - b.meta.sizeRank);
    return { matches: matches.slice(0, max), dates: t.dates, fetchedAt: t.fetchedAt, streamed: false };
  }
  const key = `zillow:q:${url}:${geo}:${JSON.stringify(q)}:${max}`;
  return cached(key, 12 * HOUR, async () => {
    let header: string[] = [];
    let info: ReturnType<typeof headerInfo> | null = null;
    const matches: Matched[] = [];
    const exactZip = geo === "zip" && !!q.zip && !q.name;
    const stats = await streamCsvLines(
      url,
      (line, i) => {
        if (i === 0) {
          header = splitCsv(line);
          info = headerInfo(header);
          return;
        }
        if (!line) return;
        // cheap pre-filter before full CSV split
        if (exactZip) {
          const z = String(q.zip).replace(/\D/g, "").slice(0, 5);
          if (!line.includes(`,${z},`)) return;
        }
        const cells = splitCsv(line);
        const meta = metaOf(cells, info!.cols);
        const s = matcher(meta);
        if (s > 0) {
          matches.push({ meta, score: s, series: wideRowToSeries(header, cells, info!.firstDateCol) });
          if (exactZip && s >= 100) return false; // zips are unique; stop the download
        }
      },
      { deadlineMs: 40000 }
    );
    if (!info) throw new Error(`Zillow file had no header: ${url}`);
    const fd = (info as ReturnType<typeof headerInfo>).firstDateCol;
    matches.sort((a, b) => b.score - a.score || a.meta.sizeRank - b.meta.sizeRank);
    return { matches: matches.slice(0, max), dates: header.slice(fd), fetchedAt: new Date().toISOString(), streamed: true, ms: stats.ms };
  });
}

function dpFor(unit: ZillowDatasetDef["unit"]): number {
  switch (unit) {
    case "usd":
    case "count":
      return 0;
    case "ratio":
      return 3;
    default:
      return 1;
  }
}

function scaleFor(unit: ZillowDatasetDef["unit"]): number {
  return unit === "pct_share" ? 100 : 1;
}

function regionLabel(m: Meta): Record<string, unknown> {
  const out: Record<string, unknown> = { region: m.name, type: m.type, state: m.state, sizeRank: m.sizeRank };
  if (m.city) out.city = m.city;
  if (m.county) out.county = m.county;
  if (m.metro) out.metro = m.metro;
  if (m.fips) out.fips = m.fips;
  return out;
}

function shapeMatch(def: ZillowDatasetDef, m: Matched, recent: number): Record<string, unknown> {
  const scale = scaleFor(def.unit);
  const series = scale === 1 ? m.series : m.series.map((p) => ({ date: p.date, value: p.value * scale }));
  const ppy = def.key === "inventory_weekly" ? 52 : 12;
  const shape: SeriesShape = shapeSeries(series, {
    periodsPerYear: ppy,
    recent,
    dp: dpFor(def.unit),
    horizons: ppy === 52 ? { "1w": 1, "4w": 4, "13w": 13, "52w": 52 } : undefined,
  });
  return { ...regionLabel(m.meta), ...shape };
}

function requireDef(key: string): ZillowDatasetDef {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`Unknown dataset '${key}'. Valid: ${ZILLOW_DATASETS.map((d) => d.key).join(", ")}`);
  return def;
}

function parseGeo(v: unknown, def: ZillowDatasetDef, q: RegionQuery): Geo {
  let g = String(v ?? "").toLowerCase().trim() as Geo;
  if (!g) g = q.zip ? "zip" : def.geos.includes("metro") ? "metro" : def.geos[0]!;
  if (g === ("msa" as Geo)) g = "metro";
  if (!def.geos.includes(g)) throw new Error(`geography '${g}' is not published for '${def.key}'. Available: ${def.geos.join(", ")}`);
  return g;
}

function requireQuery(q: RegionQuery, geo: Geo) {
  if (!q.zip && !q.name && !q.regionId) {
    throw new Error(geo === "zip" ? "Pass zip (5 digits) or name (a city, to list its zips)." : "Pass name (e.g. 'Chicago', 'DuPage County', 'Hinsdale') and optionally state.");
  }
}

export interface ZhviArgs {
  geography?: string;
  zip?: string | number;
  name?: string;
  state?: string;
  regionId?: string;
  tier?: string;
  homeType?: string;
  months?: number;
  includeNational?: boolean;
  limit?: number;
}

export async function zillowZhvi(args: ZhviArgs) {
  const tier = String(args.tier ?? "mid").toLowerCase();
  const type = String(args.homeType ?? "all").toLowerCase();
  let key = "zhvi";
  if (type === "sfr") key = tier === "top" ? "zhvi_sfr_top" : "zhvi_sfr";
  else if (type === "condo") key = "zhvi_condo";
  else if (type === "4br") key = "zhvi_4br";
  else if (type === "5br") key = "zhvi_5br";
  else key = tier === "top" ? "zhvi_top" : tier === "bottom" ? "zhvi_bottom" : "zhvi";
  if ((type === "sfr" && tier === "bottom") || (type !== "all" && type !== "sfr" && tier !== "mid")) {
    throw new Error(`tier '${tier}' is only published for homeType 'all' (top/bottom) and 'sfr' (top); use tier 'mid' for ${type}`);
  }
  const def = requireDef(key);
  const q: RegionQuery = { zip: args.zip != null ? String(args.zip) : undefined, name: args.name, state: args.state, regionId: args.regionId };
  const geo = parseGeo(args.geography, def, q);
  requireQuery(q, geo);
  const months = clampInt(args.months, 24, 0, 120);
  const limit = clampInt(args.limit, 5, 1, 25);

  const [found, national] = await Promise.all([
    findRegions(def, geo, q, limit),
    args.includeNational === false ? null : findRegions(def, "metro", { name: "United States" }, 1).catch(() => null),
  ]);
  if (!found.matches.length) {
    throw new Error(`No ${def.key} ${geo} row matched ${JSON.stringify(q)}. Zillow publishes ZHVI for ~26k zips, ~21k cities, ~3k counties and ~900 metros; check spelling/state or try another geography.`);
  }
  const regions = found.matches.map((m) => shapeMatch(def, m, months));
  const out: Record<string, unknown> = {
    source: "Zillow Research ZHVI (files.zillowstatic.com), keyless",
    dataset: def.key,
    description: def.label,
    units: "USD, whole dollars; change/cagr in percent",
    asOf: found.dates[found.dates.length - 1],
    fetchedAt: found.fetchedAt,
    geography: geo,
    matched: found.matches.length,
    regions,
  };
  if (found.streamed) out.streamed = { fileMB: Math.round((def.big?.[geo] ?? 0) / 1e6), ms: found.ms };
  const us = national?.matches[0];
  if (us) {
    const s = shapeSeries(us.series, { periodsPerYear: 12, recent: 0, dp: 0 });
    out.unitedStates = { latest: s.latest, change: s.change, cagr: s.cagr, peak: s.peak };
  }
  return out;
}

export interface DatasetArgs {
  dataset?: string;
  geography?: string;
  zip?: string | number;
  name?: string;
  state?: string;
  regionId?: string;
  months?: number;
  limit?: number;
  list?: boolean;
}

export async function zillowDataset(args: DatasetArgs) {
  if (args.list || !args.dataset) {
    return {
      source: "Zillow Research public CSVs (files.zillowstatic.com), keyless; verified 2026-10-22",
      datasets: ZILLOW_DATASETS.map((d) => ({ key: d.key, geographies: d.geos.join("|"), unit: d.unit, label: d.label })),
      hint: "Call again with dataset + geography + name/zip. ZHVI tiers and home types are easier through zillow_zhvi.",
    };
  }
  const def = requireDef(String(args.dataset).toLowerCase().trim());
  const q: RegionQuery = { zip: args.zip != null ? String(args.zip) : undefined, name: args.name, state: args.state, regionId: args.regionId };
  const geo = parseGeo(args.geography, def, q);
  requireQuery(q, geo);
  const limit = clampInt(args.limit, 5, 1, 25);
  const months = clampInt(args.months, 24, 0, 120);
  const found = await findRegions(def, geo, q, limit);
  if (!found.matches.length) {
    throw new Error(`No '${def.key}' ${geo} row matched ${JSON.stringify(q)}. Coverage is thinner than ZHVI for rents/inventory/sales files (zips with enough listings only); try geography 'county' or 'metro'.`);
  }
  const base = {
    source: "Zillow Research (files.zillowstatic.com), keyless",
    dataset: def.key,
    description: def.label,
    geography: geo,
    fetchedAt: found.fetchedAt,
    matched: found.matches.length,
  };
  if (def.forecast) {
    // header: ...,BaseDate,<date1>,<date2>,<date3>; row carries growth % for each horizon
    return {
      ...base,
      units: "percent expected change in ZHVI from BaseDate",
      regions: found.matches.map((m) => ({
        ...regionLabel(m.meta),
        forecast: Object.fromEntries(m.series.map((p) => [p.date, round(p.value, 1)])),
      })),
      note: "BaseDate is the ZHVI month the forecast is anchored to (latest release).",
    };
  }
  const unitText =
    def.unit === "usd" ? "USD (whole dollars)" : def.unit === "pct_share" ? "percent" : def.unit === "days" ? "days" : def.unit === "count" ? "count" : def.unit === "ratio" ? "ratio" : "index";
  return {
    ...base,
    units: `${unitText}; change in percent (percentage-point moves are NOT shown for shares — compare levels)`,
    asOf: found.dates[found.dates.length - 1],
    regions: found.matches.map((m) => shapeMatch(def, m, months)),
  };
}
