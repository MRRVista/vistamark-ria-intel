/**
 * MCP tool handlers for OFR (Office of Financial Research) data.
 *
 * Tools:
 *   ofr_financial_stress_index  — daily OFR FSI: latest reading, recent history,
 *                                 and the category/region subindex breakdown.
 *   ofr_series_search           — search the OFR Data API catalog for a mnemonic.
 *   ofr_series                  — fetch a time series by mnemonic (repo, MMF, CP, ...).
 */
import { fetchFsi, ofrTimeseries, ofrSearch } from "./client";

export interface OfrFsiArgs {
  lookback?: number;
}

export async function ofrFinancialStressIndex(args: OfrFsiArgs) {
  const { headers, rows } = await fetchFsi();
  if (rows.length === 0) {
    return {
      dataSource: "OFR Financial Stress Index",
      note: "No data returned from the OFR FSI feed.",
      latest: null,
      series: [],
    };
  }
  const lookback = Math.min(args.lookback ?? 30, 1000);
  const recent = rows.slice(-lookback);
  const latest = rows[rows.length - 1]!;
  const headlineKey = headers.find((h) => /ofr\s*fsi|^fsi$/i.test(h)) ?? headers[1] ?? null;
  return {
    dataSource: "OFR Financial Stress Index (daily)",
    columns: headers,
    headlineColumn: headlineKey,
    latest: {
      date: latest.date,
      headline: headlineKey ? latest.values[headlineKey] ?? null : null,
      all: latest.values,
    },
    series: recent.map((r) => ({
      date: r.date,
      headline: headlineKey ? r.values[headlineKey] ?? null : null,
    })),
    note: "OFR FSI is zero-centered: positive = above-average financial stress, negative = below-average, 0 = the historical average. Category (credit, equity valuation, funding, safe assets, volatility) and region contributions are in `columns` and the latest row's `all` map. Source: financialresearch.gov.",
  };
}

export interface OfrSeriesArgs {
  mnemonic: string;
  lookback?: number;
}

export async function ofrSeries(args: OfrSeriesArgs) {
  if (!args.mnemonic) {
    throw new Error("ofr_series requires a mnemonic (find one with ofr_series_search).");
  }
  const { observations, raw } = await ofrTimeseries(args.mnemonic);
  const lookback = args.lookback != null ? Math.min(args.lookback, 5000) : null;
  const obs = lookback ? observations.slice(-lookback) : observations;
  return {
    dataSource: "OFR Data API (data.financialresearch.gov)",
    mnemonic: args.mnemonic,
    observationCount: obs.length,
    latest: obs.length ? obs[obs.length - 1] : null,
    observations: obs,
    // Surface the raw payload only if we couldn't normalize it, so the caller
    // still gets the data even if the response shape differs from expectations.
    rawWhenUnparsed: obs.length === 0 ? raw : undefined,
  };
}

export interface OfrSeriesSearchArgs {
  query: string;
}

export async function ofrSeriesSearch(args: OfrSeriesSearchArgs) {
  if (!args.query) throw new Error("ofr_series_search requires a query.");
  const results = await ofrSearch(args.query);
  return {
    dataSource: "OFR Data API (data.financialresearch.gov)",
    query: args.query,
    results,
    note: "Use a returned series mnemonic with ofr_series. The OFR Short-Term Funding Monitor (repo rates, money-market funds, commercial paper) is the primary catalog. For the daily Financial Stress Index, use ofr_financial_stress_index instead.",
  };
}
