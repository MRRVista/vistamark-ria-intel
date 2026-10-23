/**
 * Realtor.com Research — Monthly Housing Inventory Core Metrics (keyless; verified
 * live 2026-10-22, Last-Modified 2026-09-30, latest month 202609).
 *
 * The documented host (econdata.s3-website-us-west-2.amazonaws.com) is HTTP-only
 * and the agent proxy cannot reach it (000 / 404). The same objects are served
 * over HTTPS from the bucket's REST endpoint, which is what we use:
 *   https://econdata.s3.us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_<Geo>.csv          (latest month only)
 *   https://econdata.s3.us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_<Geo>_History.csv  (Jul-2016 onward)
 * Geo: Zip (7 MB / 837 MB), County (0.9 MB / 103 MB), Metro (0.3 MB / 33 MB), State (17 KB / 1.9 MB).
 * History files are sorted by month DESCENDING (newest first, then by place), so a
 * trailing-N-month query streams from the top and cancels at the first older
 * row: 12 months of zips = ~180 MB / ~6.5 s; county ~22 MB / 1.2 s; metro 7 MB.
 *
 * Columns (all geos): month_date_yyyymm, <id>, <name>, then for each metric
 * value, _mm (month-over-month change as a DECIMAL fraction), _yy (year-over-year):
 *   median_listing_price, active_listing_count, median_days_on_market, new_listing_count,
 *   price_increased_count/_share, price_reduced_count/_share, pending_listing_count,
 *   median_listing_price_per_square_foot, median_square_feet, average_listing_price,
 *   total_listing_count, pending_ratio; plus quality_flag (1 = thin data, use caution).
 * Id/name columns: Zip -> postal_code,zip_name ("hinsdale, il"); County -> county_fips,
 * county_name ("dupage, il"); Metro -> cbsa_code,cbsa_title,HouseholdRank; State -> state,state_id.
 */
import { cached, clampInt, HOUR, norm, pctOrNull, round, splitCsv, streamCsvLines } from "./common";

const BASE = "https://econdata.s3.us-west-2.amazonaws.com/Reports/Core";

type Geo = "zip" | "county" | "metro" | "state";
const FILE: Record<Geo, string> = { zip: "Zip", county: "County", metro: "Metro", state: "State" };

const METRICS = [
  "median_listing_price",
  "active_listing_count",
  "new_listing_count",
  "pending_listing_count",
  "total_listing_count",
  "median_days_on_market",
  "price_reduced_count",
  "price_reduced_share",
  "price_increased_share",
  "pending_ratio",
  "median_listing_price_per_square_foot",
  "median_square_feet",
  "average_listing_price",
] as const;
type Metric = (typeof METRICS)[number];
const USD: Set<string> = new Set(["median_listing_price", "average_listing_price", "median_listing_price_per_square_foot"]);
const SHARE: Set<string> = new Set(["price_reduced_share", "price_increased_share", "pending_ratio"]);

interface RdcRow {
  month: string; // YYYY-MM
  id: string;
  name: string;
  values: Record<string, number | null>;
  quality: number | null;
}

interface Cols {
  month: number;
  id: number;
  name: number;
  metric: Record<string, number>;
  quality: number;
}

function colsOf(header: string[]): Cols {
  const idx = (n: string) => header.indexOf(n);
  const metric: Record<string, number> = {};
  for (const h of header) metric[h] = idx(h);
  return { month: idx("month_date_yyyymm"), id: 1, name: 2, metric, quality: idx("quality_flag") };
}

function rowOf(cells: string[], c: Cols): RdcRow {
  const values: Record<string, number | null> = {};
  for (const m of METRICS) {
    const i = c.metric[m];
    const v = i != null && i >= 0 ? Number(cells[i]) : NaN;
    values[m] = Number.isFinite(v) ? v : null;
    for (const sfx of ["_mm", "_yy"]) {
      const j = c.metric[m + sfx];
      const w = j != null && j >= 0 ? Number(cells[j]) : NaN;
      values[m + sfx] = Number.isFinite(w) ? w : null;
    }
  }
  const q = c.quality >= 0 ? Number(cells[c.quality]) : NaN;
  const ym = cells[c.month] ?? "";
  return { month: `${ym.slice(0, 4)}-${ym.slice(4, 6)}`, id: cells[c.id] ?? "", name: cells[c.name] ?? "", values, quality: Number.isFinite(q) ? q : null };
}

export interface RealtorArgs {
  geography?: string;
  zip?: string | number;
  fips?: string | number;
  cbsa?: string | number;
  name?: string;
  state?: string;
  months?: number;
  metrics?: string[];
  limit?: number;
}

interface Target {
  test: (id: string, name: string, rawLine: string) => boolean;
  describe: string;
  single: boolean;
}

function buildTarget(geo: Geo, a: RealtorArgs): Target {
  const st = a.state ? a.state.trim().toLowerCase() : "";
  if (geo === "zip") {
    const z = a.zip != null ? String(a.zip).replace(/\D/g, "").slice(0, 5) : "";
    if (z) return { test: (id) => id === z, describe: `zip ${z}`, single: true };
    const nm = norm(a.name);
    if (!nm) throw new Error("For geography zip pass zip (5 digits) or name (city, e.g. 'Hinsdale' + state 'IL').");
    return { test: (_id, name) => norm(name.split(",")[0]) === nm && (!st || name.endsWith(`, ${st}`)), describe: `zips named ${a.name}${st ? ", " + st : ""}`, single: false };
  }
  if (geo === "county") {
    const f = a.fips != null ? String(a.fips).replace(/\D/g, "").padStart(5, "0") : "";
    if (f) return { test: (id) => id.padStart(5, "0") === f, describe: `county fips ${f}`, single: true };
    const nm = norm(a.name).replace(/\bcounty\b/g, "").trim();
    if (!nm) throw new Error("For geography county pass fips (17043) or name ('DuPage') + state ('IL').");
    return { test: (_id, name) => norm(name.split(",")[0]) === nm && (!st || name.endsWith(`, ${st}`)), describe: `county ${a.name}${st ? ", " + st : ""}`, single: !!st };
  }
  if (geo === "metro") {
    const c = a.cbsa != null ? String(a.cbsa).replace(/\D/g, "") : "";
    if (c) return { test: (id) => id === c, describe: `cbsa ${c}`, single: true };
    const nm = norm(a.name);
    if (!nm) throw new Error("For geography metro pass cbsa (16980) or name ('Chicago').");
    return { test: (_id, name) => norm(name).startsWith(nm) || norm(name.split(",")[0]!.split("-")[0]) === nm, describe: `metro ${a.name}`, single: false };
  }
  const s = (a.state ?? a.name ?? "").trim();
  if (!s) throw new Error("For geography state pass state ('IL' or 'Illinois').");
  // State file columns are state (name), state_id (code): id=name, name=code
  return { test: (id, name) => name.toLowerCase() === s.toLowerCase() || norm(id) === norm(s), describe: `state ${s}`, single: true };
}

async function loadTrailing(geo: Geo, target: Target, months: number, maxPlaces: number) {
  const url = `${BASE}/RDC_Inventory_Core_Metrics_${FILE[geo]}${months > 1 ? "_History" : ""}.csv`;
  const key = `rdc:${geo}:${target.describe}:${months}:${maxPlaces}`;
  return cached(key, 12 * HOUR, async () => {
    let cols: Cols | null = null;
    let cutoff = "";
    const byPlace = new Map<string, RdcRow[]>();
    let latestMonth = "";
    let seenMonths = 0;
    let lastMonth = "";
    const stats = await streamCsvLines(
      url,
      (line, i) => {
        if (i === 0) {
          cols = colsOf(splitCsv(line));
          return;
        }
        if (!line) return;
        const ym = line.slice(0, 6);
        if (!/^\d{6}$/.test(ym)) return;
        if (!latestMonth) latestMonth = ym;
        if (ym !== lastMonth) {
          lastMonth = ym;
          seenMonths++;
          if (seenMonths > months) return false; // history is newest-first; nothing older is wanted
          if (!cutoff) cutoff = ym;
        }
        // cheap pre-filter: the id is the second field
        const c1 = line.indexOf(",");
        const c2 = line.indexOf(",", c1 + 1);
        const id = line.slice(c1 + 1, c2);
        if (target.single && geo !== "county" && geo !== "state") {
          // id tests are exact; skip the split when it cannot match
          if (!target.test(id, "", line)) return;
        }
        const cells = splitCsv(line);
        const row = rowOf(cells, cols!);
        if (!target.test(row.id, row.name, line)) return;
        const arr = byPlace.get(row.id) ?? [];
        arr.push(row);
        byPlace.set(row.id, arr);
        if (target.single && months === 1) return false;
      },
      { deadlineMs: 45000 }
    );
    return { byPlace, latestMonth, stats, fetchedAt: new Date().toISOString(), url };
  });
}

function fmt(metric: string, v: number | null): number | null {
  if (v == null) return null;
  if (USD.has(metric)) return Math.round(v);
  if (SHARE.has(metric)) return round(v * 100, 1);
  return round(v, metric === "median_days_on_market" ? 0 : 0);
}

export async function realtorInventory(args: RealtorArgs) {
  let geo = String(args.geography ?? "").toLowerCase().trim() as Geo;
  if (!geo) geo = args.zip != null ? "zip" : args.fips != null ? "county" : args.cbsa != null ? "metro" : args.name ? "county" : "state";
  if (geo === ("msa" as Geo)) geo = "metro";
  if (!FILE[geo]) throw new Error(`geography must be zip | county | metro | state (got '${args.geography}')`);
  const months = clampInt(args.months, 13, 1, geo === "zip" ? 25 : 60);
  const limit = clampInt(args.limit, 5, 1, 25);
  const target = buildTarget(geo, args);
  const wanted = (args.metrics?.length ? args.metrics.map((m) => m.toLowerCase().trim()) : [...METRICS]).filter((m) => (METRICS as readonly string[]).includes(m));
  if (!wanted.length) throw new Error(`metrics must be among: ${METRICS.join(", ")}`);

  const { byPlace, latestMonth, stats, fetchedAt, url } = await loadTrailing(geo, target, months, limit);
  if (!byPlace.size) {
    throw new Error(`No Realtor.com ${geo} rows matched ${target.describe} in the last ${months} month(s) (file ${url.split("/").pop()}, latest ${latestMonth}). Zip coverage requires enough active listings; try county (fips 17043 = DuPage) or metro (cbsa 16980 = Chicago).`);
  }
  const places = [...byPlace.values()].slice(0, limit).map((rows) => {
    rows.sort((a, b) => (a.month < b.month ? -1 : 1));
    const last = rows[rows.length - 1]!;
    const latest: Record<string, unknown> = {};
    for (const m of wanted) {
      latest[m] = fmt(m, last.values[m] ?? null);
      const mm = last.values[m + "_mm"];
      const yy = last.values[m + "_yy"];
      if (mm != null) latest[m + "_mom_pct"] = pctOrNull(mm);
      if (yy != null) latest[m + "_yoy_pct"] = pctOrNull(yy);
    }
    const trendMetrics = wanted.slice(0, 6);
    const trend = rows.map((r) => [r.month, ...trendMetrics.map((m) => fmt(m, r.values[m] ?? null))]);
    // 12-month averages for the headline metrics
    const avg = (m: string) => {
      const vals = rows.map((r) => r.values[m]).filter((v): v is number => v != null);
      return vals.length ? fmt(m, vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    return {
      id: last.id,
      name: last.name,
      latestMonth: last.month,
      qualityFlag: last.quality,
      latest,
      trailingAvg: rows.length > 1 ? Object.fromEntries(trendMetrics.map((m) => [m, avg(m)])) : undefined,
      trendColumns: ["month", ...trendMetrics],
      trend: rows.length > 1 ? trend : undefined,
    };
  });
  return {
    source: "Realtor.com Research — Monthly Housing Inventory Core Metrics (econdata.s3.us-west-2.amazonaws.com/Reports/Core), keyless",
    geography: geo,
    asOf: `${latestMonth.slice(0, 4)}-${latestMonth.slice(4, 6)}`,
    fetchedAt,
    units: "USD whole dollars; shares and pending_ratio in percent; counts and days as published; *_mom_pct / *_yoy_pct are Realtor.com's own month-over-month / year-over-year changes in percent",
    matched: byPlace.size,
    streamed: { mb: round(stats.bytes / 1e6, 1), ms: stats.ms, rows: stats.lines },
    places,
    note: "quality_flag 1 = thin listing sample. Realtor.com's '% of listings with price cuts' is price_reduced_share; pending_ratio = pending / active listings.",
  };
}
