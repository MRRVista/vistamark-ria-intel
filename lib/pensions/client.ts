/**
 * Client for the Public Plans Database (PPD) API.
 *
 * PPD (publicplansdata.org) is the Center for Retirement Research / MissionSquare /
 * NASRA / GFOA panel of the largest U.S. state & local public pension plans
 * (~230 plans covering the vast majority of public-plan assets and members),
 * annual data FY2001+. Free public API, no key.
 *
 * Endpoint shape (QVariables-style query):
 *   https://publicplansdata.org/api/?q=QVariables&variables=fy,ppd_id,PlanName,...&format=json
 *   Optional filters: filterfystart=YYYY, filterfyend=YYYY, filterppdid=NN
 *
 * The exact response envelope varies, so normalizeRows() accepts several
 * shapes (bare array, {data|rows|result|results: []}, index-keyed object,
 * nested arrays) and the tools layer treats every field defensively (values
 * often arrive as strings; variables missing for a plan-year arrive null).
 */
import { jsonFetch } from "../data/http";

const PPD_BASE = "https://publicplansdata.org/api/";

export interface PpdRow {
  [key: string]: any;
}

/** Normalize the PPD API's possible response shapes into an array of row objects. */
export function normalizeRows(raw: any): PpdRow[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    if (raw.length && Array.isArray(raw[0])) {
      return (raw as any[]).flat().filter((r) => r && typeof r === "object" && !Array.isArray(r));
    }
    return raw.filter((r) => r && typeof r === "object" && !Array.isArray(r));
  }
  if (typeof raw === "object") {
    for (const key of ["data", "rows", "result", "results"]) {
      const v = (raw as any)[key];
      if (Array.isArray(v)) return normalizeRows(v);
    }
    const vals = Object.values(raw);
    if (vals.length && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      return vals as PpdRow[];
    }
  }
  return null;
}

export interface PpdQueryOpts {
  fyStart?: number;
  fyEnd?: number;
  ppdId?: number;
}

export async function ppdQVariables(
  variables: string[],
  opts: PpdQueryOpts = {}
): Promise<{ rows: PpdRow[]; raw: any | null }> {
  const params = new URLSearchParams();
  params.set("q", "QVariables");
  params.set("variables", variables.join(","));
  params.set("format", "json");
  if (opts.fyStart != null) params.set("filterfystart", String(opts.fyStart));
  if (opts.fyEnd != null) params.set("filterfyend", String(opts.fyEnd));
  if (opts.ppdId != null) params.set("filterppdid", String(opts.ppdId));
  const raw = await jsonFetch<any>(`${PPD_BASE}?${params.toString()}`);
  const rows = normalizeRows(raw);
  if (!rows) return { rows: [], raw };
  return { rows, raw: null };
}
