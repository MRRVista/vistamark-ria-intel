/**
 * Shared SEC EDGAR plumbing for the filings-people family.
 *
 * - secText / secJson: politeFetch (declared Vistamark User-Agent, retries)
 *   with a small module-level TTL cache so a warm lambda doesn't refetch the
 *   same filing XML / submissions JSON within a session.
 * - ftsSearch: raw EDGAR full-text search (efts.sec.gov/LATEST/search-index)
 *   returning the hit _source fields we need (adsh, ciks, display_names,
 *   file_date, filename). lib/edgar/fulltext.ts exposes only the formatted
 *   tool output, so we hit the same endpoint here with the fields we need.
 * - entitySearch: EDGAR's company/person typeahead (search-index?keysTyped=),
 *   the only free name → CIK resolver that covers individuals (insiders).
 * - mapPool: bounded-concurrency map — SEC fair access is 10 req/s, we stay
 *   well under with 4 in flight.
 */
import { XMLParser } from "fast-xml-parser";
import { politeFetch, redactUrl } from "../data/http";

export const EFTS = "https://efts.sec.gov/LATEST/search-index";
export const ARCHIVES = "https://www.sec.gov/Archives/edgar/data";

const cache = new Map<string, { at: number; v: any }>();
const TTL_MS = 30 * 60 * 1000;

function cacheGet(k: string) {
  const e = cache.get(k);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) {
    cache.delete(k);
    return undefined;
  }
  return e.v;
}
function cacheSet(k: string, v: any) {
  if (cache.size > 500) cache.clear();
  cache.set(k, { at: Date.now(), v });
}

export class HttpStatusError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} from ${redactUrl(url)}`);
  }
}

export async function secText(url: string, timeoutMs = 15000): Promise<string> {
  const hit = cacheGet(url);
  if (hit !== undefined) return hit;
  const res = await politeFetch(url, { timeoutMs, retries: 2, headers: { Accept: "*/*" } });
  if (!res.ok) throw new HttpStatusError(res.status, url);
  const t = await res.text();
  cacheSet(url, t);
  return t;
}

export async function secJson<T = any>(url: string, timeoutMs = 15000): Promise<T> {
  const hit = cacheGet(url);
  if (hit !== undefined) return hit;
  const res = await politeFetch(url, { timeoutMs, retries: 2 });
  if (!res.ok) throw new HttpStatusError(res.status, url);
  const j = (await res.json()) as T;
  cacheSet(url, j);
  return j;
}

export const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep strings; we coerce numbers ourselves (CIKs/zips have leading zeros)
  trimValues: true,
  isArray: (name) =>
    [
      "reportingOwner",
      "nonDerivativeTransaction",
      "derivativeTransaction",
      "nonDerivativeHolding",
      "derivativeHolding",
      "relatedPersonInfo",
      "relationship",
      "footnote",
      "item",
    ].includes(name),
});

export function str(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "object") {
    if ("value" in v) return str(v.value);
    return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function num(v: any): number | null {
  const s = str(v);
  if (s == null) return null;
  const n = Number(s.replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function bool(v: any): boolean {
  const s = str(v);
  return s != null && /^(1|true|y|yes)$/i.test(s);
}

export function stripCik(cik: string | number): string {
  return String(Number(String(cik).replace(/\D/g, "")));
}

export function accNoDash(acc: string): string {
  return acc.replace(/-/g, "");
}

export function accDashed(acc: string): string {
  const d = acc.replace(/\D/g, "");
  if (d.length !== 18) return acc;
  return `${d.slice(0, 10)}-${d.slice(10, 12)}-${d.slice(12)}`;
}

export interface FtsHit {
  adsh: string;
  fileName: string | null;
  ciks: string[];
  displayNames: string[];
  form: string | null;
  fileDate: string | null;
  bizLocations: string[];
}

export async function ftsSearch(args: {
  q: string;
  forms?: string;
  startDate?: string;
  endDate?: string;
  from?: number;
}): Promise<{ total: number | null; hits: FtsHit[] }> {
  const p = new URLSearchParams();
  p.set("q", args.q);
  if (args.forms) p.set("forms", args.forms);
  if (args.startDate || args.endDate) {
    p.set("dateRange", "custom");
    if (args.startDate) p.set("startdt", args.startDate);
    if (args.endDate) p.set("enddt", args.endDate);
  }
  if (args.from) p.set("from", String(args.from));
  const raw = await secJson<any>(`${EFTS}?${p.toString()}`);
  const t = raw?.hits?.total;
  const total = typeof t === "number" ? t : t?.value ?? null;
  const list: any[] = Array.isArray(raw?.hits?.hits) ? raw.hits.hits : [];
  const hits: FtsHit[] = list.map((h) => {
    const id = String(h?._id ?? "");
    const i = id.indexOf(":");
    const s = h?._source ?? {};
    return {
      adsh: s.adsh ?? (i > 0 ? id.slice(0, i) : id),
      fileName: i > 0 ? id.slice(i + 1) : null,
      ciks: Array.isArray(s.ciks) ? s.ciks.map(String) : [],
      displayNames: Array.isArray(s.display_names) ? s.display_names.map(String) : [],
      form: s.file_type ?? s.form ?? null,
      fileDate: s.file_date ?? null,
      bizLocations: Array.isArray(s.biz_locations) ? s.biz_locations.map(String) : [],
    };
  });
  return { total, hits };
}

/** EDGAR entity typeahead — resolves company OR person names to CIKs. */
export async function entitySearch(name: string): Promise<Array<{ cik: string; name: string }>> {
  const raw = await secJson<any>(`${EFTS}?keysTyped=${encodeURIComponent(name)}`);
  const list: any[] = Array.isArray(raw?.hits?.hits) ? raw.hits.hits : [];
  return list
    .map((h) => ({ cik: String(h?._id ?? ""), name: String(h?._source?.entity ?? "") }))
    .filter((e) => /^\d+$/.test(e.cik));
}

/** Locate the primary XML in a filing via its index.json (fallback path). */
export async function findFilingXml(cik: string, acc: string, prefer?: RegExp): Promise<string | null> {
  const dir = `${ARCHIVES}/${stripCik(cik)}/${accNoDash(acc)}`;
  const idx = await secJson<any>(`${dir}/index.json`);
  const items: any[] = idx?.directory?.item ?? [];
  const xmls = items.map((i) => String(i.name)).filter((n) => /\.xml$/i.test(n) && !/FilingSummary/i.test(n));
  const pick = (prefer && xmls.find((n) => prefer.test(n))) ?? xmls[0];
  return pick ? `${dir}/${pick}` : null;
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export function errMsg(e: unknown): string {
  return redactUrl(e instanceof Error ? e.message : String(e));
}
