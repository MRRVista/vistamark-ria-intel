/**
 * Shared helpers for the international-macro family (World Bank, IMF, OECD, BIS):
 *   - tiny TTL cache (module-level, survives warm lambda invocations)
 *   - RFC-4180 CSV parser (quoted fields, embedded commas/newlines)
 *   - SDMX-CSV normalizer that handles the three label conventions seen live
 *     (2026-10): OECD "csvfilewithlabels" (code column followed by a label
 *     column), BIS/IMF "labels=both" ("CODE: Label" in header and cells)
 *   - ISO2 <-> ISO3 mapping for the economies callers ask about most
 *     (OECD/IMF/WB use ISO3, BIS uses ISO2), plus euro-area aliases.
 */
import { politeFetch, redactUrl } from "../data/http";

// ---------------------------------------------------------------- cache

const CACHE = new Map<string, { at: number; value: any }>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  CACHE.set(key, { at: Date.now(), value });
  if (CACHE.size > 300) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
    for (const [k] of oldest) CACHE.delete(k);
  }
  return value;
}

export const HOUR = 3600_000;

/** Fetch text; on non-2xx throw a redacted error with a short body excerpt. */
export async function textFetch(url: string, headers: Record<string, string> = {}, timeoutMs = 25000, retries = 2): Promise<string> {
  const res = await politeFetch(url, { headers, timeoutMs, retries });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body).replace(/\s+/g, " ").slice(0, 240)}`);
  }
  return body;
}

// ---------------------------------------------------------------- CSV

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.length > 1 || row[0] !== "") rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- SDMX CSV

export interface Cell { code: string; label?: string }
export type SdmxRow = Record<string, Cell>;

const ID_RE = /^[A-Z][A-Z0-9_]*$/;

/** Split "CODE: Label" when the left side looks like a code (not prose). */
function splitCodeLabel(v: string): Cell {
  const m = /^([A-Za-z0-9_.@\-]{1,40}):\s(.*)$/s.exec(v);
  return m ? { code: m[1], label: m[2].trim() } : { code: v };
}

/** Parse any SDMX-CSV variant (OECD csvfilewithlabels, BIS/IMF labels=both, plain). */
export function parseSdmxCsv(text: string): SdmxRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 1) return [];
  const header = rows[0];
  // Column plan: [{id, codeIdx, labelIdx?, inlineLabels}]
  const plan: Array<{ id: string; codeIdx: number; labelIdx?: number; inline: boolean }> = [];
  for (let i = 0; i < header.length; i++) {
    const h = header[i].trim();
    const inl = /^([A-Z][A-Z0-9_]*(?:\[;\])?)\s*:\s*(.+)$/.exec(h);
    if (inl) { plan.push({ id: inl[1].replace("[;]", ""), codeIdx: i, inline: true }); continue; }
    const id = h.replace("[;]", "");
    if (ID_RE.test(id)) {
      const next = header[i + 1]?.trim();
      if (next !== undefined && next !== "" && !ID_RE.test(next.replace("[;]", "")) && !/^[A-Z][A-Z0-9_]*\s*:/.test(next)) {
        plan.push({ id, codeIdx: i, labelIdx: i + 1, inline: false });
        i++;
      } else plan.push({ id, codeIdx: i, inline: false });
    }
  }
  const anyInline = plan.some((p) => p.inline);
  const out: SdmxRow[] = [];
  for (const r of rows.slice(1)) {
    const o: SdmxRow = {};
    for (const p of plan) {
      const raw = r[p.codeIdx] ?? "";
      if (p.labelIdx !== undefined) o[p.id] = { code: raw, label: r[p.labelIdx] || undefined };
      else if (anyInline && p.id !== "TIME_PERIOD" && p.id !== "OBS_VALUE") o[p.id] = splitCodeLabel(raw);
      else o[p.id] = { code: raw };
    }
    out.push(o);
  }
  return out;
}

/** Columns that are bookkeeping or vary per observation — never part of the series identity. */
const NON_SERIES = new Set([
  "STRUCTURE", "STRUCTURE_ID", "STRUCTURE_NAME", "ACTION", "DATAFLOW",
  "TIME_PERIOD", "OBS_VALUE", "OBS_STATUS", "OBS_CONF", "OBS_PRE_BREAK", "OBS_COM",
  "STATUS", "IFS_FLAG", "OVERLAP", "DERIVATION_TYPE", "TIME_FORMAT", "DECIMALS",
  "DECIMALS_DISPLAYED", "PRECISION", "COMPILATION", "SOURCE_REF", "SUPP_INFO_BREAKS",
  "BREAKS", "COVERAGE", "COLLECTION", "TITLE", "TITLE_TS", "TITLE_COMPL",
  "REPORTING_PERIOD_TYPE", "CONF_STATUS", "PRE_BREAK_VALUE", "COMMENT_OBS",
]);
const UNIT_COLS = ["UNIT_MEASURE", "UNIT", "TRANSFORMATION"];

export interface SeriesOut {
  key: string;
  dims: Record<string, string>;
  unit: string | null;
  unitMult: string | null;
  title?: string;
  latest: { period: string; value: number } | null;
  recent: Array<{ period: string; value: number }>;
  observationsReturned: number;
}

function fmtCell(c: Cell | undefined): string {
  if (!c) return "";
  return c.label && c.label !== c.code ? `${c.code} (${c.label})` : c.code;
}

/**
 * Group SDMX rows into series, sort by period, keep the last `recentN`.
 * Dimensions identical across all series are hoisted into `commonDims` so
 * output stays compact; each series only lists the dims that differ.
 */
export function groupSdmxSeries(rows: SdmxRow[], recentN: number): { commonDims: Record<string, string>; series: SeriesOut[] } {
  const groups = new Map<string, { row: SdmxRow; obs: Array<{ period: string; value: number }> }>();
  let seriesCols: string[] | null = null;
  for (const r of rows) {
    if (!seriesCols) seriesCols = Object.keys(r).filter((k) => !NON_SERIES.has(k) && k !== "UNIT_MULT");
    const v = Number(r.OBS_VALUE?.code);
    const p = r.TIME_PERIOD?.code;
    if (!p || r.OBS_VALUE?.code === "" || r.OBS_VALUE?.code === "NaN" || !Number.isFinite(v)) continue;
    const key = seriesCols.map((c) => r[c]?.code ?? "").join(".");
    let g = groups.get(key);
    if (!g) { g = { row: r, obs: [] }; groups.set(key, g); }
    g.obs.push({ period: p, value: v });
  }
  const cols = (seriesCols ?? []).filter((c) => !UNIT_COLS.includes(c) || c === "TRANSFORMATION");
  // Which dims vary across series?
  const all = [...groups.values()];
  const varying = new Set<string>();
  for (const c of cols) {
    const s = new Set(all.map((g) => g.row[c]?.code ?? ""));
    if (s.size > 1) varying.add(c);
  }
  const commonDims: Record<string, string> = {};
  if (all.length) for (const c of cols) if (!varying.has(c) && all[0].row[c]?.code && all[0].row[c].code !== "_Z") commonDims[c] = fmtCell(all[0].row[c]);
  const series: SeriesOut[] = [];
  for (const [key, g] of groups) {
    g.obs.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
    const dims: Record<string, string> = {};
    for (const c of varying) dims[c] = fmtCell(g.row[c]);
    const unitCell = g.row.UNIT_MEASURE ?? g.row.UNIT;
    const recent = g.obs.slice(-recentN).map((o) => ({ period: o.period, value: round(o.value) }));
    const title = g.row.TITLE_TS?.code || g.row.TITLE?.label || g.row.TITLE?.code || undefined;
    series.push({
      key,
      dims,
      unit: unitCell ? (unitCell.label ?? unitCell.code) : null,
      unitMult: g.row.UNIT_MULT ? g.row.UNIT_MULT.label ?? g.row.UNIT_MULT.code : null,
      ...(title ? { title: title.trim() } : {}),
      latest: recent.length ? recent[recent.length - 1] : null,
      recent: recent.slice().reverse(),
      observationsReturned: g.obs.length,
    });
  }
  return { commonDims, series };
}

export function round(v: number, dp = 4): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

export function clampInt(v: any, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------- countries

const ISO_PAIRS: Array<[string, string]> = [
  ["US", "USA"], ["GB", "GBR"], ["DE", "DEU"], ["FR", "FRA"], ["IT", "ITA"], ["ES", "ESP"], ["NL", "NLD"],
  ["BE", "BEL"], ["AT", "AUT"], ["PT", "PRT"], ["IE", "IRL"], ["FI", "FIN"], ["GR", "GRC"], ["LU", "LUX"],
  ["SE", "SWE"], ["NO", "NOR"], ["DK", "DNK"], ["CH", "CHE"], ["IS", "ISL"], ["PL", "POL"], ["CZ", "CZE"],
  ["HU", "HUN"], ["SK", "SVK"], ["SI", "SVN"], ["EE", "EST"], ["LV", "LVA"], ["LT", "LTU"], ["HR", "HRV"],
  ["RO", "ROU"], ["BG", "BGR"], ["RS", "SRB"], ["TR", "TUR"], ["RU", "RUS"], ["UA", "UKR"], ["IL", "ISR"],
  ["JP", "JPN"], ["CN", "CHN"], ["HK", "HKG"], ["KR", "KOR"], ["TW", "TWN"], ["SG", "SGP"], ["IN", "IND"],
  ["ID", "IDN"], ["MY", "MYS"], ["TH", "THA"], ["PH", "PHL"], ["VN", "VNM"], ["AU", "AUS"], ["NZ", "NZL"],
  ["CA", "CAN"], ["MX", "MEX"], ["BR", "BRA"], ["AR", "ARG"], ["CL", "CHL"], ["CO", "COL"], ["PE", "PER"],
  ["CR", "CRI"], ["ZA", "ZAF"], ["NG", "NGA"], ["EG", "EGY"], ["MA", "MAR"], ["KE", "KEN"], ["SA", "SAU"],
  ["AE", "ARE"], ["QA", "QAT"], ["KW", "KWT"], ["PK", "PAK"], ["BD", "BGD"], ["KZ", "KAZ"], ["MT", "MLT"],
  ["CY", "CYP"], ["MK", "MKD"], ["DZ", "DZA"],
];
const TO3 = new Map(ISO_PAIRS.map(([a, b]) => [a, b]));
const TO2 = new Map(ISO_PAIRS.map(([a, b]) => [b, a]));
const EURO_ALIASES = new Set(["EA", "EZ", "EMU", "EUROAREA", "EURO_AREA", "XM", "EA20", "EA19", "EUZ", "XC"]);

export type CodeStyle = "iso2" | "iso3";
/** Euro-area code per upstream. */
export const EURO_CODE = { worldbank: "EMU", oecd: "EA20", bis: "XM", imfDatamapper: "EURO", imfSdmx: "G163" } as const;

export function normCountries(input: any): string[] {
  const arr = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[,;+\s]+/) : [];
  return [...new Set(arr.map((s: any) => String(s).trim().toUpperCase()).filter(Boolean))] as string[];
}

/** Convert a caller-supplied code to the upstream's style; unknown codes pass through untouched. */
export function toStyle(code: string, style: CodeStyle, euro: string): string {
  const c = code.toUpperCase();
  if (EURO_ALIASES.has(c.replace(/\s+/g, ""))) return euro;
  if (style === "iso3") return c.length === 2 ? TO3.get(c) ?? c : c;
  return c.length === 3 ? TO2.get(c) ?? c : c;
}
