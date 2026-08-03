/**
 * GET /api/cpi — full-history CPI index level, served for consumption by
 * the Vistamark Glide Path Navigator (vistaglidepath.com) historical
 * cohort-replay engine.
 *
 * Deliberately unauthenticated, same posture as /api/market-brief and
 * /api/selftest: GET only, no arguments, a single PUBLIC macro series
 * from FRED — no client, prospect, or database-backed data.
 *
 * SERIES CHOICE: CPIAUCNS (NOT seasonally adjusted), not CPIAUCSL.
 * Deflating a specific historical month-end return stream requires the
 * as-published NSA index; the SA series is a smoothed model output and
 * is wrong for point-in-time real-return work.
 *
 * DATE CONVENTION: FRED stamps a monthly observation on the FIRST of the
 * month; the Navigator's index history is keyed to month-END labels
 * ("6/30/2026"). Rather than synthesize month-end dates here, this
 * endpoint emits canonical "YYYY-MM" period keys so the join is
 * unambiguous on the consumer side. Newest-first, matching the ordering
 * of _VBM_INDEX_HISTORY.dates.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSeries, getObservations } from "../lib/fred/client";

const SERIES_ID = "CPIAUCNS";

/** Origins allowed to read this from a browser. Public data, but keep it tidy. */
function allowOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const exact = [
    "vistaglidepath.com",
    "www.vistaglidepath.com",
    "vistaintel.com",
    "www.vistaintel.com",
    "localhost",
    "127.0.0.1",
  ];
  if (exact.includes(host)) return origin;
  // Cloudflare Pages preview deployments get a random subdomain.
  if (host.endsWith(".vistaglidepath.pages.dev")) return origin;
  return null;
}

/** FRED encodes a missing observation as "."; drop those rather than coerce to 0. */
function parseLevel(v: string): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (!t || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "1926-01-01" -> "1926-01" */
function toPeriod(d: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(d || "");
  return m ? `${m[1]}-${m[2]}` : null;
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

  try {
    // Series metadata is cheap and carries units + last_updated, which the
    // consumer needs for its methodology appendix.
    const [meta, obs] = await Promise.all([
      getSeries(SERIES_ID),
      getObservations(SERIES_ID, {
        observationStart: "1913-01-01",
        sortOrder: "desc", // newest -> oldest, matching _VBM_INDEX_HISTORY
        limit: 100000, // full history is ~1,360 monthly prints; never truncate
      }),
    ]);

    const months: string[] = [];
    const index: number[] = [];
    for (const o of obs.observations || []) {
      const period = toPeriod(o.date);
      const level = parseLevel(o.value);
      if (period == null || level == null) continue;
      months.push(period);
      index.push(level);
    }

    if (!months.length) {
      res.status(502).json({ error: "FRED returned no usable CPIAUCNS observations" });
      return;
    }

    // Monthly prints, so a 6h edge cache is generous and keeps Navigator
    // traffic off the FRED key entirely.
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({
      seriesId: SERIES_ID,
      title: meta?.title ?? "Consumer Price Index for All Urban Consumers: All Items in U.S. City Average",
      units: meta?.units ?? "Index 1982-1984=100",
      seasonalAdjustment: meta?.seasonal_adjustment ?? "Not Seasonally Adjusted",
      frequency: meta?.frequency ?? "Monthly",
      observationStart: months[months.length - 1],
      asof: months[0],
      lastUpdated: meta?.last_updated ?? null,
      count: months.length,
      order: "newest-first",
      periodKey: "YYYY-MM",
      months,
      index,
      source: `FRED (Federal Reserve Bank of St. Louis), series ${SERIES_ID}, live`,
      notes:
        "Index levels as published (not seasonally adjusted). Compute inflation between any two periods as index[a]/index[b]-1. Observations are stamped by FRED on the first of the month and are emitted here as YYYY-MM period keys; align to month-end return series by period, not by date arithmetic.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
