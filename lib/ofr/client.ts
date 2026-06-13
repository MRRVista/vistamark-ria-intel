/**
 * Office of Financial Research (OFR) clients. Two public, no-auth sources:
 *
 *  1. OFR Financial Stress Index (FSI) — a daily, zero-centered index of global
 *     financial stress with category (credit, equity valuation, funding, safe
 *     assets, volatility) and region (US, other advanced, emerging) breakdowns.
 *     Published CSV: https://www.financialresearch.gov/financial-stress-index/data/fsi.csv
 *
 *  2. OFR Data API (Short-Term Funding Monitor / Money Market Fund Monitor):
 *     Base: https://data.financialresearch.gov/v1
 *       /search?query=<q>                  catalog search
 *       /series/timeseries?mnemonic=<m>    observations for one series
 *
 * The Data API response shapes are normalized defensively, and the raw payload
 * is surfaced when normalization yields nothing, so the tools stay useful even
 * if the provider's response shape differs from what we expect.
 */
import { politeFetch, jsonFetch } from "../data/http";

const FSI_CSV = "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv";
const OFR_API = "https://data.financialresearch.gov/v1";

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export interface FsiRow {
  date: string;
  values: Record<string, number | null>;
}

export async function fetchFsi(): Promise<{ headers: string[]; rows: FsiRow[] }> {
  const res = await politeFetch(FSI_CSV, { timeoutMs: 60000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching OFR FSI CSV`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitCsv(lines[0]!);
  const rows: FsiRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsv(lines[i]!);
    const date = cells[0] ?? "";
    const values: Record<string, number | null> = {};
    for (let c = 1; c < headers.length; c++) {
      const key = headers[c] ?? `col${c}`;
      const raw = cells[c];
      const n = raw == null || raw === "" ? null : Number(raw);
      values[key] = Number.isFinite(n as number) ? (n as number) : null;
    }
    rows.push({ date, values });
  }
  return { headers, rows };
}

export interface OfrObservation {
  date: string;
  value: number | null;
}

function normalizeTimeseries(raw: unknown): OfrObservation[] {
  const pairs: any[] | null = Array.isArray(raw)
    ? raw
    : (raw as any)?.timeseries?.aggregation ??
      (raw as any)?.aggregation ??
      (raw as any)?.data ??
      null;
  if (!Array.isArray(pairs)) return [];
  const out: OfrObservation[] = [];
  for (const p of pairs) {
    if (Array.isArray(p) && p.length >= 2) {
      const v = Number(p[1]);
      out.push({ date: String(p[0]), value: Number.isFinite(v) ? v : null });
    } else if (p && typeof p === "object" && "date" in (p as any)) {
      const v = Number((p as any).value);
      out.push({ date: String((p as any).date), value: Number.isFinite(v) ? v : null });
    }
  }
  return out;
}

export async function ofrTimeseries(
  mnemonic: string
): Promise<{ observations: OfrObservation[]; raw: unknown }> {
  const url = `${OFR_API}/series/timeseries?mnemonic=${encodeURIComponent(mnemonic)}`;
  const raw = await jsonFetch<unknown>(url);
  return { observations: normalizeTimeseries(raw), raw };
}

export async function ofrSearch(query: string): Promise<unknown> {
  const url = `${OFR_API}/search?query=${encodeURIComponent(query)}`;
  return jsonFetch<unknown>(url);
}
