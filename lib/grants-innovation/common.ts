/**
 * Shared helpers for the grants-innovation family. Re-exports the research
 * family's TTL cache + numeric helpers and adds a small POST-JSON wrapper
 * over politeFetch (NIH RePORTER, Grants.gov and PatentsView are POST APIs).
 */
import { politeFetch, redactUrl, jsonFetch } from "../data/http";

export { cached, HOUR, round, clampInt, toNum } from "../research/common";

export async function postJson<T = any>(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  const res = await politeFetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.headers ?? {}) },
    timeoutMs: opts.timeoutMs ?? 20000,
    retries: opts.retries ?? 1,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(text).slice(0, 240)}`);
  }
  return (await res.json()) as T;
}

export function jsonGet<T = any>(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number; retries?: number } = {}): Promise<T> {
  return jsonFetch<T>(url, { headers: { Accept: "application/json", ...(opts.headers ?? {}) }, timeoutMs: opts.timeoutMs ?? 20000, retries: opts.retries ?? 1 });
}

/** Keyed-source guard: throws BEFORE any network call when the env var is absent. */
export function requireKey(envName: string, where: string): string {
  const v = process.env[envName]?.trim();
  if (!v) throw new Error(`${envName} not configured — ${where}`);
  return v;
}

export function iso(d: unknown): string | null {
  if (!d) return null;
  const s = String(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : s;
}

export function trunc(s: unknown, n = 160): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t || null;
}

export function toList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(/[|,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function sumBy<T>(rows: T[], key: (r: T) => string | null | undefined, val: (r: T) => number | null | undefined, top = 10) {
  const m = new Map<string, { n: number; total: number }>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const e = m.get(k) ?? { n: 0, total: 0 };
    e.n++;
    e.total += val(r) ?? 0;
    m.set(k, e);
  }
  return [...m.entries()]
    .map(([name, e]) => ({ name, count: e.n, total: Math.round(e.total) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, top);
}
