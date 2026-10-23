/**
 * Shared helpers for the Physicians & Health Economy family.
 *
 *  - dkanQuery(): builds the bracketed query-string form that the DKAN 2
 *    datastore API (openpaymentsdata.cms.gov and data.cms.gov/provider-data)
 *    accepts on GET: conditions[i][property|value|operator], properties[],
 *    groupings[], sorts[], expression aggregates.
 *  - fetchJson(): jsonFetch with the family's default timeout/retry budget.
 */
import { jsonFetch } from "../data/http";

export { cached, HOUR, round, clampInt, toNum } from "../research/common";

export const DAY = 24 * 60 * 60 * 1000;

export async function fetchJson<T = any>(url: string, timeoutMs = 25000, retries = 1): Promise<T> {
  return jsonFetch<T>(url, { timeoutMs, retries, headers: { Accept: "application/json" } });
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function nz(v: unknown): string | undefined {
  const s = str(v);
  return s ?? undefined;
}

/** Title-case an ALL-CAPS name ("KOLIOPOULOS" -> "Koliopoulos"); leaves mixed case alone. */
export function titleCase(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/(^|[\s\-'/(])([a-z])/g, (_m, p, c) => p + c.toUpperCase())
    .replace(/\b(Llc|Pc|Sc|Ltd|Md|Do|Dds|Dmd|Pa|Np|Rn)\b/g, (m) => m.toUpperCase());
}

export function assertZip5(v: unknown, arg = "zip"): string {
  const s = String(v ?? "").trim();
  if (!/^\d{5}$/.test(s)) throw new Error(`${arg} must be a 5-digit ZIP code (got "${s}")`);
  return s;
}

export function assertNpi(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!/^\d{10}$/.test(s)) throw new Error(`npi must be a 10-digit National Provider Identifier (got "${s}")`);
  return s;
}

export function assertState(v: unknown): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw new Error(`state must be a 2-letter postal abbreviation (got "${s}")`);
  return s;
}

/* ---------------- DKAN datastore query builder ---------------- */

export type DkanOp = "=" | "<>" | "<" | ">" | "<=" | ">=" | "like" | "in";

export interface DkanCondition {
  property: string;
  value: string | number | Array<string | number>;
  operator?: DkanOp;
}

export interface DkanAggregate {
  op: "sum" | "count" | "avg" | "min" | "max";
  property: string;
  alias: string;
}

export interface DkanQuery {
  limit?: number;
  offset?: number;
  /** plain columns to return */
  properties?: string[];
  /** aggregate expressions (switches the query into GROUP BY mode together with `groupBy`) */
  aggregates?: DkanAggregate[];
  groupBy?: string[];
  conditions?: DkanCondition[];
  sorts?: Array<{ property: string; order?: "asc" | "desc" }>;
  /** ask the server for the total matching-row count (extra COUNT(*) query upstream; slow on big tables) */
  count?: boolean;
}

/**
 * Serialize a DkanQuery into the GET query string understood by
 * /api/1/datastore/query/{dataset}/{index}. When aggregates are present every
 * property/condition/grouping is written in the {resource:"t",property} form
 * the expression grammar requires.
 */
export function dkanQuery(q: DkanQuery): string {
  const p = new URLSearchParams();
  const agg = !!(q.aggregates && q.aggregates.length);
  p.set("limit", String(q.limit ?? 25));
  if (q.offset) p.set("offset", String(q.offset));
  p.set("schema", "false");
  p.set("keys", "true");
  p.set("count", q.count ? "true" : "false");
  let pi = 0;
  for (const col of q.properties ?? []) {
    if (agg) {
      p.set(`properties[${pi}][resource]`, "t");
      p.set(`properties[${pi}][property]`, col);
    } else {
      p.append("properties[]", col);
    }
    pi++;
  }
  for (const a of q.aggregates ?? []) {
    p.set(`properties[${pi}][expression][operator]`, a.op);
    p.set(`properties[${pi}][expression][operands][0][resource]`, "t");
    p.set(`properties[${pi}][expression][operands][0][property]`, a.property);
    p.set(`properties[${pi}][alias]`, a.alias);
    pi++;
  }
  (q.groupBy ?? []).forEach((g, i) => {
    p.set(`groupings[${i}][resource]`, "t");
    p.set(`groupings[${i}][property]`, g);
  });
  (q.conditions ?? []).forEach((c, i) => {
    if (agg) p.set(`conditions[${i}][resource]`, "t");
    p.set(`conditions[${i}][property]`, c.property);
    if (Array.isArray(c.value)) c.value.forEach((v, j) => p.set(`conditions[${i}][value][${j}]`, String(v)));
    else p.set(`conditions[${i}][value]`, String(c.value));
    p.set(`conditions[${i}][operator]`, c.operator ?? "=");
  });
  (q.sorts ?? []).forEach((s, i) => {
    p.set(`sorts[${i}][property]`, s.property);
    p.set(`sorts[${i}][order]`, s.order ?? "asc");
  });
  return p.toString();
}

export interface DkanResponse<T = Record<string, string>> {
  results: T[];
  count?: number;
}

export async function dkanFetch<T = Record<string, string>>(base: string, q: DkanQuery, timeoutMs = 25000): Promise<DkanResponse<T>> {
  const url = `${base}?${dkanQuery(q)}`;
  const res = await fetchJson<any>(url, timeoutMs, 1);
  if (res && typeof res === "object" && "message" in res && !("results" in res)) {
    throw new Error(`DKAN datastore error: ${String(res.message).slice(0, 200)}`);
  }
  return { results: Array.isArray(res?.results) ? res.results : [], count: num(res?.count) ?? undefined };
}

/** Escape % and _ for a LIKE pattern, then wrap with wildcards as requested. */
export function likePattern(v: string, mode: "contains" | "prefix" | "exact" = "contains"): string {
  const esc = v.replace(/[%_]/g, (m) => `\\${m}`).toUpperCase();
  if (mode === "exact") return esc;
  if (mode === "prefix") return `${esc}%`;
  return `%${esc}%`;
}
