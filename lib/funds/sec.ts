/**
 * Shared SEC plumbing for the funds family (N-PORT / N-CEN / Form PF stats /
 * Form MA). Everything is live from sec.gov — no bulk ingest — with
 * module-level TTL caches for the static reference files so warm lambdas
 * don't refetch them:
 *
 *   company_tickers_mf.json          ~1.2MB  ticker -> cik/seriesId/classId   (24h)
 *   investment-company-series-class  ~8MB CSV  series/class names + tickers   (24h)
 *     (published annually-ish, updated through the year; link scraped from
 *      the SEC page, with a hard-coded fallback)
 *
 * All requests go through politeFetch (declared Vistamark UA per SEC fair
 * access). Callers keep request counts to a handful per tool call.
 */
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { politeFetch, jsonFetch, redactUrl } from "../data/http";
import { companyTickers, padCik } from "../edgar/client";

export const SEC = "https://www.sec.gov";

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------
const _cache = new Map<string, { at: number; value: any }>();
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  _cache.set(key, { at: Date.now(), value });
  return value;
}
export const H6 = 6 * 3600_000;
export const H24 = 24 * 3600_000;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
export async function textFetch(url: string, timeoutMs = 30000): Promise<string> {
  const res = await politeFetch(url, { timeoutMs, headers: { Accept: "*/*" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body).slice(0, 160)}`);
  }
  return res.text();
}

export async function bufferFetch(url: string, timeoutMs = 30000): Promise<Buffer> {
  const res = await politeFetch(url, { timeoutMs, headers: { Accept: "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  return Buffer.from(await res.arrayBuffer());
}

export { jsonFetch, padCik };

export function archiveUrl(cik: string | number, accession: string, file = ""): string {
  return `${SEC}/Archives/edgar/data/${Number(String(cik).replace(/\D/g, ""))}/${accession.replace(/-/g, "")}/${file}`;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------
export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function asArray<T = any>(x: any): T[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Text of a parsed node (string, or {#text}). */
export function txt(x: any): string | null {
  if (x == null) return null;
  if (typeof x === "string") return x.trim() || null;
  if (typeof x === "number") return String(x);
  if (typeof x === "object" && x["#text"] != null) return String(x["#text"]).trim() || null;
  return null;
}

export function num(x: any): number | null {
  const s = txt(x);
  if (s == null || s === "N/A") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Drop "N/A"/empty values so provider records stay compact. */
export function clean<T extends Record<string, any>>(o: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === "" || v === "N/A") continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal .xlsx -> grid reader (adm-zip + fast-xml-parser). Returns raw rows
// (string cells, column positions preserved) for every sheet requested.
// ---------------------------------------------------------------------------
const xlsxParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
});

function colIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function richText(si: any): string {
  if (si == null) return "";
  if (typeof si === "string") return si;
  if (si.t != null) return typeof si.t === "object" ? String(si.t["#text"] ?? "") : String(si.t);
  if (si.r != null) return asArray(si.r).map((r: any) => (typeof r.t === "object" ? String(r.t?.["#text"] ?? "") : String(r.t ?? ""))).join("");
  return "";
}

export interface Workbook {
  sheetNames: string[];
  sheet(name: string): string[][] | null;
}

export function readXlsx(buf: Buffer): Workbook {
  const zip = new AdmZip(buf);
  const read = (name: string) => {
    const e = zip.getEntry(name);
    return e ? xlsxParser.parse(e.getData().toString("utf8")) : null;
  };
  const wb = read("xl/workbook.xml");
  const rels = read("xl/_rels/workbook.xml.rels");
  const sheets = asArray(wb?.workbook?.sheets?.sheet);
  const relList = asArray(rels?.Relationships?.Relationship);
  const sst = read("xl/sharedStrings.xml");
  const shared: string[] = asArray(sst?.sst?.si).map(richText);
  const memo = new Map<string, string[][]>();
  return {
    sheetNames: sheets.map((s: any) => String(s["@_name"])),
    sheet(name: string) {
      if (memo.has(name)) return memo.get(name)!;
      const s = sheets.find((x: any) => String(x["@_name"]).toLowerCase() === name.toLowerCase());
      if (!s) return null;
      const rel = relList.find((r: any) => r["@_Id"] === s["@_r:id"]);
      let target: string = rel?.["@_Target"] ?? "";
      target = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      const ws = read(target);
      const grid: string[][] = [];
      for (const r of asArray(ws?.worksheet?.sheetData?.row)) {
        const line: string[] = [];
        for (const c of asArray(r.c)) {
          const ref: string = c["@_r"] ?? "";
          const idx = ref ? colIndex(ref) : line.length;
          const t = c["@_t"];
          let v = "";
          if (t === "s") v = shared[Number(txt(c.v) ?? c.v)] ?? "";
          else if (t === "inlineStr") v = richText(c.is);
          else if (c.v != null) v = typeof c.v === "object" ? String(c.v["#text"] ?? "") : String(c.v);
          while (line.length < idx) line.push("");
          line[idx] = v.trim();
        }
        grid.push(line);
      }
      memo.set(name, grid);
      return grid;
    },
  };
}

// ---------------------------------------------------------------------------
// Scrape a page's links (pdf/xlsx/csv) with their anchor text.
// ---------------------------------------------------------------------------
export function pageLinks(html: string, extRe = /\.(pdf|xlsx|xls|csv|zip)$/i): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (!extRe.test(href.split("?")[0])) continue;
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    out.push({ href: href.startsWith("http") ? href : `${SEC}${href.startsWith("/") ? "" : "/"}${href}`, text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutual fund / ETF ticker map (company_tickers_mf.json)
// ---------------------------------------------------------------------------
export interface MfTicker {
  cik: number;
  seriesId: string;
  classId: string;
  symbol: string;
}

export async function mfTickers(): Promise<MfTicker[]> {
  return cached("mf-tickers", H24, async () => {
    const raw = await jsonFetch<{ fields: string[]; data: any[][] }>(`${SEC}/files/company_tickers_mf.json`);
    const f = raw.fields ?? ["cik", "seriesId", "classId", "symbol"];
    const iC = f.indexOf("cik"), iS = f.indexOf("seriesId"), iK = f.indexOf("classId"), iT = f.indexOf("symbol");
    return (raw.data ?? []).map((r) => ({
      cik: Number(r[iC]),
      seriesId: String(r[iS] ?? ""),
      classId: String(r[iK] ?? ""),
      symbol: String(r[iT] ?? ""),
    }));
  });
}

// ---------------------------------------------------------------------------
// Investment Company Series & Class information (CSV) — names for series/classes.
// ---------------------------------------------------------------------------
export interface SeriesClassRow {
  fileNumber: string;
  cik: string; // 10-digit
  entityName: string;
  orgType: string;
  seriesId: string;
  seriesName: string;
  classId: string;
  className: string;
  ticker: string;
  city: string;
  state: string;
}

const SC_PAGE = `${SEC}/data-research/sec-markets-data/investment-company-series-class-information`;
const SC_FALLBACK = `${SEC}/files/investment/data/other/investment-company-series-class-information/investment-company-series-class-2026.csv`;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export async function seriesClassTable(): Promise<{ rows: SeriesClassRow[]; url: string }> {
  return cached("series-class", H24, async () => {
    let url = SC_FALLBACK;
    try {
      const html = await textFetch(SC_PAGE, 15000);
      const csv = pageLinks(html, /\.csv$/i)[0];
      if (csv) url = csv.href;
    } catch {
      /* fall back to hard-coded URL */
    }
    const text = (await textFetch(url, 45000)).replace(/^﻿/, "");
    const lines = text.split(/\r?\n/);
    const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const idx = (name: string) => header.findIndex((h) => h === name);
    const I = {
      fn: idx("reporting file number"), cik: idx("cik number"), en: idx("entity name"), ot: idx("entity org type"),
      sid: idx("series id"), sn: idx("series name"), cid: idx("class id"), cn: idx("class name"), tk: idx("class ticker"),
      city: idx("city"), st: idx("state"),
    };
    const rows: SeriesClassRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const c = parseCsvLine(lines[i]);
      rows.push({
        fileNumber: c[I.fn] ?? "", cik: padCik(c[I.cik] ?? ""), entityName: c[I.en] ?? "", orgType: c[I.ot] ?? "",
        seriesId: c[I.sid] ?? "", seriesName: c[I.sn] ?? "", classId: c[I.cid] ?? "", className: c[I.cn] ?? "",
        ticker: (c[I.tk] ?? "").trim().toUpperCase(), city: c[I.city] ?? "", state: c[I.st] ?? "",
      });
    }
    return { rows, url };
  });
}

// ---------------------------------------------------------------------------
// Fund resolution: ticker / seriesId / CIK (+series name) -> registrant + series
// ---------------------------------------------------------------------------
export interface ResolvedFund {
  cik: string; // 10-digit registrant CIK
  seriesId: string | null;
  classId: string | null;
  ticker: string | null;
  via: string;
  seriesName?: string | null;
  registrantName?: string | null;
  /** When a CIK has several series and no filter narrowed it. */
  candidates?: Array<{ seriesId: string; seriesName: string }>;
}

export async function resolveFund(args: {
  ticker?: string;
  seriesId?: string;
  cik?: string | number;
  seriesName?: string;
}): Promise<ResolvedFund | null> {
  const seriesIdArg = args.seriesId?.trim().toUpperCase();
  if (args.ticker) {
    const t = args.ticker.trim().toUpperCase();
    const mf = (await mfTickers()).find((x) => x.symbol.toUpperCase() === t);
    if (mf) return { cik: padCik(mf.cik), seriesId: mf.seriesId || null, classId: mf.classId || null, ticker: t, via: "company_tickers_mf.json" };
    // UITs such as SPY / DIA / QQQ trusts aren't in the MF map — fall back to the operating-company map.
    const co = (await companyTickers()).find((x) => x.ticker.toUpperCase() === t);
    if (co) return { cik: padCik(co.cik), seriesId: null, classId: null, ticker: t, via: "company_tickers.json", registrantName: co.title };
    return null;
  }
  if (seriesIdArg && /^S\d{9}$/.test(seriesIdArg)) {
    const mf = (await mfTickers()).find((x) => x.seriesId === seriesIdArg);
    if (mf) return { cik: padCik(mf.cik), seriesId: seriesIdArg, classId: null, ticker: null, via: "company_tickers_mf.json" };
    const { rows } = await seriesClassTable();
    const r = rows.find((x) => x.seriesId === seriesIdArg);
    if (r) return { cik: r.cik, seriesId: seriesIdArg, classId: null, ticker: null, via: "series-class CSV", seriesName: r.seriesName, registrantName: r.entityName };
    return { cik: "", seriesId: seriesIdArg, classId: null, ticker: null, via: "seriesId only" };
  }
  if (args.cik != null && String(args.cik).trim() !== "") {
    const cik = padCik(args.cik);
    if (!args.seriesName) return { cik, seriesId: null, classId: null, ticker: null, via: "cik" };
    const { rows } = await seriesClassTable();
    const want = args.seriesName.trim().toLowerCase();
    const seen = new Map<string, string>();
    for (const r of rows) if (r.cik === cik && r.seriesId && r.seriesName.toLowerCase().includes(want)) seen.set(r.seriesId, r.seriesName);
    const list = [...seen.entries()].map(([seriesId, seriesName]) => ({ seriesId, seriesName }));
    if (!list.length) return { cik, seriesId: null, classId: null, ticker: null, via: "cik (seriesName matched nothing)" };
    // Prefer an exact name match, else the shortest name containing the text.
    list.sort((a, b) => (a.seriesName.toLowerCase() === want ? -1 : b.seriesName.toLowerCase() === want ? 1 : a.seriesName.length - b.seriesName.length));
    return { cik, seriesId: list[0].seriesId, classId: null, ticker: null, via: "cik + seriesName (series-class CSV)", seriesName: list[0].seriesName, candidates: list.length > 1 ? list.slice(0, 10) : undefined };
  }
  return null;
}
