/**
 * Shared helpers for the Fed Regional family: TTL cache with in-flight
 * de-duplication, binary/text download, and date normalization.
 */
import { politeFetch, redactUrl } from "../data/http";

export const HOUR = 3600_000;

interface CacheEntry<T> {
  at: number;
  value?: T;
  promise?: Promise<T>;
}

const CACHE = new Map<string, CacheEntry<unknown>>();

/** Memoize an async loader under `key` for `ttlMs`; concurrent callers share one in-flight promise. */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = CACHE.get(key) as CacheEntry<T> | undefined;
  if (hit) {
    if (hit.value !== undefined && now - hit.at < ttlMs) return hit.value;
    if (hit.promise) return hit.promise;
  }
  const promise = loader()
    .then((value) => {
      CACHE.set(key, { at: Date.now(), value });
      return value;
    })
    .catch((err) => {
      // Don't cache failures; keep a stale value if we had one.
      if (hit?.value !== undefined) CACHE.set(key, { at: hit.at, value: hit.value });
      else CACHE.delete(key);
      throw err;
    });
  CACHE.set(key, { at: hit?.at ?? 0, value: hit?.value, promise });
  return promise;
}

export async function fetchBuffer(url: string, timeoutMs = 45000): Promise<Buffer> {
  const res = await politeFetch(url, { timeoutMs, retries: 2, headers: { Accept: "*/*" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body).slice(0, 160)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchText(url: string, timeoutMs = 30000): Promise<string> {
  const buf = await fetchBuffer(url, timeoutMs);
  return buf.toString("utf8").replace(/^﻿/, "");
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Normalize '30-Jun-1961', '31-Oct-61', '6/30/2026', '2026-06-30' → 'YYYY-MM-DD' (null if unparseable). */
export function normDate(s: unknown): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return null;
    let y = Number(m[3]);
    if (m[3].length === 2) y = y >= 50 ? 1900 + y : 2000 + y;
    return `${y}-${pad(mon)}-${pad(Number(m[1]))}`;
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    let y = Number(m[3]);
    if (m[3].length === 2) y = y >= 50 ? 1900 + y : 2000 + y;
    return `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  }
  return null;
}

/** Parse a number from a cell; handles '12.3%', '.', '#N/A', '' → null. */
export function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).trim().replace(/,/g, "");
  if (!t || t === "." || t === "*" || /^#?n\/?a/i.test(t)) return null;
  const pct = t.endsWith("%");
  const n = Number(pct ? t.slice(0, -1) : t);
  return Number.isFinite(n) ? n : null;
}

export function round(v: number | null | undefined, dp = 3): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Simple CSV → string[][] (handles quotes). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      out.push(row); row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((x) => x.trim() !== ""));
}
