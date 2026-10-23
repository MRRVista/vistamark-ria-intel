/**
 * GDELT DOC 2.0 API — https://api.gdeltproject.org/api/v2/doc/doc
 *   ?query=...&mode=artlist|timelinevol&format=json&maxrecords=N&timespan=1w|3m|...&sort=datedesc
 * Keyless. Global online-news index (65 languages) refreshed every 15 minutes;
 * rolling 3-month window by default (startdatetime/enddatetime go back to 2017).
 * Rate limit: one request per 5 s per IP, enforced with HTTP 429 + text body.
 * Verified 2026-10-22: artlist returned JSON after a 6 s pause; back-to-back
 * calls 429. A two-attempt backoff (pause 5.5 s) is applied; results cached 15 min.
 */
import { cached, clampInt, jsonWithBackoff, MIN, round, toIsoDate, trim } from "./common";

const BASE = "https://api.gdeltproject.org/api/v2/doc/doc";
const TIMESPAN = /^\d+(min|h|d|w|m)$/i;

function buildQuery(q: string, opts: { domain?: string; country?: string; language?: string; tone?: string }): string {
  let query = q.trim();
  // Multi-word unquoted phrases: GDELT requires quotes for phrase search; leave boolean/quoted input alone.
  if (!/["()]| OR | AND /.test(query) && /\s/.test(query)) query = `"${query}"`;
  if (opts.domain) query += ` domain:${opts.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
  if (opts.country) query += ` sourcecountry:${opts.country.replace(/\s+/g, "")}`;
  if (opts.language) query += ` sourcelang:${opts.language}`;
  if (opts.tone) query += ` ${opts.tone}`;
  return query;
}

export async function gdeltDocSearch(args: any) {
  const q = String(args?.query ?? "").trim();
  if (!q) throw new Error("gdelt_doc_search: `query` is required (keywords, quoted phrases, OR/AND)");
  const mode = args?.mode === "timelinevol" ? "timelinevol" : "artlist";
  const limit = clampInt(args?.limit, 15, 1, 25);
  const timespan = String(args?.timespan ?? "1w").trim().toLowerCase();
  if (!TIMESPAN.test(timespan)) throw new Error("gdelt_doc_search: `timespan` must look like 15min, 24h, 7d, 2w or 3m (max 3m without start/end dates)");
  const query = buildQuery(q, { domain: args?.domain, country: args?.sourceCountry, language: args?.sourceLang, tone: args?.toneFilter });
  const params = new URLSearchParams({ query, mode, format: "json", timespan });
  if (mode === "artlist") {
    params.set("maxrecords", String(Math.max(limit, 25)));
    params.set("sort", args?.sort === "relevance" ? "hybridrel" : "datedesc");
  }
  const url = `${BASE}?${params.toString()}`;
  const data = await cached(`gdelt:${url}`, 15 * MIN, () =>
    jsonWithBackoff<any>(url, {
      source: "GDELT DOC API",
      retryAfterMs: 5500,
      timeoutMs: 28000,
      hint429: "GDELT allows one request per 5 seconds per IP; wait a few seconds and retry, or narrow the query",
    })
  );
  const fetchedAt = new Date().toISOString();
  if (mode === "timelinevol") {
    const series = data?.timeline?.[0]?.data ?? [];
    const pts = series.map((p: any) => ({ date: toIsoDate(p.date), value: round(Number(p.value), 4) }));
    const vals = pts.map((p: any) => p.value ?? 0);
    const peak = pts.reduce((a: any, b: any) => ((b.value ?? 0) > (a?.value ?? -1) ? b : a), null);
    const step = Math.max(1, Math.ceil(pts.length / 60));
    return {
      source: "GDELT DOC 2.0 (timelinevol)",
      fetchedAt,
      query,
      timespan,
      unit: "share (%) of all monitored global coverage matching the query per 15-min / daily bucket",
      points: pts.length,
      mean: vals.length ? round(vals.reduce((a: number, b: number) => a + b, 0) / vals.length, 4) : null,
      peak,
      series: pts.filter((_: any, i: number) => i % step === 0 || i === pts.length - 1),
    };
  }
  const arts = Array.isArray(data?.articles) ? data.articles : [];
  const seen = new Set<string>();
  const articles: any[] = [];
  for (const a of arts) {
    const key = (a.title ?? a.url ?? "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    articles.push({
      title: trim(a.title, 160),
      url: a.url,
      domain: a.domain ?? null,
      date: toIsoDate(a.seendate),
      language: a.language ?? null,
      country: a.sourcecountry ?? null,
    });
    if (articles.length >= limit) break;
  }
  return {
    source: "GDELT DOC 2.0 (artlist)",
    fetchedAt,
    query,
    timespan,
    returned: articles.length,
    note: articles.length ? undefined : "No matching coverage in GDELT for this window; try a broader timespan (max 3m) or news_rss_search.",
    articles,
  };
}
