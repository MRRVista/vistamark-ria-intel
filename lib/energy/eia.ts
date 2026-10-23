/**
 * EIA Open Data API v2 — generic series fetch + route browser. KEYED.
 *
 * Request shape (per https://www.eia.gov/opendata/documentation.php, and the
 * error path verified live 2026-10-22 from this sandbox — a request with a
 * bad key returns HTTP 403 {"error":{"code":"API_KEY_INVALID",...}}):
 *
 *   GET https://api.eia.gov/v2/<route>                 -> route metadata (child routes, or
 *                                                        frequency/facets/data columns for a dataset)
 *   GET https://api.eia.gov/v2/<route>/facet/<facetId> -> facet values {id,name,alias}
 *   GET https://api.eia.gov/v2/<route>/data/?api_key=K&frequency=daily&data[0]=value
 *         &facets[series][]=RWTC&start=2025-01-01&end=2025-12-31
 *         &sort[0][column]=period&sort[0][direction]=desc&offset=0&length=60
 *
 * api_key MUST be a query parameter (headers are not read). JSON responses are
 * capped at 5,000 rows; values come back as strings (v2.1.6+). EIA throttles
 * per-second and per-hour without publishing the numbers; exceeding them
 * suspends the key temporarily. We cache 30 min (daily/weekly data) and keep
 * `length` <= 60 so a call is a single small request.
 *
 * Useful routes (ids as documented; not callable from this sandbox without a key):
 *   petroleum/pri/spt      spot prices  — facets[series]: RWTC (WTI Cushing), RBRTE (Brent),
 *                                         EER_EPMRU_PF4_Y35NY_DPG (NY Harbor gasoline) ...
 *   natural-gas/pri/fut    Henry Hub spot/futures — facets[series]: RNGWHHD (spot), RNGC1..RNGC4
 *   natural-gas/stor/wkly  weekly underground storage (Bcf) — facets[series]: NW2_EPG0_SWO_R48_BCF
 *   petroleum/stoc/wstk    weekly stocks (crude, gasoline, distillate) — facets[series]: WCESTUS1, WGTSTUS1
 *   petroleum/sum/sndw     weekly supply/demand (product supplied, refinery runs, imports)
 *   petroleum/crd/drill    monthly rotary rigs in operation (oil/gas), EIA's Baker Hughes-derived series
 *   electricity/retail-sales  monthly price/sales/revenue by stateid + sectorid
 *   electricity/rto/region-data  hourly demand by respondent (large; keep length small)
 *   total-energy           Monthly Energy Review series (facets[msn])
 *   steo                   Short-Term Energy Outlook forecasts (facets[seriesId])
 */
import { jsonFetch, redactUrl } from "../data/http";
import { cached, clampInt, round, toNum } from "../research/common";

const BASE = "https://api.eia.gov/v2";
const MIN = 60 * 1000;

export const EIA_KEY_HELP =
  "EIA_API_KEY not configured — register a free key at https://www.eia.gov/opendata/register.php and set EIA_API_KEY in the environment.";

function apiKey(): string {
  const k = process.env.EIA_API_KEY?.trim();
  if (!k) throw new Error(EIA_KEY_HELP);
  return k;
}

function cleanRoute(r: unknown): string {
  const s = String(r ?? "")
    .trim()
    .replace(/^https?:\/\/api\.eia\.gov\/v2\/?/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/data$/i, "");
  if (!s) throw new Error("route is required, e.g. 'petroleum/pri/spt' or 'electricity/retail-sales'");
  if (!/^[A-Za-z0-9_\-\/.]+$/.test(s)) throw new Error(`route '${s}' contains unsupported characters`);
  return s;
}

interface EiaEnvelope<T> {
  response?: T;
  request?: unknown;
  error?: { code?: string; message?: string } | string;
  apiVersion?: string;
}

async function eiaGet<T>(path: string, params: URLSearchParams, ttlMs: number): Promise<T> {
  const key = apiKey();
  const cacheKey = `eia:${path}?${params.toString()}`;
  return cached(cacheKey, ttlMs, async () => {
    const qs = new URLSearchParams(params);
    qs.set("api_key", key);
    const url = `${BASE}/${path}?${qs.toString()}`;
    let body: EiaEnvelope<T>;
    try {
      body = await jsonFetch<EiaEnvelope<T>>(url, { timeoutMs: 25000, retries: 1 });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/API_KEY_INVALID/.test(msg)) throw new Error("EIA rejected the API key (API_KEY_INVALID). Check EIA_API_KEY.");
      if (/HTTP 403/.test(msg)) throw new Error(`EIA HTTP 403 for /${path} — invalid key or throttled: ${redactUrl(msg).slice(0, 200)}`);
      throw new Error(`EIA request failed for /${path}: ${redactUrl(msg).slice(0, 300)}`);
    }
    if (body?.error) {
      const err = typeof body.error === "string" ? body.error : `${body.error.code ?? ""} ${body.error.message ?? ""}`.trim();
      throw new Error(`EIA error for /${path}: ${err}`);
    }
    if (!body?.response) throw new Error(`EIA returned no 'response' object for /${path}`);
    return body.response;
  });
}

// ---------------------------------------------------------------------------
// eia_series
// ---------------------------------------------------------------------------

export interface EiaSeriesArgs {
  route: string;
  facets?: Record<string, string | string[]>;
  frequency?: string;
  data?: string[];
  start?: string;
  end?: string;
  length?: number;
  offset?: number;
  sort?: "asc" | "desc";
  groupBy?: string;
}

interface EiaDataResponse {
  total?: number | string;
  dateFormat?: string;
  frequency?: string;
  description?: string;
  warning?: string;
  data?: Array<Record<string, unknown>>;
}

const FACET_NAME_SUFFIXES = ["Description", "Name", "-name", "name"];

/** Build a readable label for one row's facet combination (e.g. "RWTC · Cushing, OK WTI Spot Price FOB"). */
function seriesKeyOf(row: Record<string, unknown>, facetIds: string[], dataCols: string[]): { key: string; label: string } {
  const idParts: string[] = [];
  const nameParts: string[] = [];
  for (const f of facetIds) {
    const v = row[f];
    if (v == null || v === "") continue;
    idParts.push(String(v));
    for (const suf of FACET_NAME_SUFFIXES) {
      const n = row[`${f}${suf}`];
      if (n != null && n !== "" && String(n) !== String(v)) {
        nameParts.push(String(n));
        break;
      }
    }
  }
  if (!idParts.length) {
    // fall back on any *Description / *Name column
    for (const [k, v] of Object.entries(row)) {
      if (/(Description|Name)$/.test(k) && v) nameParts.push(String(v));
    }
  }
  const key = idParts.join("|") || dataCols.join("|") || "series";
  const label = nameParts.length ? `${idParts.join(" / ")} · ${nameParts.join(" / ")}` : idParts.join(" / ") || key;
  return { key, label };
}

export async function eiaSeries(args: EiaSeriesArgs) {
  const route = cleanRoute(args.route);
  apiKey(); // fail fast before any work
  const length = clampInt(args.length, 24, 1, 60);
  const offset = clampInt(args.offset, 0, 0, 1_000_000);
  const dataCols = (args.data?.length ? args.data : ["value"]).map((d) => String(d).trim()).filter(Boolean);
  const sortDir = args.sort === "asc" ? "asc" : "desc";

  const p = new URLSearchParams();
  dataCols.forEach((c, i) => p.append(`data[${i}]`, c));
  if (args.frequency) p.set("frequency", String(args.frequency).trim());
  if (args.start) p.set("start", String(args.start).trim());
  if (args.end) p.set("end", String(args.end).trim());
  const facetIds: string[] = [];
  if (args.facets && typeof args.facets === "object") {
    for (const [fid, vals] of Object.entries(args.facets)) {
      const list = Array.isArray(vals) ? vals : String(vals).split(",");
      const clean = list.map((v) => String(v).trim()).filter(Boolean);
      if (!clean.length) continue;
      facetIds.push(fid);
      for (const v of clean) p.append(`facets[${fid}][]`, v);
    }
  }
  p.set("sort[0][column]", "period");
  p.set("sort[0][direction]", sortDir);
  p.set("offset", String(offset));
  p.set("length", String(length));

  const resp = await eiaGet<EiaDataResponse>(`${route}/data/`, p, 30 * MIN);
  const rows = Array.isArray(resp.data) ? resp.data : [];
  if (!rows.length) {
    throw new Error(
      `EIA /${route} returned 0 rows (total=${resp.total ?? "?"}). Check facets/frequency with eia_browse (route='${route}') — e.g. facets[series] ids and a frequency this dataset supports.${resp.warning ? " Warning: " + resp.warning : ""}`
    );
  }

  // Discover facet ids from the response if the caller gave none (every non-period, non-data, non-*units column that has a companion name col).
  const sample = rows[0]!;
  const unitsCols = Object.keys(sample).filter((k) => k.endsWith("-units"));
  const valueCols = dataCols.filter((c) => c in sample);
  const effectiveValueCols = valueCols.length ? valueCols : Object.keys(sample).filter((k) => !["period"].includes(k) && !k.endsWith("-units") && toNum(sample[k]) != null && !/id$/i.test(k));
  const primary = effectiveValueCols[0] ?? "value";
  const inferredFacets = facetIds.length
    ? facetIds
    : Object.keys(sample).filter((k) => k !== "period" && !effectiveValueCols.includes(k) && !k.endsWith("-units") && !/(Description|Name|name)$/.test(k));
  const groupKey = args.groupBy && args.groupBy in sample ? [args.groupBy] : inferredFacets;

  // Group rows by series, sort ascending by period, compute window stats on the primary column.
  const groups = new Map<string, { label: string; rows: Array<{ period: string; values: Record<string, number | null> }> }>();
  for (const r of rows) {
    const { key, label } = seriesKeyOf(r, groupKey, effectiveValueCols);
    const g = groups.get(key) ?? { label, rows: [] };
    const values: Record<string, number | null> = {};
    for (const c of effectiveValueCols) values[c] = toNum(r[c]);
    g.rows.push({ period: String(r.period ?? ""), values });
    groups.set(key, g);
  }
  const units: Record<string, string> = {};
  for (const uc of unitsCols) units[uc.replace(/-units$/, "")] = String(sample[uc]);

  const series = Array.from(groups.entries())
    .slice(0, 12)
    .map(([key, g]) => {
      const asc = g.rows.slice().sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
      const vals = asc.map((x) => x.values[primary]).filter((v): v is number => v != null);
      const latest = asc[asc.length - 1];
      const prev = asc.length > 1 ? asc[asc.length - 2] : undefined;
      const lv = latest?.values[primary] ?? null;
      const pv = prev?.values[primary] ?? null;
      const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      const first = vals.length ? vals[0]! : null;
      return {
        key,
        label: g.label,
        latest: latest ? { period: latest.period, ...(effectiveValueCols.length > 1 ? latest.values : { [primary]: lv }) } : null,
        window: {
          observations: asc.length,
          from: asc[0]?.period ?? null,
          to: latest?.period ?? null,
          change: lv != null && pv != null ? round(lv - pv, 4) : null,
          pctChange: lv != null && pv != null && pv !== 0 ? round(((lv - pv) / Math.abs(pv)) * 100, 2) : null,
          changeOverWindow: lv != null && first != null ? round(lv - first, 4) : null,
          pctChangeOverWindow: lv != null && first != null && first !== 0 ? round(((lv - first) / Math.abs(first)) * 100, 2) : null,
          min: vals.length ? round(Math.min(...vals), 4) : null,
          max: vals.length ? round(Math.max(...vals), 4) : null,
          mean: round(mean, 4),
        },
        observations: (sortDir === "desc" ? asc.slice().reverse() : asc).map((x) =>
          effectiveValueCols.length > 1 ? { period: x.period, ...x.values } : { period: x.period, value: x.values[primary] }
        ),
      };
    });

  return {
    source: "U.S. Energy Information Administration — Open Data API v2 (api.eia.gov)",
    fetchedAt: new Date().toISOString(),
    route,
    frequency: resp.frequency ?? args.frequency ?? null,
    dateFormat: resp.dateFormat ?? null,
    units,
    totalAvailable: toNum(resp.total),
    returned: rows.length,
    offset,
    seriesCount: groups.size,
    series,
    warning: resp.warning ?? undefined,
    note:
      "Values are in the dataset's native units (see `units`). `window` stats cover only the rows returned (length ≤ 60, sorted by period); page with `offset` or narrow with start/end for longer history. EIA publishes most daily spot prices with a 1-business-day lag and weekly petroleum/natural-gas data on Wednesday/Thursday. For daily WTI (DCOILWTICO), Brent (DCOILBRENTEU) and Henry Hub (DHHNGSP) spot, fred_get_series is keyless and equivalent; use eia_series for EIA-only data (inventories, storage, production, retail electricity prices, STEO forecasts).",
  };
}

// ---------------------------------------------------------------------------
// eia_browse
// ---------------------------------------------------------------------------

export interface EiaBrowseArgs {
  route?: string;
  facet?: string;
  search?: string;
  limit?: number;
}

interface EiaRouteResponse {
  id?: string;
  name?: string;
  description?: string;
  routes?: Array<{ id?: string; name?: string; description?: string }>;
  frequency?: Array<{ id?: string; description?: string; query?: string; format?: string }>;
  facets?: Array<{ id?: string; description?: string }>;
  data?: Record<string, { alias?: string; units?: string }>;
  startPeriod?: string;
  endPeriod?: string;
  defaultDateFormat?: string;
  defaultFrequency?: string;
}

interface EiaFacetResponse {
  totalFacets?: number | string;
  facets?: Array<{ id?: string; name?: string; alias?: string }>;
}

export async function eiaBrowse(args: EiaBrowseArgs) {
  apiKey();
  const route = args.route ? cleanRoute(args.route) : "";
  const limit = clampInt(args.limit, 40, 1, 200);
  const q = args.search ? String(args.search).toLowerCase().split(/\s+/).filter(Boolean) : [];
  const matches = (s: string) => !q.length || q.every((w) => s.toLowerCase().includes(w));

  if (args.facet) {
    const facet = String(args.facet).trim();
    const resp = await eiaGet<EiaFacetResponse>(`${route}/facet/${encodeURIComponent(facet)}`, new URLSearchParams(), 24 * 60 * MIN);
    const all = Array.isArray(resp.facets) ? resp.facets : [];
    const filtered = all.filter((f) => matches(`${f.id ?? ""} ${f.name ?? ""} ${f.alias ?? ""}`));
    return {
      source: "EIA Open Data API v2 (api.eia.gov)",
      fetchedAt: new Date().toISOString(),
      route,
      facet,
      totalValues: toNum(resp.totalFacets) ?? all.length,
      matched: filtered.length,
      values: filtered.slice(0, limit).map((f) => ({ id: f.id, name: f.name, ...(f.alias && f.alias !== f.name ? { alias: f.alias } : {}) })),
      note: `Pass one of these ids as facets.${facet} to eia_series (route '${route}'). Use search to narrow long lists (e.g. 'WTI', 'Henry Hub', 'Illinois').`,
    };
  }

  const resp = await eiaGet<EiaRouteResponse>(route || "", new URLSearchParams(), 24 * 60 * MIN);
  if (Array.isArray(resp.routes) && resp.routes.length) {
    const kids = resp.routes.filter((r) => matches(`${r.id ?? ""} ${r.name ?? ""} ${r.description ?? ""}`));
    return {
      source: "EIA Open Data API v2 (api.eia.gov)",
      fetchedAt: new Date().toISOString(),
      route: route || "(root)",
      name: resp.name ?? null,
      description: resp.description ?? null,
      childRoutes: kids.slice(0, limit).map((r) => ({ id: r.id, name: r.name, description: r.description })),
      childRouteCount: resp.routes.length,
      note: "Append a child id to the route and browse again until the response shows `frequencies`/`facets`/`dataColumns` (a dataset). Then call eia_series with that route.",
    };
  }
  return {
    source: "EIA Open Data API v2 (api.eia.gov)",
    fetchedAt: new Date().toISOString(),
    route,
    name: resp.name ?? null,
    description: resp.description ?? null,
    isDataset: true,
    frequencies: (resp.frequency ?? []).map((f) => ({ id: f.id, description: f.description, format: f.format })),
    defaultFrequency: resp.defaultFrequency ?? null,
    facets: (resp.facets ?? []).map((f) => ({ id: f.id, description: f.description })),
    dataColumns: Object.entries(resp.data ?? {}).map(([id, d]) => ({ id, alias: d?.alias, units: d?.units })),
    startPeriod: resp.startPeriod ?? null,
    endPeriod: resp.endPeriod ?? null,
    dateFormat: resp.defaultDateFormat ?? null,
    note: "To list a facet's allowed values call eia_browse again with `facet` (e.g. facet='series', search='WTI'). Then eia_series with route, frequency, facets {series:[...]}, data (column ids above; default 'value').",
  };
}
