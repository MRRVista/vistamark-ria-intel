/**
 * GET /api/farmland — U.S. farmland values and cash rents from USDA NASS
 * Quick Stats, served for VistaBuilder's farmland asset class (CMA anchor,
 * long-history total-return synthesis) and VistaBalancer.
 *
 * Same posture as /api/cpi: GET only, unauthenticated, PUBLIC macro data
 * — no client, prospect, or database-backed data. The NASS key never
 * leaves this server.
 *
 * SERIES (all annual, survey-based, $/acre, "ALL PRODUCTION PRACTICES"):
 *   farmRealEstate  AG LAND, INCL BUILDINGS - ASSET VALUE   (back to 1850 nationally)
 *   cropland        AG LAND, CROPLAND - ASSET VALUE         (1997-)
 *   pastureland     AG LAND, PASTURELAND - ASSET VALUE      (1997-)
 *   croplandRent    RENT, CASH, CROPLAND - EXPENSE          (1997-)
 *   pastureRent     RENT, CASH, PASTURELAND - EXPENSE       (1997-)
 *
 * DERIVED (computed here so every consumer uses the same arithmetic):
 *   croplandRentYield[y]  = croplandRent[y] / cropland[y]
 *   croplandTotalReturn[y] = cropland[y]/cropland[y-1] - 1 + croplandRentYield[y-1]
 *     — a gross, pre-expense, pre-tax synthetic total return: appreciation
 *     plus the prior year's rent yield (rent is earned on the opening value).
 *     It is NOT the NCREIF Farmland Property Index; it is the public-data
 *     bridge for years NCREIF does not cover (pre-1991) and the
 *     transaction-free sanity check on appraisal-based returns.
 *
 * DATE CONVENTION: NASS land values are "as of January 1" of the survey
 * year for 1997+ (the June Area Survey reference) — published each August
 * in the Land Values Summary. Emitted as "YYYY" period keys, newest-first,
 * matching /api/cpi's ordering.
 *
 * QUERY:
 *   ?level=national (default) | state&state=IL | region&region=CORN%20BELT
 *   ?probe=1  — distinct short_desc values NASS exposes for AG LAND / RENT
 *               (diagnostic; cheap; use when a series comes back empty)
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getQuickStats, getParamValues, parseValue, type NassRecord } from "../lib/nass/client";

function allowOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const exact = [
    "vistaintel.app",
    "www.vistaintel.app",
    "vistabuilder.app",
    "www.vistabuilder.app",
    "vistabuilder.net",
    "www.vistabuilder.net",
    "vistabalancer.app",
    "www.vistabalancer.app",
    "vistaglidepath.com",
    "www.vistaglidepath.com",
    "localhost",
    "127.0.0.1",
  ];
  return exact.includes(host) ? origin : null;
}

/** short_desc -> output key. Exact strings confirmed against get_param_values on 2026-11-09. */
const SERIES: Record<string, string> = {
  "AG LAND, INCL BUILDINGS - ASSET VALUE, MEASURED IN $ / ACRE": "farmRealEstate",
  "AG LAND, CROPLAND - ASSET VALUE, MEASURED IN $ / ACRE": "cropland",
  "AG LAND, PASTURELAND - ASSET VALUE, MEASURED IN $ / ACRE": "pastureland",
  "RENT, CASH, CROPLAND - EXPENSE, MEASURED IN $ / ACRE": "croplandRent",
  "RENT, CASH, PASTURELAND - EXPENSE, MEASURED IN $ / ACRE": "pastureRent",
};

const COMMON = {
  source_desc: "SURVEY",
  sector_desc: "ECONOMICS",
  domain_desc: "TOTAL",
  freq_desc: "ANNUAL",
  reference_period_desc: "YEAR",
  unit_desc: "$ / ACRE",
};

type Level = "national" | "state" | "region";

function aggLevel(level: Level): string {
  return level === "state" ? "STATE" : level === "region" ? "REGION : MULTI-STATE" : "NATIONAL";
}

/** Fold raw records into { key: { year: value } }, keeping only the five target series. */
function fold(rows: NassRecord[]): Record<string, Map<number, number>> {
  const out: Record<string, Map<number, number>> = {};
  for (const r of rows) {
    const key = SERIES[r.short_desc];
    if (!key) continue;
    const y = Number(r.year);
    const v = parseValue(r.Value);
    if (!Number.isFinite(y) || v == null) continue;
    (out[key] ??= new Map()).set(y, v);
  }
  return out;
}

function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cors = allowOrigin(req.headers.origin as string | undefined);
  if (cors) {
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const q = (k: string): string | undefined => {
    const v = req.query[k];
    return Array.isArray(v) ? v[0] : v;
  };

  try {
    if (q("probe") === "1") {
      const [land, rent] = await Promise.all([
        getParamValues("short_desc", { commodity_desc: "AG LAND", statisticcat_desc: "ASSET VALUE" }),
        getParamValues("short_desc", { commodity_desc: "RENT", statisticcat_desc: "EXPENSE" }),
      ]);
      res.setHeader("Cache-Control", "public, s-maxage=86400");
      res.status(200).json({ probe: true, agLandAssetValue: land, rentExpense: rent, mapped: SERIES });
      return;
    }

    const levelRaw = (q("level") ?? "national").toLowerCase();
    const level: Level = levelRaw === "state" || levelRaw === "region" ? levelRaw : "national";
    const state = q("state")?.toUpperCase();
    const region = q("region")?.toUpperCase();
    if (level === "state" && !/^[A-Z]{2}$/.test(state ?? "")) {
      res.status(400).json({ error: "level=state requires state=XX (two-letter postal code)" });
      return;
    }
    if (level === "region" && !region) {
      res.status(400).json({ error: "level=region requires region=NAME (e.g. CORN BELT, LAKE STATES, NORTHERN PLAINS)" });
      return;
    }

    const geo: Record<string, string> = { agg_level_desc: aggLevel(level) };
    if (level === "state") geo.state_alpha = state!;
    if (level === "region") geo.region_desc = region!;

    // Two calls: land values and cash rents are different commodity_desc
    // families. Each returns a few hundred rows at most.
    const [landRows, rentRows] = await Promise.all([
      getQuickStats({ ...COMMON, ...geo, commodity_desc: "AG LAND", statisticcat_desc: "ASSET VALUE" }),
      getQuickStats({ ...COMMON, ...geo, commodity_desc: "RENT", statisticcat_desc: "EXPENSE" }),
    ]);
    const folded = fold([...landRows, ...rentRows]);

    if (!folded.farmRealEstate && !folded.cropland) {
      res.status(502).json({
        error: "NASS returned no usable land-value observations for this geography",
        level,
        state: state ?? null,
        region: region ?? null,
        shortDescsSeen: Array.from(new Set([...landRows, ...rentRows].map((r) => r.short_desc))).sort(),
      });
      return;
    }

    // Union of years across all series, newest-first.
    const yearSet = new Set<number>();
    for (const m of Object.values(folded)) for (const y of m.keys()) yearSet.add(y);
    const years = Array.from(yearSet).sort((a, b) => b - a);

    const series: Record<string, (number | null)[]> = {};
    for (const key of Object.values(SERIES)) {
      const m = folded[key];
      series[key] = years.map((y) => (m?.get(y) ?? null));
    }

    // Derived: rent yield and synthetic gross total return (cropland and pasture).
    const derive = (valKey: string, rentKey: string, yieldKey: string, trKey: string) => {
      const val = folded[valKey];
      const rent = folded[rentKey];
      series[yieldKey] = years.map((y) => {
        const v = val?.get(y);
        const r = rent?.get(y);
        return v && r != null ? r6(r / v) : null;
      });
      series[trKey] = years.map((y) => {
        const v1 = val?.get(y);
        const v0 = val?.get(y - 1);
        const r0 = rent?.get(y - 1);
        if (!v1 || !v0 || r0 == null) return null;
        return r6(v1 / v0 - 1 + r0 / v0);
      });
    };
    derive("cropland", "croplandRent", "croplandRentYield", "croplandTotalReturn");
    derive("pastureland", "pastureRent", "pastureRentYield", "pastureTotalReturn");
    // Appreciation-only series for the long farm-real-estate history (no rent before 1997).
    {
      const m = folded.farmRealEstate;
      series.farmRealEstateChange = years.map((y) => {
        const v1 = m?.get(y);
        const v0 = m?.get(y - 1);
        return v1 && v0 ? r6(v1 / v0 - 1) : null;
      });
    }

    const firstYear = (key: string) => {
      const m = folded[key];
      return m ? Math.min(...m.keys()) : null;
    };

    // Annual series updated once a year (August). 24h edge cache.
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({
      source: "USDA NASS Quick Stats (survey), live",
      level,
      geography: level === "state" ? state : level === "region" ? region : "US",
      units: "$ / acre (nominal); yields and returns as decimals",
      frequency: "Annual",
      periodKey: "YYYY",
      order: "newest-first",
      asof: years[0] ?? null,
      count: years.length,
      observationStart: {
        farmRealEstate: firstYear("farmRealEstate"),
        cropland: firstYear("cropland"),
        pastureland: firstYear("pastureland"),
        croplandRent: firstYear("croplandRent"),
        pastureRent: firstYear("pastureRent"),
      },
      years,
      series,
      shortDescs: SERIES,
      notes:
        "Land values are as of January 1 of the survey year (June Area Survey reference), published each August in the NASS Land Values Summary. croplandTotalReturn[y] = cropland[y]/cropland[y-1] - 1 + croplandRent[y-1]/cropland[y-1]: a GROSS synthetic total return (no property tax, management, or transaction cost) for bridging years NCREIF does not cover and for cross-checking appraisal-based indices. It is not the NCREIF Farmland Property Index. Nulls are missing or suppressed NASS values, never zero-filled. Use /api/cpi for real-return deflation.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(/NASS_API_KEY not configured/.test(msg) ? 503 : 500).json({ error: msg });
  }
}
