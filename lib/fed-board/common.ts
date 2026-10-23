/**
 * Shared helpers for the Fed Board & Treasury Markets family: TTL cache,
 * HTML/text downloads through politeFetch, tiny HTML/RSS text utilities,
 * numeric parsing and FiscalData paging.
 */
import { politeFetch, redactUrl } from "../data/http";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

interface CacheEntry<T> {
  at: number;
  ttl: number;
  value: Promise<T>;
}

const CACHE = new Map<string, CacheEntry<unknown>>();

/** Memoize an async loader under `key` for `ttlMs`; concurrent callers share one in-flight promise; failures are evicted. */
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

export async function fetchText(url: string, timeoutMs = 30000, retries = 2, accept = "*/*", userAgent?: string): Promise<string> {
  const headers: Record<string, string> = { Accept: accept };
  if (userAgent) headers["User-Agent"] = userAgent;
  const res = await politeFetch(url, { timeoutMs, retries, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Strip a UTF-8 BOM (Fed JSON/CSV files and RSS feeds carry one).
  let s = buf.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

/**
 * FiscalData JSON fetch. The sandbox/Vercel proxy intermittently drops the
 * api.fiscaldata.treasury.gov tunnel, so beyond politeFetch's own retries we
 * retry the whole call once on a network error.
 */
export async function fetchJson<T = any>(url: string, timeoutMs = 30000): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await politeFetch(url, { timeoutMs, retries: 1, headers: { Accept: "application/json" } });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body).slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && /^HTTP 4\d\d/.test(err.message)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetch failed: ${redactUrl(url)}`);
}

export const FISCAL_BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";

export interface FiscalResponse<T> {
  data: T[];
  meta: { count: number; "total-count"?: number; "total-pages"?: number; labels?: Record<string, string> };
}

/** Build a FiscalData URL. `filter` entries are already in `field:op:value` form. */
export function fiscalUrl(
  path: string,
  opts: { fields?: string[]; filter?: string[]; sort?: string; pageSize?: number; page?: number }
): string {
  const params: string[] = ["format=json"];
  if (opts.fields?.length) params.push(`fields=${opts.fields.join(",")}`);
  if (opts.filter?.length) params.push(`filter=${opts.filter.join(",")}`);
  if (opts.sort) params.push(`sort=${opts.sort}`);
  params.push(`page[size]=${opts.pageSize ?? 100}`);
  if (opts.page) params.push(`page[number]=${opts.page}`);
  return `${FISCAL_BASE}/${path}?${params.join("&")}`;
}

/** FiscalData numbers arrive as strings, with the literal "null" for missing. */
export function fnum(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "null" || /^(na|n\/a)$/i.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function round(n: number | null | undefined, dp = 3): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Days from today (UTC) to an ISO date; negative when in the past. */
export function daysUntil(iso: string): number {
  const t = Date.parse(`${iso}T00:00:00Z`);
  const today = Date.parse(`${todayIso()}T00:00:00Z`);
  return Math.round((t - today) / 86400_000);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Strip tags/scripts, decode entities, collapse whitespace. Block-level tags become newlines. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Unwrap <![CDATA[...]]> and trim. */
export function cdata(s: string | undefined): string {
  if (!s) return "";
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return decodeEntities((m ? m[1]! : s).trim());
}

/** First capture of `<tag>...</tag>` inside `xml` (non-greedy, tolerant of attributes). */
export function tagText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : undefined;
}

/** RFC-822 pubDate -> ISO date (YYYY-MM-DD) + full ISO timestamp. */
export function parsePubDate(s: string): { date: string | null; at: string | null } {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return { date: null, at: null };
  const d = new Date(t);
  return { date: d.toISOString().slice(0, 10), at: d.toISOString() };
}

/** Minimal RFC-4180 CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  MONTHS.flatMap((m, i) => [[m.toLowerCase(), i], [m.slice(0, 3).toLowerCase(), i]])
);

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
