/**
 * GET /api/fedfunds -- the Effective Federal Funds Rate, for VistaBalancer's margin-rate math
 * (v10.99.624: margin rate = Fed Funds + spread; negative cash is a borrowing line, not a hole).
 *
 * Same posture as /api/cpi: GET only, no arguments, unauthenticated, a single PUBLIC macro series
 * from FRED -- no client, prospect, or database-backed data. The FRED key never leaves this server.
 *
 * SERIES CHOICE: DFF (Effective Federal Funds Rate, daily, percent, not seasonally adjusted) -- what
 * custodian margin schedules float on. The target range (DFEDTARL / DFEDTARU) rides along for context.
 * A blank FRED print ("." -- weekends, holidays) is skipped, never coerced to 0: the consumer gets the
 * latest REAL print and its date, so a stale value is visible rather than silent.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getObservations } from "../lib/fred/client";

const SERIES_ID = "DFF";

function allowOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const exact = [
    "vistabalancer.app",
    "www.vistabalancer.app",
    "vistaintel.app",
    "www.vistaintel.app",
    "vistabuilder.app",
    "www.vistabuilder.app",
    "vistabuilder.net",
    "www.vistabuilder.net",
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

async function latest(seriesId: string): Promise<{ value: number; date: string } | null> {
  const obs = await getObservations(seriesId, { sortOrder: "desc", limit: 30 });
  for (const o of obs.observations || []) {
    const v = parseLevel(o.value);
    if (v != null) return { value: v, date: o.date };
  }
  return null;
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
    const [eff, lo, hi] = await Promise.all([
      latest(SERIES_ID),
      latest("DFEDTARL").catch(() => null),
      latest("DFEDTARU").catch(() => null),
    ]);
    if (!eff) {
      res.status(502).json({ error: "FRED returned no usable DFF observation" });
      return;
    }
    // Daily series, published next business day: a 3h edge cache keeps VistaBalancer boots off the key.
    res.setHeader("Cache-Control", "public, s-maxage=10800, stale-while-revalidate=86400");
    res.status(200).json({
      seriesId: SERIES_ID,
      title: "Effective Federal Funds Rate",
      units: "Percent",
      rate: eff.value,
      asof: eff.date,
      targetLower: lo ? lo.value : null,
      targetUpper: hi ? hi.value : null,
      targetAsof: hi ? hi.date : null,
      source: `FRED (Federal Reserve Bank of St. Louis), series ${SERIES_ID}, live`,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
