/**
 * Shared helpers for the Open Data Portals family: government-domain allowlist,
 * Socrata SODA/metadata/Discovery calls with readable upstream errors, and
 * small coercions. Reuses the SoQL escaping helpers from lib/local-wealth/socrata.ts.
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached } from "../research/common";
export { soqlStr, soqlLike, num, str, day, clampLimit, strList } from "../local-wealth/socrata";
export { cached };

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;

export const DISCOVERY_URL = "https://api.us.socrata.com/api/catalog/v1";

/**
 * Default Discovery-API domains for the Illinois / Chicagoland catalog search.
 * data.illinois.gov is a vanity CNAME: the Discovery index only knows it as
 * illinois-edp.data.socrata.com (verified 2026-10-22); both hosts serve SODA.
 * DuPage County has NO Socrata portal (data.dupageco.org does not resolve and
 * the Discovery API answers "Domain not found").
 */
export const DEFAULT_DOMAINS = [
  "data.cityofchicago.org",
  "illinois-edp.data.socrata.com",
  "datacatalog.cookcountyil.gov",
];

/** Friendly host → canonical SODA host (both work for /resource; only the canonical one is in Discovery). */
export const DOMAIN_ALIASES: Record<string, string> = {
  "data.illinois.gov": "illinois-edp.data.socrata.com",
  "data.sfgov.org": "data.sf.gov",
};

const EXACT_ALLOW = new Set([
  "datacatalog.cookcountyil.gov",
  "publicreporting.cftc.gov",
  "data.cms.gov",
  "data.ny.gov",
  "data.sfgov.org",
  "data.sf.gov",
  "data.cdc.gov",
  "data.illinois.gov",
  "illinois-edp.data.socrata.com",
]);

/** Normalize a user-supplied domain (strip scheme/path) and enforce the government allowlist. */
export function normalizeDomain(input: unknown): string {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) throw new Error("domain is required (e.g. 'data.cityofchicago.org', 'data.illinois.gov', 'datacatalog.cookcountyil.gov')");
  s = s.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  if (!/^[a-z0-9.-]+$/.test(s) || s.includes("..")) throw new Error(`domain '${s}' is not a valid hostname`);
  const ok =
    EXACT_ALLOW.has(s) ||
    s.endsWith(".cityofchicago.org") ||
    s.endsWith(".socrata.com") ||
    s.endsWith(".gov") ||
    s.endsWith(".us");
  if (!ok) throw new Error(`domain '${s}' is not an allowlisted government open-data host (allowed: *.gov, *.us, *.cityofchicago.org, *.socrata.com, publicreporting.cftc.gov, data.cms.gov, data.ny.gov, data.sf.gov, data.cdc.gov)`);
  return s;
}

/** Host to send SODA requests to (vanity hosts kept; they serve /resource fine). */
export function sodaHost(domain: string): string {
  return `https://${domain}`;
}

export function validDatasetId(input: unknown): string {
  const s = String(input ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(s)) throw new Error(`datasetId must be a Socrata 4x4 id like 'r5kz-chrr' (got '${s || "empty"}')`);
  return s;
}

function tokenHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", ...(extra ?? {}) };
  if (process.env.SOCRATA_APP_TOKEN) h["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
  return h;
}

/** Extract a readable message from a Socrata error body. */
function socrataError(status: number, url: string, body: string): Error {
  let msg = "";
  try {
    const j = JSON.parse(body);
    msg = j?.message ?? j?.error ?? j?.errors?.[0]?.message ?? "";
    if (typeof msg !== "string") msg = JSON.stringify(msg);
    // trim Socrata's echoed full SELECT list
    msg = msg.replace(/; position: Map\(.*$/s, "").replace(/\s+/g, " ").trim();
  } catch {
    msg = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const hint =
    status === 404 ? " (dataset id or domain not found)" :
    status === 400 ? " (check SoQL in select/where/order/group — use socrata_dataset_columns for field names)" :
    status === 403 ? " (private or token-required dataset)" :
    status === 429 ? " (rate-limited; set SOCRATA_APP_TOKEN for a higher ceiling)" : "";
  return new Error(`Socrata HTTP ${status}${hint} from ${redactUrl(url)}: ${msg.slice(0, 300)}`);
}

export async function getJson<T = any>(url: string, timeoutMs = 20000, headers?: Record<string, string>): Promise<T> {
  const res = await politeFetch(url, { headers: tokenHeaders(headers), timeoutMs, retries: 2 });
  if (!res.ok) throw socrataError(res.status, url, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export interface SoqlParams {
  select?: string;
  where?: string;
  order?: string;
  group?: string;
  limit?: number;
  offset?: number;
  q?: string;
}

/** Run a SoQL query against <domain>/resource/<id>.json. */
export async function sodaQuery<T = Record<string, unknown>>(domain: string, datasetId: string, p: SoqlParams, timeoutMs = 25000): Promise<T[]> {
  const qs = new URLSearchParams();
  const put = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    qs.set(k, String(v).trim());
  };
  put("$select", p.select);
  put("$where", p.where);
  put("$order", p.order);
  put("$group", p.group);
  put("$limit", p.limit);
  put("$offset", p.offset);
  put("$q", p.q);
  const url = `${sodaHost(domain)}/resource/${datasetId}.json?${qs}`;
  const rows = await getJson<T[]>(url, timeoutMs);
  if (!Array.isArray(rows)) throw new Error(`Unexpected Socrata response shape from ${domain}/${datasetId}`);
  return rows;
}

export interface ViewColumn {
  fieldName: string;
  name: string;
  dataType: string;
  description: string | null;
  cardinality?: number | null;
  nonNull?: number | null;
  top?: string[];
}

export interface ViewMeta {
  id: string;
  domain: string;
  name: string;
  description: string | null;
  category: string | null;
  attribution: string | null;
  rowsUpdatedAt: string | null;
  createdAt: string | null;
  frequency: string | null;
  timePeriod: string | null;
  downloads: number | null;
  columns: ViewColumn[];
}

const epochToIso = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
};

/** Dataset metadata via /api/views/<id>.json (cached 6h). */
export function viewMeta(domain: string, datasetId: string): Promise<ViewMeta> {
  return cached(`opendata:view:${domain}/${datasetId}`, 6 * HOUR, async () => {
    const url = `${sodaHost(domain)}/api/views/${datasetId}.json`;
    const v = await getJson<any>(url, 20000);
    const custom = v?.metadata?.custom_fields?.Metadata ?? {};
    const cols: ViewColumn[] = (v.columns ?? [])
      .filter((c: any) => c.fieldName && !String(c.fieldName).startsWith(":"))
      .map((c: any) => {
        const cc = c.cachedContents ?? {};
        const top = Array.isArray(cc.top)
          ? cc.top.slice(0, 3).map((t: any) => String(t.item?.url ?? t.item?.latitude ?? t.item ?? "")).filter((s: string) => s && s.length <= 60)
          : undefined;
        return {
          fieldName: c.fieldName,
          name: c.name,
          dataType: c.dataTypeName,
          description: trimText(c.description, 160),
          cardinality: cc.cardinality != null ? Number(cc.cardinality) : null,
          nonNull: cc.non_null != null ? Number(cc.non_null) : null,
          top: top && top.length ? top : undefined,
        };
      });
    return {
      id: v.id,
      domain,
      name: v.name,
      description: trimText(v.description, 400),
      category: v.category ?? null,
      attribution: v.attribution ?? null,
      rowsUpdatedAt: epochToIso(v.rowsUpdatedAt),
      createdAt: epochToIso(v.createdAt),
      frequency: custom["Frequency"] ?? null,
      timePeriod: custom["Time Period"] ?? null,
      downloads: v.downloadCount != null ? Number(v.downloadCount) : null,
      columns: cols,
    };
  });
}

/** Strip HTML, collapse whitespace, cut to n chars. */
export function trimText(v: unknown, n: number): string | null {
  if (v == null) return null;
  const s = String(v).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/** Keep only requested columns (case-insensitive) when `columns` is non-empty. */
export function pickColumns(rows: Record<string, unknown>[], columns: string[]): Record<string, unknown>[] {
  if (!columns.length) return rows;
  const want = new Set(columns.map((c) => c.toLowerCase()));
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (want.has(k.toLowerCase())) o[k] = v;
    return o;
  });
}

/** Flatten Socrata location/point objects and truncate long strings so rows stay compact. */
export function compactRow(r: Record<string, unknown>, maxStr = 240): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (v == null) continue;
    if (typeof v === "object") {
      const anyv = v as any;
      if (anyv.type === "Point" && Array.isArray(anyv.coordinates)) o[k] = { lon: anyv.coordinates[0], lat: anyv.coordinates[1] };
      else if (anyv.latitude != null && anyv.longitude != null) o[k] = { lat: Number(anyv.latitude), lon: Number(anyv.longitude) };
      else if (anyv.url) o[k] = anyv.url;
      else o[k] = JSON.stringify(v).slice(0, maxStr);
      continue;
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      o[k] = s.length > maxStr ? s.slice(0, maxStr - 1) + "…" : s;
      continue;
    }
    o[k] = v;
  }
  return o;
}

export function isoDay(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v).slice(0, 10);
}

/** Validate optional YYYY-MM-DD input. */
export function dateArg(v: unknown, label: string): string | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} must be YYYY-MM-DD (got '${s}')`);
  return s;
}

export function zipArg(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v).trim();
  if (!/^\d{5}$/.test(s)) throw new Error(`zip must be a 5-digit ZIP (got '${s}')`);
  return s;
}
