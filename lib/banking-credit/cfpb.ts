/**
 * CFPB Consumer Complaint Database (CCDB) API — keyless, live, CC0.
 *
 *   Base: https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/
 *   (trailing slash REQUIRED — without it the HTML app shell is returned)
 *   GET /?company=<exact name>&product=&issue=&state=IL&zip_code=60521&date_received_min=YYYY-MM-DD
 *       &search_term=&size=25&frm=0&sort=created_date_desc&no_aggs=true|false
 *     -> Elasticsearch-style {hits:{total:{value},hits:[{_source:{...}}]},aggregations:{product,issue,
 *        company,state,company_response,timely,submitted_via,tags,company_public_response},_meta}
 *   GET /_suggest_company/?text=schwab&size=10 -> ["CHARLES SCHWAB CORPORATION, THE", ...]
 *   GET /<complaint_id>
 *
 * Verified live 2026-10-22: ~18.6 M complaints, refreshed daily (_meta.last_updated).
 * `company` must be the exact CCDB company string (use the suggest endpoint — we do this
 * automatically when the name does not match). `format=json` returns 404 — omit it.
 * `has_narrative=true` filters but the public API does NOT return complaint_what_happened
 * text (the field is absent from _source and is not a valid `field` value), so narratives
 * are not available programmatically; we surface issue/sub_issue instead.
 * The documented /trends endpoint is not deployed (returns the app shell), so monthly trends
 * are built from parallel size=0 count queries per period (fast: ~0.5 s each, run 6 at a time).
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, HOUR, round, clampInt } from "../research/common";

const BASE = "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/";
const SOURCE = "CFPB Consumer Complaint Database API (consumerfinance.gov, live, keyless)";

async function ccdbGet<T>(path: string, params: URLSearchParams, timeoutMs = 20000): Promise<T> {
  const url = `${BASE}${path}${params.toString() ? "?" + params.toString() : ""}`;
  const res = await politeFetch(url, { timeoutMs, retries: 2, headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`CFPB complaints HTTP ${res.status} from ${redactUrl(url)}: ${text.slice(0, 160)}`);
  if (text.startsWith("<")) throw new Error(`CFPB complaints returned HTML instead of JSON for ${redactUrl(url)} (endpoint not available)`);
  return JSON.parse(text) as T;
}

function iso(d: Date): string { return d.toISOString().slice(0, 10); }

function normDateArg(v: unknown, def: string | null): string | null {
  if (v == null || v === "") return def;
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`date "${s}" must be YYYY, YYYY-MM or YYYY-MM-DD`);
}

function multi(p: URLSearchParams, key: string, v: unknown) {
  if (v == null || v === "") return;
  const arr = Array.isArray(v) ? v : String(v).split("|");
  for (const x of arr) if (String(x).trim()) p.append(key, String(x).trim());
}

export async function suggestCompanies(text: string, size = 10): Promise<string[]> {
  return cached(`cfpb:suggest:${text.toLowerCase()}:${size}`, 24 * HOUR, async () => {
    const p = new URLSearchParams({ text, size: String(size) });
    const r = await ccdbGet<unknown>("_suggest_company/", p, 15000);
    return Array.isArray(r) ? r.map(String) : [];
  });
}

/** Resolve free-text company names to exact CCDB company strings. */
export async function resolveCompanies(names: string[], perName = 3): Promise<{ resolved: string[]; map: Record<string, string[]> }> {
  const map: Record<string, string[]> = {};
  const resolved: string[] = [];
  for (const n of names) {
    // _suggest_company is a prefix/phrase matcher: try the full text, then progressively
    // shorter leading-word prefixes ("Fidelity Brokerage Services" -> "Fidelity Brokerage" -> "Fidelity").
    const words = n.split(/\s+/).filter(Boolean);
    let s: string[] = [];
    for (let k = words.length; k >= 1 && !s.length; k--) s = await suggestCompanies(words.slice(0, k).join(" "), 10);
    const lower = n.toLowerCase();
    const exact = s.find((x) => x.toLowerCase() === lower);
    const containsAll = s.filter((x) => words.every((w) => x.toLowerCase().includes(w.toLowerCase())));
    // Never fall back to unrelated prefix matches (e.g. "Fidelity Brokerage" must not become FNIS).
    const picks = exact ? [exact] : containsAll.slice(0, perName);
    map[n] = picks;
    resolved.push(...picks);
  }
  return { resolved: Array.from(new Set(resolved)), map };
}

function buckets(aggs: any, key: string): Array<{ key: string; count: number }> {
  const node = aggs?.[key]?.[key]?.buckets ?? aggs?.[key]?.buckets ?? [];
  return node.map((b: any) => ({ key: String(b.key), count: Number(b.doc_count) || 0 }));
}

function subBuckets(aggs: any, key: string, subKey: string, topN = 6): Array<{ key: string; count: number; top: Array<{ key: string; count: number }> }> {
  const node = aggs?.[key]?.[key]?.buckets ?? [];
  return node.map((b: any) => ({
    key: String(b.key),
    count: Number(b.doc_count) || 0,
    top: (b?.[subKey]?.buckets ?? []).slice(0, topN).map((s: any) => ({ key: String(s.key), count: Number(s.doc_count) || 0 })),
  }));
}

/* ------------------------------------------------------------------ */
/* cfpb_complaints                                                      */
/* ------------------------------------------------------------------ */

export interface ComplaintsArgs {
  company?: unknown;
  search_term?: string;
  product?: unknown;
  issue?: unknown;
  state?: unknown;
  zip_code?: unknown;
  date_received_min?: unknown;
  date_received_max?: unknown;
  company_response?: unknown;
  timely?: "Yes" | "No";
  limit?: number;
  include_recent?: boolean;
  exact_company?: boolean;
}

export async function cfpbComplaints(args: ComplaintsArgs) {
  const limit = clampInt(args.limit, 10, 0, 25);
  const names = args.company == null || args.company === "" ? [] : Array.isArray(args.company) ? args.company.map(String) : String(args.company).split("|").map((s) => s.trim()).filter(Boolean);
  let companies = names;
  let companyResolution: Record<string, string[]> | null = null;
  if (names.length && !args.exact_company) {
    const r = await resolveCompanies(names, 3);
    companies = r.resolved;
    companyResolution = r.map;
    if (!companies.length) {
      return {
        source: SOURCE,
        fetchedAt: new Date().toISOString(),
        request: { company: names },
        total: 0,
        companyResolution: r.map,
        note: `No CCDB company matched "${names.join(", ")}". Companies only appear once they have ≥1 complaint; try a parent name (e.g. 'Charles Schwab' -> 'CHARLES SCHWAB CORPORATION, THE'), or omit company and use search_term.`,
      };
    }
  }

  const since = normDateArg(args.date_received_min, iso(new Date(Date.now() - 365 * 86400000)));
  const until = normDateArg(args.date_received_max, null);
  const p = new URLSearchParams();
  for (const c of companies) p.append("company", c);
  if (args.search_term) p.set("search_term", String(args.search_term));
  multi(p, "product", args.product);
  multi(p, "issue", args.issue);
  multi(p, "state", Array.isArray(args.state) ? args.state.map((s) => String(s).toUpperCase()) : args.state ? String(args.state).toUpperCase() : null);
  multi(p, "zip_code", args.zip_code);
  multi(p, "company_response", args.company_response);
  if (args.timely) p.set("timely", args.timely);
  if (since) p.set("date_received_min", since);
  if (until) p.set("date_received_max", until);
  p.set("size", String(args.include_recent === false ? 0 : limit));
  p.set("sort", "created_date_desc");
  p.set("no_aggs", "false");
  p.set("no_highlight", "true");
  if (!companies.length && !args.search_term && !args.product && !args.issue && !args.state && !args.zip_code) {
    throw new Error("Provide at least one of company, search_term, product, issue, state or zip_code.");
  }

  const r = await ccdbGet<any>("", p, 25000);
  const total = Number(r?.hits?.total?.value) || 0;
  const aggs = r?.aggregations ?? {};
  // CCDB computes each facet's buckets EXCLUDING that facet's own filter (UI post-filter
  // semantics), so restrict a facet to the applied values to keep counts consistent with `total`.
  const keep = (key: string, vals: string[]) => (rows: Array<{ key: string }>) =>
    vals.length ? rows.filter((b) => vals.some((v) => b.key.toLowerCase() === v.toLowerCase())) : rows;
  const keepProduct = keep("product", p.getAll("product"));
  const keepIssue = keep("issue", p.getAll("issue"));
  const keepState = keep("state", p.getAll("state"));
  const keepCompany = keep("company", p.getAll("company"));
  const keepResp = keep("company_response", p.getAll("company_response"));
  const companyB = keepCompany(buckets(aggs, "company")) as Array<{ key: string; count: number }>;
  const respB = keepResp(buckets(aggs, "company_response")) as Array<{ key: string; count: number }>;
  const timelyB = buckets(aggs, "timely");
  const reliefCount = respB.filter((b) => /monetary relief/i.test(b.key)).reduce((s, b) => s + b.count, 0);
  const anyReliefCount = respB.filter((b) => /relief/i.test(b.key)).reduce((s, b) => s + b.count, 0);
  const untimely = timelyB.find((b) => b.key === "No")?.count ?? 0;

  const recent = (r?.hits?.hits ?? []).slice(0, limit).map((h: any) => {
    const s = h._source ?? {};
    return {
      id: s.complaint_id,
      received: String(s.date_received ?? "").slice(0, 10),
      company: s.company,
      product: s.product,
      subProduct: s.sub_product,
      issue: s.issue,
      subIssue: s.sub_issue,
      state: s.state,
      zip: s.zip_code,
      via: s.submitted_via,
      response: s.company_response,
      timely: s.timely,
      tags: s.tags && s.tags !== "None" ? s.tags : null,
    };
  });

  return {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    dataLastUpdated: r?._meta?.last_updated ?? null,
    request: { company: companies, search_term: args.search_term ?? null, product: args.product ?? null, issue: args.issue ?? null, state: args.state ?? null, zip_code: args.zip_code ?? null, date_received_min: since, date_received_max: until },
    ...(companyResolution ? { companyResolution } : {}),
    total,
    summary: {
      monetaryReliefShare: total ? round(reliefCount / total, 4) : null,
      anyReliefShare: total ? round(anyReliefCount / total, 4) : null,
      untimelyShare: total ? round(untimely / total, 4) : null,
      inProgress: respB.find((b) => /in progress/i.test(b.key))?.count ?? 0,
    },
    byProduct: keepProduct(subBuckets(aggs, "product", "sub_product.raw", 4)).slice(0, 8),
    byIssue: keepIssue(subBuckets(aggs, "issue", "sub_issue.raw", 4)).slice(0, 8),
    byCompanyResponse: respB,
    byCompany: companyB.slice(0, 10),
    byState: keepState(buckets(aggs, "state")).slice(0, 10),
    bySubmittedVia: buckets(aggs, "submitted_via").slice(0, 5),
    recent,
    note:
      "Complaints are consumer-submitted and unverified; counts scale with customer base, so compare monetaryReliefShare / untimelyShare and product mix, or normalize by accounts/deposits (FDIC/NCUA tools) rather than raw totals. Default window = last 12 months (set date_received_min, e.g. 2019 or 2024-01-01, to widen). company is auto-resolved to CCDB's exact names via the suggest endpoint (see companyResolution); pass exact_company=true to skip. Narrative text is not exposed by the public API. Use cfpb_complaint_trends for monthly counts.",
  };
}

/* ------------------------------------------------------------------ */
/* cfpb_complaint_trends                                                */
/* ------------------------------------------------------------------ */

export interface TrendsArgs {
  company?: unknown;
  product?: unknown;
  issue?: unknown;
  state?: unknown;
  zip_code?: unknown;
  search_term?: string;
  interval?: "month" | "quarter" | "year";
  periods?: number;
  end?: unknown;
  exact_company?: boolean;
  compare_companies?: boolean;
}

function periodBounds(interval: "month" | "quarter" | "year", periods: number, endDate: Date): Array<{ label: string; min: string; max: string }> {
  const out: Array<{ label: string; min: string; max: string }> = [];
  const y = endDate.getUTCFullYear();
  const m = endDate.getUTCMonth();
  for (let i = periods - 1; i >= 0; i--) {
    let start: Date, end: Date, label: string;
    if (interval === "month") {
      start = new Date(Date.UTC(y, m - i, 1));
      end = new Date(Date.UTC(y, m - i + 1, 0));
      label = iso(start).slice(0, 7);
    } else if (interval === "quarter") {
      const q0 = Math.floor(m / 3) * 3;
      start = new Date(Date.UTC(y, q0 - 3 * i, 1));
      end = new Date(Date.UTC(y, q0 - 3 * i + 3, 0));
      label = `${start.getUTCFullYear()}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`;
    } else {
      start = new Date(Date.UTC(y - i, 0, 1));
      end = new Date(Date.UTC(y - i, 11, 31));
      label = String(y - i);
    }
    if (end > endDate) end = endDate;
    out.push({ label, min: iso(start), max: iso(end) });
  }
  return out;
}

async function countFor(base: URLSearchParams, min: string, max: string): Promise<number> {
  const p = new URLSearchParams(base);
  p.set("date_received_min", min);
  p.set("date_received_max", max);
  p.set("size", "0");
  p.set("no_aggs", "true");
  const key = `cfpb:count:${p.toString()}`;
  return cached(key, 6 * HOUR, async () => {
    const r = await ccdbGet<any>("", p, 20000);
    return Number(r?.hits?.total?.value) || 0;
  });
}

export async function cfpbComplaintTrends(args: TrendsArgs) {
  const interval = args.interval === "quarter" || args.interval === "year" ? args.interval : "month";
  const periods = clampInt(args.periods, interval === "month" ? 12 : interval === "quarter" ? 8 : 5, 2, interval === "month" ? 36 : interval === "quarter" ? 20 : 12);
  const endStr = normDateArg(args.end, null);
  const endDate = endStr ? new Date(endStr + "T00:00:00Z") : new Date();

  const names = args.company == null || args.company === "" ? [] : Array.isArray(args.company) ? args.company.map(String) : String(args.company).split("|").map((s) => s.trim()).filter(Boolean);
  let companies = names;
  let companyResolution: Record<string, string[]> | null = null;
  if (names.length && !args.exact_company) {
    const r = await resolveCompanies(names, 2);
    companies = r.resolved;
    companyResolution = r.map;
    if (!companies.length) throw new Error(`No CCDB company matched "${names.join(", ")}" — try a parent/legal name or omit company.`);
  }
  if (!companies.length && !args.product && !args.issue && !args.state && !args.zip_code && !args.search_term) {
    throw new Error("Provide at least one of company, product, issue, state, zip_code or search_term.");
  }

  const base = new URLSearchParams();
  if (args.search_term) base.set("search_term", String(args.search_term));
  multi(base, "product", args.product);
  multi(base, "issue", args.issue);
  multi(base, "state", Array.isArray(args.state) ? args.state.map((s) => String(s).toUpperCase()) : args.state ? String(args.state).toUpperCase() : null);
  multi(base, "zip_code", args.zip_code);

  const bounds = periodBounds(interval, periods, endDate);
  const seriesDefs: Array<{ name: string; companies: string[] }> =
    args.compare_companies && companies.length > 1
      ? companies.slice(0, 5).map((c) => ({ name: c, companies: [c] }))
      : [{ name: companies.length ? companies.join(" | ") : "all companies", companies }];

  const series: Array<{ name: string; counts: number[]; total: number; latest: number; priorAvg: number | null; latestVsPriorAvg: number | null; peak: { period: string; count: number } | null }> = [];
  for (const def of seriesDefs) {
    const p = new URLSearchParams(base);
    for (const c of def.companies) p.append("company", c);
    const counts: number[] = new Array(bounds.length).fill(0);
    // 6-way parallelism keeps each series under ~2 s for 12 periods.
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, bounds.length) }, async () => {
        for (;;) {
          const k = i++;
          if (k >= bounds.length) return;
          counts[k] = await countFor(p, bounds[k]!.min, bounds[k]!.max);
        }
      })
    );
    const total = counts.reduce((s, c) => s + c, 0);
    const completed = counts.slice(0, -1); // last period is usually partial
    const latest = counts[counts.length - 1]!;
    const priorAvg = completed.length ? completed.reduce((s, c) => s + c, 0) / completed.length : null;
    let peakIdx = -1;
    counts.forEach((c, k) => { if (peakIdx < 0 || c > counts[peakIdx]!) peakIdx = k; });
    series.push({
      name: def.name,
      counts,
      total,
      latest,
      priorAvg: priorAvg != null ? round(priorAvg, 1) : null,
      latestVsPriorAvg: priorAvg ? round(latest / priorAvg - 1, 3) : null,
      peak: peakIdx >= 0 ? { period: bounds[peakIdx]!.label, count: counts[peakIdx]! } : null,
    });
  }

  return {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    request: { company: companies, product: args.product ?? null, issue: args.issue ?? null, state: args.state ?? null, zip_code: args.zip_code ?? null, search_term: args.search_term ?? null, interval, periods, end: iso(endDate) },
    ...(companyResolution ? { companyResolution } : {}),
    periods: bounds.map((b) => b.label),
    series,
    note:
      "Counts of complaints by date_received per period (built from per-period count queries; the CCDB /trends endpoint is not deployed). The final period is partial through `end` (today by default) and complaints take ~15 days to publish, so treat the latest bucket as incomplete. Use compare_companies=true with 'A|B|C' to get one series per company (max 5).",
  };
}
