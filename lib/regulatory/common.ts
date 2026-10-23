/**
 * Shared helpers for the regulatory-records family (BrokerCheck / IAPD / SEC
 * enforcement). Thin layer over politeFetch with the quirks of FINRA's search
 * engine handled in one place:
 *
 *  - Both api.brokercheck.finra.org and api.adviserinfo.sec.gov are the same
 *    Elasticsearch-backed engine. They answer HTTP 200 even on failure, with
 *    `{errorCode:-1, errorMessage:"Exceeded limit"|"Search unavailable, please
 *    try again later"|"query can't be empty", hits:null}` — so status-code
 *    retries never fire and we back off on the body instead (2 attempts).
 *    "Exceeded limit" is misleading: it is what BrokerCheck says when `state`
 *    is sent without `r`, not a quota message.
 *  - Detail payloads are a JSON *string* inside `_source.content` (BrokerCheck)
 *    or `_source.iacontent` (IAPD) and must be parsed a second time.
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, HOUR } from "../research/common";

export { cached, HOUR };
export { clampInt, round } from "../research/common";

export const BC_HOST = "https://api.brokercheck.finra.org";
export const IAPD_HOST = "https://api.adviserinfo.sec.gov";

export interface EngineHit {
  _type?: string;
  _source: Record<string, any>;
  highlight?: Record<string, string[]>;
}
export interface EngineResponse {
  errorCode?: number;
  errorMessage?: string;
  hits: { total: number; hits: EngineHit[] } | null;
}

const RETRY_SLEEP_MS = [1500, 3500];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET a FINRA-engine URL and return the parsed envelope, retrying twice on the
 * engine's soft "Exceeded limit" / "Search unavailable" responses.
 */
export async function engineGet(url: string, label: string): Promise<EngineResponse> {
  let last: EngineResponse | null = null;
  for (let attempt = 0; attempt <= RETRY_SLEEP_MS.length; attempt++) {
    const res = await politeFetch(url, {
      timeoutMs: 15000,
      retries: 1,
      headers: { Accept: "application/json", Referer: "https://brokercheck.finra.org/" },
    });
    if (res.status === 404) throw new Error(`${label}: not found (HTTP 404) — check the CRD number`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${label}: HTTP ${res.status} from ${redactUrl(url)}: ${redactUrl(body).slice(0, 160)}`);
    }
    const data = (await res.json()) as EngineResponse;
    if (data && data.hits) return data;
    last = data;
    const msg = String(data?.errorMessage ?? "");
    if (/can't be empty|cannot be empty/i.test(msg)) {
      throw new Error(`${label}: the engine requires a non-empty query — pass 'query' (name) or 'firm' (CRD)`);
    }
    if (attempt < RETRY_SLEEP_MS.length && /exceeded limit|unavailable/i.test(msg)) {
      await sleep(RETRY_SLEEP_MS[attempt]!);
      continue;
    }
    break;
  }
  throw new Error(
    `${label}: upstream answered "${last?.errorMessage ?? "no hits object"}" after retries — ` +
      `FINRA's engine returns this for unsupported parameter combinations or transient overload; simplify the filters and retry`
  );
}

/** Parse the double-encoded detail document out of a hit (`content` or `iacontent`). */
export function parseDetail(hit: EngineHit | undefined, label: string): Record<string, any> {
  if (!hit) throw new Error(`${label}: no record returned — the CRD may not exist or is not public`);
  const raw = hit._source?.content ?? hit._source?.iacontent;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${label}: detail payload was not valid JSON`);
    }
  }
  if (raw && typeof raw === "object") return raw;
  return hit._source ?? {};
}

/** Parse a stringified address blob (`firm_address_details`) or pass through an object. */
export function parseMaybeJson(v: unknown): any {
  if (typeof v !== "string") return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function compactAddress(a: any): string | null {
  if (!a || typeof a !== "object") return null;
  const parts = [a.street1, a.street2, a.city, a.state, a.postalCode ?? a.zipCode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** "M/D/YYYY" | "YYYY-MM-DD" | "YYYY-MM-DDTHH:.." -> YYYY-MM-DD */
export function isoDate(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s || null;
}

/** Years from a start date to today, 1 dp. */
export function yearsSince(date: string | null): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return null;
  return Math.round(((Date.now() - t) / (365.25 * 86400 * 1000)) * 10) / 10;
}

export function trunc(s: unknown, n = 220): string | null {
  if (s == null) return null;
  const t = Array.isArray(s) ? s.join(" ") : String(s);
  const clean = t.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

export function yn(v: unknown): boolean | null {
  if (v === "Y" || v === true) return true;
  if (v === "N" || v === false) return false;
  return null;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}
