/**
 * Shared helpers for the research-datasets family: TTL cache, binary/text
 * downloads through politeFetch, numeric parsing, and return statistics.
 */
import { politeFetch, redactUrl } from "../data/http";

export const HOUR = 60 * 60 * 1000;

interface CacheEntry<T> {
  at: number;
  ttl: number;
  value: Promise<T>;
}

const CACHE = new Map<string, CacheEntry<unknown>>();

/**
 * Memoize an async loader under `key` for `ttlMs`. The in-flight promise is
 * cached so concurrent callers share one download; a rejected load is evicted
 * so the next call retries.
 */
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = CACHE.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = load();
  CACHE.set(key, { at: Date.now(), ttl: ttlMs, value });
  value.catch(() => {
    if (CACHE.get(key)?.value === value) CACHE.delete(key);
  });
  return value;
}

export async function fetchBuffer(url: string, timeoutMs = 45000, retries = 2): Promise<Buffer> {
  const res = await politeFetch(url, { timeoutMs, retries, headers: { Accept: "*/*" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchText(url: string, timeoutMs = 30000, retries = 2): Promise<string> {
  const buf = await fetchBuffer(url, timeoutMs, retries);
  return buf.toString("utf8");
}

/** Parse a number from a spreadsheet/HTML cell: handles %, $, commas, "NA", decimal-comma glitches. */
export function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s || /^(na|n\/a|nan|#n\/a|#div\/0!|-)$/i.test(s)) return null;
  let pct = false;
  if (s.endsWith("%")) {
    pct = true;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/^\$\s*/, "").replace(/^(-?)\$\s*/, "$1");
  // "6,36" (decimal comma, no thousands) vs "2,751.49" (thousands comma)
  if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : n;
}

export function round(n: number | null | undefined, dp = 4): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Percentile rank (0-100) of `x` within `values` (share of values <= x). */
export function percentileRank(values: number[], x: number): number | null {
  if (!values.length) return null;
  let le = 0;
  for (const v of values) if (v <= x) le++;
  return round((le / values.length) * 100, 1);
}

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface ReturnStats {
  periods: number;
  cumulativeReturn: number | null;
  annualizedReturn: number | null;
  annualizedVol: number | null;
  arithmeticMeanPerPeriod: number | null;
  sharpeLike: number | null;
  best: number | null;
  worst: number | null;
  pctPositive: number | null;
}

/**
 * Stats for a series of simple periodic returns expressed as DECIMALS
 * (0.0123 = 1.23%). `periodsPerYear` annualizes (12 monthly, 252 daily, 1 annual).
 * sharpeLike = annualized arithmetic mean / annualized vol — a true Sharpe only
 * when the inputs are already excess returns (factor long/shorts, Mkt-RF).
 */
export function returnStats(rets: number[], periodsPerYear: number): ReturnStats {
  const n = rets.length;
  if (!n) {
    return { periods: 0, cumulativeReturn: null, annualizedReturn: null, annualizedVol: null, arithmeticMeanPerPeriod: null, sharpeLike: null, best: null, worst: null, pctPositive: null };
  }
  let growth = 1;
  let sum = 0;
  let pos = 0;
  let best = -Infinity;
  let worst = Infinity;
  for (const r of rets) {
    growth *= 1 + r;
    sum += r;
    if (r > 0) pos++;
    if (r > best) best = r;
    if (r < worst) worst = r;
  }
  const mean = sum / n;
  let ss = 0;
  for (const r of rets) ss += (r - mean) * (r - mean);
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : null;
  const years = n / periodsPerYear;
  const annRet = growth > 0 && years > 0 ? Math.pow(growth, 1 / years) - 1 : null;
  const annVol = sd != null ? sd * Math.sqrt(periodsPerYear) : null;
  return {
    periods: n,
    cumulativeReturn: round(growth - 1, 4),
    annualizedReturn: years >= 1 ? round(annRet, 4) : null,
    annualizedVol: round(annVol, 4),
    arithmeticMeanPerPeriod: round(mean, 5),
    sharpeLike: annVol ? round((mean * periodsPerYear) / annVol, 2) : null,
    best: round(best, 4),
    worst: round(worst, 4),
    pctPositive: round((pos / n) * 100, 1),
  };
}

/** Excel 1900-system serial -> YYYY-MM-DD. */
export function excelSerialToIso(n: number): string {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

/** Normalize assorted date cells (Excel serial, MM/DD/YYYY, ISO, Date) to YYYY-MM-DD. */
export function normDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return v > 1000 && v < 200000 ? excelSerialToIso(v) : null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d+(\.\d+)?$/.test(s)) return normDate(Number(s));
  return null;
}

/** Filter a dated, ascending series to a [start, end] window and/or the last `years` years. */
export function windowFilter<T extends { date: string }>(
  rows: T[],
  opts: { start?: string; end?: string; years?: number }
): T[] {
  let out = rows;
  if (opts.start) out = out.filter((r) => r.date >= normalizeBound(opts.start!, false));
  if (opts.end) out = out.filter((r) => r.date <= normalizeBound(opts.end!, true));
  if (opts.years && out.length) {
    const last = out[out.length - 1]!.date;
    const y = Number(last.slice(0, 4)) - opts.years;
    const cutoff = `${y}${last.slice(4)}`;
    out = out.filter((r) => r.date > cutoff);
  }
  return out;
}

/** Accept YYYY, YYYY-MM, YYYYMM, YYYY-MM-DD as window bounds. */
function normalizeBound(s: string, isEnd: boolean): string {
  const t = String(s).trim();
  if (/^\d{4}$/.test(t)) return isEnd ? `${t}-12-31` : `${t}-01-01`;
  if (/^\d{6}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4)}${isEnd ? "-31" : "-01"}`;
  if (/^\d{4}-\d{2}$/.test(t)) return `${t}${isEnd ? "-31" : "-01"}`;
  return t;
}
