/**
 * News RSS search.
 *   Google News: https://news.google.com/rss/search?q=<q>&hl=en-US&gl=US&ceid=US:en
 *     Keyless. Returns 503 "automated queries" to non-browser User-Agents (verified
 *     2026-10-22 from the sandbox); accepted with a Chrome UA. Query supports
 *     Google operators (quotes, OR, site:, when:7d). ~100 items max.
 *   Bing News:   https://www.bing.com/news/search?q=<q>&format=rss
 *     Keyless, accepts the Vistamark UA. Items carry <News:Source>; links are
 *     bing.com/news/apiclick redirects with the real url in the `url` param.
 * Cached 10 min per (provider, query).
 */
import { BROWSER_UA, cached, clampInt, decodeEntities, hostOf, MIN, parseRssItems, stripTags, textWithBackoff, toIsoDate, trim } from "./common";

interface NewsItem {
  title: string | null;
  url: string | null;
  source: string | null;
  published: string | null;
  snippet?: string | null;
  provider: "google" | "bing";
}

function unwrapBing(link: string): string {
  try {
    const u = new URL(link);
    const real = u.searchParams.get("url");
    return real ? decodeURIComponent(real) : link;
  } catch {
    return link;
  }
}

async function google(query: string, sinceDays: number | null): Promise<NewsItem[]> {
  const q = sinceDays ? `${query} when:${sinceDays}d` : query;
  const url = `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: "en-US", gl: "US", ceid: "US:en" })}`;
  const xml = await cached(`gnews:${url}`, 10 * MIN, () =>
    textWithBackoff(url, { source: "Google News RSS", headers: { "User-Agent": BROWSER_UA, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" }, retryAfterMs: 1500 })
  );
  if (/<title>Sorry\.\.\.<\/title>/.test(xml)) throw new Error("Google News RSS refused the request (automated-query block); retry later or use provider 'bing'");
  return parseRssItems(xml).map((it) => {
    // Google titles end with " - Source"
    let title = it.title ?? "";
    const src = it.source ?? null;
    if (src && title.endsWith(` - ${src}`)) title = title.slice(0, -(src.length + 3));
    return {
      title: trim(title, 160),
      url: it.link ?? null,
      source: src ?? hostOf(it.link),
      published: toIsoDate(it.pubdate),
      provider: "google" as const,
    };
  });
}

async function bing(query: string): Promise<NewsItem[]> {
  const url = `https://www.bing.com/news/search?${new URLSearchParams({ q: query, format: "rss" })}`;
  const xml = await cached(`bnews:${url}`, 10 * MIN, () =>
    textWithBackoff(url, { source: "Bing News RSS", headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" }, retryAfterMs: 1500 })
  );
  return parseRssItems(xml).map((it) => {
    const link = it.link ? unwrapBing(decodeEntities(it.link)) : null;
    return {
      title: trim(it.title, 160),
      url: link,
      source: it["news:source"] ?? hostOf(link),
      published: toIsoDate(it.pubdate),
      snippet: trim(stripTags(it.description ?? ""), 220),
      provider: "bing" as const,
    };
  });
}

export async function newsRssSearch(args: any) {
  const query = String(args?.query ?? "").trim();
  if (!query) throw new Error("news_rss_search: `query` is required");
  const limit = clampInt(args?.limit, 15, 1, 25);
  const sinceDays = args?.sinceDays != null ? clampInt(args.sinceDays, 30, 1, 365) : null;
  const provider = (args?.provider ?? "both") as "google" | "bing" | "both";
  const errors: string[] = [];
  const settled = await Promise.allSettled([
    provider === "bing" ? Promise.resolve<NewsItem[]>([]) : google(query, sinceDays),
    provider === "google" ? Promise.resolve<NewsItem[]>([]) : bing(query),
  ]);
  let items: NewsItem[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") items.push(...s.value);
    else errors.push(String(s.reason?.message ?? s.reason).slice(0, 160));
  }
  if (!items.length && errors.length) throw new Error(`news_rss_search: ${errors.join(" | ")}`);
  if (sinceDays) {
    const cutoff = Date.now() - sinceDays * 86400000;
    items = items.filter((i) => !i.published || new Date(i.published).getTime() >= cutoff);
  }
  // Dedupe by normalized title; prefer Google (direct publisher dates) then Bing (snippets)
  const seen = new Map<string, NewsItem>();
  for (const i of items) {
    const key = (i.title ?? i.url ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) seen.set(key, i);
    else if (!prev.snippet && i.snippet) prev.snippet = i.snippet;
  }
  const out = [...seen.values()].sort((a, b) => (b.published ?? "").localeCompare(a.published ?? "")).slice(0, limit);
  return {
    source: "Google News RSS + Bing News RSS",
    fetchedAt: new Date().toISOString(),
    query,
    sinceDays,
    providers: settled.map((s, i) => `${i === 0 ? "google" : "bing"}:${s.status === "fulfilled" ? s.value.length : "error"}`),
    errors: errors.length ? errors : undefined,
    returned: out.length,
    items: out,
  };
}
