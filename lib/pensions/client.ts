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
 * The response envelope varies — observed shapes include a bare array of row
 * objects, [statusMeta, [rows]], nested arrays, and keyed objects — so
 * normalizeRows() flattens mixed envelopes and keeps only elements that look
 * like plan data rows (contain fy / ppd_id / PlanName keys, any casing).
 */
import { jsonFetch } from "../data/http";

const PPD_BASE = "https://publicplansdata.org/api/";

export interface PpdRow {
  [key: string]: any;
}

function looksLikeDataRow(r: any): boolean {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  for (const k of Object.keys(r)) {
    const kl = k.toLowerCase();
    if (kl === "fy" || kl === "ppd_id" || kl === "planname") return true;
  }
  return false;
}

/** Normalize the PPD API's possible response shapes into an array of row objects. */
export function normalizeRows(raw: any): PpdRow[] | null {
  if (!raw) return null;
  let objs: any[] = [];
  if (Array.isArray(raw)) {
    // Flatten mixed envelopes like [statusMeta, [rows]] or [[rows]].
    objs = (raw as any[]).flat(3).filter((r) => r && typeof r === "object" && !Array.isArray(r));
  } else if (typeof raw === "object") {
    for (const key of ["data", "rows", "result", "results"]) {
      const v = (raw as any)[key];
      if (Array.isArray(v)) {
        objs = v.flat(3).filter((r) => r && typeof r === "object" && !Array.isArray(r));
        break;
      }
    }
    if (!objs.length) {
      const vals = Object.values(raw);
      if (vals.length && vals.every((v) => v && typeof v === "object")) {
        objs = (vals as any[]).flat(3).filter((r) => r && typeof r === "object" && !Array.isArray(r));
      }
    }
  }
  if (!objs.length) return null;
  // Keep rows that look like plan data; if none qualify, return everything so
  // callers/diagnostics can surface the actual shape rather than hiding it.
  const dataRows = objs.filter(looksLikeDataRow);
  return dataRows.length ? dataRows : objs;
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
