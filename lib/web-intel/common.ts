/**
 * Shared helpers for the web-intel family (news, entities, courts, corporates).
 * Everything goes through politeFetch so the Vistamark User-Agent, retries and
 * credential redaction apply. Several upstreams (GDELT, Wikimedia, CourtListener)
 * rate-limit by IP and answer 429 — fetchWithBackoff makes exactly ONE extra
 * attempt after a source-specific pause and then surfaces a clear error.
 */
import { politeFetch, redactUrl } from "../data/http";

export { cached, clampInt, round, HOUR } from "../research/common";

export const MIN = 60 * 1000;

export const VISTAMARK_UA =
  process.env.VISTAMARK_USER_AGENT ??
  "Vistamark Intel (vistamark-ria-intel; mrice@vistamarkllc.com)";

/** Google News answers 503 "automated queries" to non-browser UAs; a browser UA is accepted. */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface BackoffOptions {
  /** Pause before the single retry on 429 (ms). */
  retryAfterMs?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Friendly source name for error messages. */
  source: string;
  /** Extra hint appended to a 429 error. */
  hint429?: string;
}

/**
 * GET `url`; on 429 wait `retryAfterMs` and try once more (politeFetch's own
 * 429 retry is disabled so we control the cadence). Non-OK -> Error with status.
 */
export async function fetchWithBackoff(url: string, opts: BackoffOptions): Promise<Response> {
  const { retryAfterMs = 2000, headers = {}, timeoutMs = 20000, source, hint429 } = opts;
  // politeFetch would itself retry a 429 after 400 ms, which only burns GDELT/Wikimedia
  // quota; so run single attempts here: one network-error retry, one paced 429 retry.
  const once = async () => {
    try {
      return await politeFetch(url, { retries: 0, timeoutMs, headers });
    } catch (e) {
      await sleep(600);
      return politeFetch(url, { retries: 0, timeoutMs, headers });
    }
  };
  let res = await once();
  if (res.status === 429) {
    await sleep(retryAfterMs);
    res = await politeFetch(url, { retries: 0, timeoutMs, headers });
  }
  if (res.status === 429) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new Error(`${source} rate-limited (HTTP 429) after retry${hint429 ? ` — ${hint429}` : ""}. Upstream said: ${redactUrl(body)}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`${source} HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body)}`);
  }
  return res;
}

export async function textWithBackoff(url: string, opts: BackoffOptions): Promise<string> {
  const res = await fetchWithBackoff(url, opts);
  return res.text();
}

export async function jsonWithBackoff<T = any>(url: string, opts: BackoffOptions): Promise<T> {
  const res = await fetchWithBackoff(url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${opts.source} returned non-JSON (${text.replace(/\s+/g, " ").slice(0, 120)})`);
  }
}

export function trim(s: unknown, max = 200): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Minimal RSS 2.0 item parser (no XML dependency). Returns raw tag -> text maps. */
export function parseRssItems(xml: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1]!;
    const rec: Record<string, string> = {};
    const tagRe = /<([A-Za-z][\w:.-]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let t: RegExpExecArray | null;
    while ((t = tagRe.exec(body))) {
      const name = t[1]!.toLowerCase();
      if (!(name in rec)) rec[name] = decodeEntities(t[3]!.trim());
    }
    // <source url="...">Name</source>
    const src = body.match(/<source\b[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/i);
    if (src) {
      rec["source_url"] = decodeEntities(src[1]!);
      rec["source"] = decodeEntities(src[2]!.trim());
    }
    items.push(rec);
  }
  return items;
}

export function toIsoDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  // GDELT seendate: 20261016T194500Z
  const g = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (g) return `${g[1]}-${g[2]}-${g[3]}T${g[4]}:${g[5]}:${g[6]}Z`;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
