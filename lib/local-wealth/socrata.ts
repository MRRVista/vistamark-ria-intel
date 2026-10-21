/**
 * Minimal Socrata SODA helper shared by the local-wealth tools.
 *
 * Hosts used (both verified live 2026-10-21, no key):
 *   - datacatalog.cookcountyil.gov — Cook County Assessor datasets
 *   - data.illinois.gov            — IL Dept of Revenue PTAX-203, IDFPR Professional Licensing
 *
 * An app token is OPTIONAL: when SOCRATA_APP_TOKEN is set it is sent as the
 * X-App-Token header (higher throttling ceiling); without it Socrata still
 * serves anonymous requests, which is all these tools need at their volumes.
 */
import { jsonFetch } from "../data/http";

export const COOK_HOST = "https://datacatalog.cookcountyil.gov";
export const IL_HOST = "https://data.illinois.gov";

/** Escape a value for a SoQL string literal. */
export function soqlStr(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Escape a LIKE fragment (Socrata uses % wildcards; strip user wildcards). */
export function soqlLike(v: string): string {
  return soqlStr(`%${String(v).toUpperCase().replace(/[%_]/g, " ").replace(/\s+/g, " ").trim()}%`);
}

export function soqlIn(values: string[]): string {
  return `(${values.map(soqlStr).join(",")})`;
}

export async function soda<T = any>(
  host: string,
  datasetId: string,
  params: Record<string, string | number | undefined>,
  timeoutMs = 20000
): Promise<T[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    qs.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.SOCRATA_APP_TOKEN) headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
  const rows = await jsonFetch<T[]>(`${host}/resource/${datasetId}.json?${qs}`, { headers, timeoutMs, retries: 2 });
  if (!Array.isArray(rows)) throw new Error(`Unexpected Socrata response shape from ${datasetId}`);
  return rows;
}

/** Split an array into chunks. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// --- small coercion helpers -------------------------------------------------

export const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s : null;
};

export const day = (v: unknown): string | null => {
  const s = str(v);
  return s ? s.slice(0, 10) : null;
};

/** Normalize YYYY-MM-DD input; throws on garbage. */
export function isoDate(v: unknown, label: string): string | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} must be YYYY-MM-DD (got '${s}')`);
  return s;
}

export function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

export function clampLimit(v: unknown, def: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/** Accept a string or array of strings → trimmed non-empty strings. */
export function strList(v: unknown): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;\s]+/);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/** Module-level TTL cache. */
const cache = new Map<string, { at: number; value: any }>();
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
