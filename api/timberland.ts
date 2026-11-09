/**
 * GET /api/timberland — the timberland asset class for VistaBuilder /
 * VistaBalancer: a live public price proxy from FRED, plus the NCREIF
 * Timberland Property Index when Vistamark has uploaded it (see
 * /api/private-index).
 *
 * Same posture as /api/cpi for the FRED half: GET only, unauthenticated,
 * PUBLIC series, FRED key never leaves this server. The NCREIF half is
 * read from private_index_obs and is Vistamark-licensed data served only
 * to Vistamark origins (CORS list below).
 *
 * WHY TWO LAYERS: there is no public, API-served timberland INDEX. The
 * institutional benchmark is NCREIF's NTI (quarterly, appraisal-based,
 * 1987-), subscription-only, no API — so it is an upload. What IS public
 * and live is the price of what timberland produces, from the BLS
 * Producer Price Index via FRED:
 *
 *   WPU085  PPI: Logs, Bolts, Timber, Pulpwood and Wood Chips  (monthly, 1981-12-)
 *           — stumpage-adjacent: the closest public series to timber
 *             prices at the forest gate. Primary proxy.
 *   WPU081  PPI: Lumber                                        (monthly, 1926-01-)
 *           — a processed product, one step downstream, but it carries
 *             a century of history for long-run CMA work. Secondary.
 *
 * Both are index levels, 1982=100, not seasonally adjusted, as-published.
 * They are PRICE proxies — no income component — and lumber in particular
 * is far more volatile than timberland total returns. Use them for
 * direction, regime and inflation-beta work, and for bridging history
 * before 1987; use the NCREIF block (de-smoothed) for the return series
 * that enters the optimizer.
 *
 * DATE CONVENTION: as /api/cpi — FRED stamps monthly prints on the 1st;
 * emitted here as "YYYY-MM" period keys, newest-first.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";
import { getSeries, getObservations } from "../lib/fred/client";

const PRIMARY = "WPU085";
const SECONDARY = "WPU081";
const NCREIF_ID = "ncreif-timberland";

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

function parseLevel(v: string): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (!t || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toPeriod(d: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(d || "");
  return m ? `${m[1]}-${m[2]}` : null;
}

async function fredBlock(seriesId: string) {
  const [meta, obs] = await Promise.all([
    getSeries(seriesId),
    getObservations(seriesId, { observationStart: "1900-01-01", sortOrder: "desc", limit: 100000 }),
  ]);
  const months: string[] = [];
  const index: number[] = [];
  for (const o of obs.observations || []) {
    const p = toPeriod(o.date);
    const v = parseLevel(o.value);
    if (p == null || v == null) continue;
    months.push(p);
    index.push(v);
  }
  if (!months.length) throw new Error(`FRED returned no usable ${seriesId} observations`);
  return {
    seriesId,
    title: meta?.title ?? seriesId,
    units: meta?.units ?? "Index 1982=100",
    seasonalAdjustment: meta?.seasonal_adjustment ?? "Not Seasonally Adjusted",
    frequency: meta?.frequency ?? "Monthly",
    observationStart: months[months.length - 1],
    asof: months[0],
    lastUpdated: meta?.last_updated ?? null,
    count: months.length,
    months,
    index,
  };
}

async function ncreifBlock() {
  const url = process.env.DATABASE_URL;
  if (!url) return { loaded: false, reason: "DATABASE_URL not configured" };
  try {
    const sql = neon(url);
    const rows = (await sql`
      SELECT period, total_return, income_return, appreciation_return
      FROM private_index_obs WHERE index_id = ${NCREIF_ID} ORDER BY period DESC`) as any[];
    if (!rows.length) {
      return {
        loaded: false,
        indexId: NCREIF_ID,
        reason: "No NCREIF Timberland observations uploaded yet",
        howTo: "POST quarterly rows to /api/private-index (ACCESS_TOKEN); GET /api/private-index?id=ncreif-timberland for the full series with de-smoothing rho.",
      };
    }
    return {
      loaded: true,
      indexId: NCREIF_ID,
      frequency: "Quarterly",
      periodKey: "YYYYQn",
      order: "newest-first",
      count: rows.length,
      asof: rows[0].period,
      observationStart: rows[rows.length - 1].period,
      periods: rows.map((r) => r.period),
      total: rows.map((r) => (r.total_return == null ? null : Number(r.total_return))),
      income: rows.map((r) => (r.income_return == null ? null : Number(r.income_return))),
      appreciation: rows.map((r) => (r.appreciation_return == null ? null : Number(r.appreciation_return))),
      detail: `/api/private-index?id=${NCREIF_ID}`,
    };
  } catch (err) {
    return { loaded: false, indexId: NCREIF_ID, reason: err instanceof Error ? err.message : String(err) };
  }
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
    const [timber, lumber, ncreif] = await Promise.all([fredBlock(PRIMARY), fredBlock(SECONDARY), ncreifBlock()]);
    // Monthly PPI, released mid-month. 6h edge cache.
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({
      assetClass: "Timberland",
      order: "newest-first",
      periodKey: "YYYY-MM",
      primary: "timberPpi",
      timberPpi: timber,
      lumberPpi: lumber,
      ncreif,
      source: `FRED (Federal Reserve Bank of St. Louis), series ${PRIMARY} and ${SECONDARY}, live; NCREIF Timberland Property Index via /api/private-index when loaded`,
      notes:
        "timberPpi (logs/bolts/timber/pulpwood) is the forest-gate price proxy; lumberPpi is one step downstream with history to 1926. Both are price-only index levels (1982=100, NSA) — no income — and are far more volatile than timberland total returns, so use them for regime, inflation-beta and pre-1987 bridging, not as the optimizer's return series. The NCREIF block, when loaded, is appraisal-based and must be de-smoothed (rho in /api/private-index) before use. Deflate with /api/cpi.",
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
