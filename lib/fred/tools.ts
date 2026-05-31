/**
 * MCP tool handlers for FRED (Federal Reserve Economic Data).
 */

import { searchSeries, getSeries, getObservations } from "./client";

export interface FredSeriesSearchArgs {
  query: string;
  limit?: number;
}

export async function fredSeriesSearch(args: FredSeriesSearchArgs) {
  if (!args.query || typeof args.query !== "string") {
    throw new Error("fred_series_search requires `query`");
  }
  const resp = await searchSeries(args.query, args.limit ?? 25);
  return {
    totalMatches: resp.count,
    returned: resp.seriess.length,
    series: resp.seriess.map((s) => ({
      id: s.id,
      title: s.title,
      frequency: s.frequency,
      units: s.units,
      seasonalAdjustment: s.seasonal_adjustment_short,
      observationStart: s.observation_start,
      observationEnd: s.observation_end,
      lastUpdated: s.last_updated,
      popularity: s.popularity,
    })),
    dataSource: "FRED — Federal Reserve Bank of St. Louis",
  };
}

export interface FredGetSeriesArgs {
  seriesId: string;
  observationStart?: string;
  observationEnd?: string;
  frequency?: "d" | "w" | "bw" | "m" | "q" | "sa" | "a";
  units?: "lin" | "chg" | "ch1" | "pch" | "pc1" | "pca" | "cch" | "cca" | "log";
  limit?: number;
}

export async function fredGetSeries(args: FredGetSeriesArgs) {
  if (!args.seriesId) throw new Error("fred_get_series requires `seriesId`");
  const seriesId = args.seriesId.toUpperCase();
  const [meta, obs] = await Promise.all([
    getSeries(seriesId),
    getObservations(seriesId, {
      observationStart: args.observationStart,
      observationEnd: args.observationEnd,
      frequency: args.frequency,
      units: args.units,
      limit: args.limit ?? 100,
      sortOrder: "desc",
    }),
  ]);
  if (!meta) throw new Error(`Series ${seriesId} not found on FRED`);
  const observations = obs.observations
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
  const latest = observations[0];
  const oldest = observations[observations.length - 1];
  return {
    seriesId,
    title: meta.title,
    frequency: meta.frequency,
    units: args.units && args.units !== "lin" ? `${meta.units} (${args.units} transform)` : meta.units,
    seasonalAdjustment: meta.seasonal_adjustment,
    lastUpdated: meta.last_updated,
    rangeAvailable: { start: meta.observation_start, end: meta.observation_end },
    latestObservation: latest ?? null,
    oldestReturned: oldest ?? null,
    totalReturned: observations.length,
    observations,
    notes: meta.notes ?? null,
    dataSource: "FRED — Federal Reserve Bank of St. Louis",
  };
}

const YIELD_CURVE_MATURITIES = [
  { label: "1M", series: "DGS1MO" },
  { label: "3M", series: "DGS3MO" },
  { label: "6M", series: "DGS6MO" },
  { label: "1Y", series: "DGS1" },
  { label: "2Y", series: "DGS2" },
  { label: "3Y", series: "DGS3" },
  { label: "5Y", series: "DGS5" },
  { label: "7Y", series: "DGS7" },
  { label: "10Y", series: "DGS10" },
  { label: "20Y", series: "DGS20" },
  { label: "30Y", series: "DGS30" },
];

export interface FredYieldCurveArgs {
  asOfDate?: string;
}

export async function fredYieldCurve(args: FredYieldCurveArgs) {
  const end = args.asOfDate;
  // Per-maturity errors are collected rather than silently swallowed.
  // If ALL 11 maturities fail we throw a clear top-level error so the
  // caller doesn't get a misleading null scaffold that looks like real
  // (empty) data -- previously the silent catch was masking missing
  // FRED_API_KEY, network errors, etc.
  const errors: string[] = [];
  const results = await Promise.all(
    YIELD_CURVE_MATURITIES.map(async (m) => {
      try {
        const obs = await getObservations(m.series, {
          observationEnd: end,
          limit: 1,
          sortOrder: "desc",
        });
        const o = obs.observations?.[0];
        const value = o && o.value !== "." ? parseFloat(o.value) : null;
        return { ...m, date: o?.date ?? null, yield: value };
      } catch (err: any) {
        const msg = `${m.label} (${m.series}): ${err?.message || String(err)}`;
        errors.push(msg);
        console.error(`[fred_yield_curve] ${msg}`);
        return { ...m, date: null, yield: null };
      }
    })
  );
  const get = (label: string) => results.find((r) => r.label === label)?.yield ?? null;
  const y10 = get("10Y");
  const y2 = get("2Y");
  const y3m = get("3M");
  const spread2y10y = y10 != null && y2 != null ? +(y10 - y2).toFixed(3) : null;
  const spread3m10y = y10 != null && y3m != null ? +(y10 - y3m).toFixed(3) : null;

  const validCount = results.filter((r) => r.yield != null).length;
  if (validCount === 0) {
    // All maturities failed. Surface the real reason instead of a
    // null-filled scaffold the model might misread as "curve is empty".
    const sample = errors.slice(0, 3).join(" | ");
    throw new Error(
      `fred_yield_curve: all ${results.length} Treasury constant-maturity series returned no data. ` +
        `Check FRED_API_KEY env var on vistamark-ria-intel deployment (free key at ` +
        `https://fred.stlouisfed.org/docs/api/api_key.html). First few errors: ${sample}`
    );
  }

  return {
    asOfDate: end ?? results.find((r) => r.date)?.date ?? null,
    curve: results.map((r) => ({ maturity: r.label, yield: r.yield, date: r.date })),
    spreads: { "10Y-2Y": spread2y10y, "10Y-3M": spread3m10y },
    inverted2y10y: spread2y10y != null ? spread2y10y < 0 : null,
    inverted3m10y: spread3m10y != null ? spread3m10y < 0 : null,
    validMaturities: validCount,
    totalMaturities: results.length,
    dataSource: "FRED Treasury constant-maturity series (DGS*)",
    ...(errors.length > 0 ? { partialErrors: errors } : {}),
  };
}
