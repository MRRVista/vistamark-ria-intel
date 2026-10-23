/**
 * Shared helpers for the compliance-screening family: TTL cache with
 * in-flight de-duplication, downloads through politeFetch, a small RFC-4180
 * CSV parser, HTML text utilities, and the name matcher used by every screen.
 */
import { politeFetch, redactUrl, type PoliteFetchOptions } from "../data/http";

export const HOUR = 3600_000;

interface CacheEntry<T> {
  at: number;
  ttl: number;
  value: Promise<T>;
}

const CACHE = new Map<string, CacheEntry<unknown>>();

/** Memoize an async loader for `ttlMs`; concurrent callers share one promise; failures are evicted. */
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

export interface TextResult {
  text: string;
  lastModified: string | null;
  finalUrl: string;
}

/** Download a text body (follows redirects, e.g. OFAC's presigned S3 hop) and keep Last-Modified. */
export async function fetchTextMeta(url: string, init: PoliteFetchOptions = {}): Promise<TextResult> {
  const res = await politeFetch(url, { timeoutMs: 45000, retries: 2, ...init, headers: { Accept: "*/*", ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body).slice(0, 160)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    text: buf.toString("utf8").replace(/^﻿/, ""),
    lastModified: isoFromHttpDate(res.headers.get("last-modified")),
    finalUrl: res.url || url,
  };
}

export async function fetchText(url: string, init: PoliteFetchOptions = {}): Promise<string> {
  return (await fetchTextMeta(url, init)).text;
}

export function isoFromHttpDate(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** RFC-4180 CSV → rows (handles quoted commas, doubled quotes and embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Strip HTML tags and decode the handful of entities government CMSs emit. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|div|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&ndash;|&#8211;/g, "-")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** MM/DD/YYYY → YYYY-MM-DD (null if unparseable). */
export function usDateToIso(v: string | null | undefined): string | null {
  const m = str(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/** Accept YYYY, YYYY-MM, YYYY-MM-DD or MM/DD/YYYY and return YYYY-MM-DD (start or end of period). */
export function normIsoDate(v: unknown, isEnd = false): string | null {
  const s = str(v);
  if (!s) return null;
  const us = usDateToIso(s);
  if (us) return us;
  if (/^\d{4}$/.test(s)) return isEnd ? `${s}-12-31` : `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return isEnd ? `${s}-31` : `${s}-01`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

export function isoToUs(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

const CORP_SUFFIX = new Set([
  "inc", "incorporated", "llc", "l.l.c", "ltd", "limited", "co", "company", "corp", "corporation", "plc", "sa", "s.a", "ag", "gmbh",
  "bv", "nv", "oy", "ab", "as", "spa", "srl", "sarl", "pte", "pty", "lp", "llp", "holdings", "holding", "group", "the", "of", "and", "de", "del", "la",
  "jsc", "ojsc", "pjsc", "ooo", "oao", "zao", "ao", "pao", "cjsc", "fze", "fzco", "fzc", "sdn", "bhd", "kk", "sas", "ltda", "cv", "mbh", "eood", "doo",
]);

/** Uppercase ASCII tokens; strips diacritics, punctuation and corporate boilerplate (kept if nothing else remains). */
export function nameTokens(name: string, stripCorp = true): string[] {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const all = base.split(/\s+/).filter(Boolean);
  if (!stripCorp) return all;
  const kept = all.filter((t) => !CORP_SUFFIX.has(t));
  return kept.length ? kept : all;
}

/** Jaro-Winkler similarity (0..1). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array<boolean>(la).fill(false);
  const mb = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = true;
      mb[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  const jaro = (matches / la + matches / lb + (matches - t) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, la, lb); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface Prepared {
  tokens: string[];
  joined: string;
}

export function prepareName(name: string, stripCorp = true): Prepared {
  const tokens = nameTokens(name, stripCorp);
  return { tokens, joined: tokens.join(" ") };
}

/**
 * Score 0-100 for how well candidate `c` matches query `q`.
 * - 100: identical after normalization
 * - token coverage: each query token's best Jaro-Winkler match among candidate tokens
 *   (≥0.88 counts), lightly penalized when the candidate has many extra tokens
 * - whole-string Jaro-Winkler as a floor for transpositions / short names
 * Token order is ignored, so "PUTIN, Vladimir" matches "Vladimir Putin".
 */
export function nameScore(q: Prepared, c: Prepared): number {
  if (!q.tokens.length || !c.tokens.length) return 0;
  if (q.joined === c.joined) return 100;
  let cov = 0;
  for (const qt of q.tokens) {
    let best = 0;
    for (const ct of c.tokens) {
      const s = qt === ct ? 1 : ct.startsWith(qt) && qt.length >= 3 ? 0.95 : jaroWinkler(qt, ct);
      if (s > best) best = s;
      if (best === 1) break;
    }
    if (best >= 0.88) cov += best;
    else if (best >= 0.8 && qt.length <= 3) cov += best * 0.6; // initials / short tokens
  }
  const coverage = cov / q.tokens.length;
  const extra = Math.max(0, c.tokens.length - q.tokens.length);
  const lengthFactor = 1 - Math.min(0.2, extra * 0.05);
  const tokenScore = coverage * lengthFactor;
  const whole = jaroWinkler(q.joined, c.joined);
  return Math.round(Math.max(tokenScore, whole * 0.97) * 100);
}

/** Cheap substring test on normalized text (used as a secondary, non-scored filter). */
export function normContains(hay: string, needle: string): boolean {
  return nameTokens(hay, false).join(" ").includes(nameTokens(needle, false).join(" "));
}
