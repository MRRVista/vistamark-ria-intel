/**
 * SEC enforcement feeds — Litigation Releases and Administrative Proceedings.
 * Keyless; sec.gov requires a descriptive User-Agent (politeFetch's identifies
 * Vistamark with a contact address) and asks for <= 10 req/s.
 *
 * Verified live 2026-10-22:
 *   RSS (latest 25, title = respondents, dc:creator = release no.):
 *     https://www.sec.gov/enforcement-litigation/litigation-releases/rss
 *     https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss
 *     (the legacy /rss/litigation/litreleases.xml and admin.xml 301 to these)
 *   HTML listing (Drupal view, 100 rows/page, server-side filters):
 *     https://www.sec.gov/enforcement-litigation/litigation-releases?populate=<kw>&year=YYYY|All&month=M|All&page=N
 *     https://www.sec.gov/enforcement-litigation/administrative-proceedings?populate=<kw>&year=..&month=..&page=N
 *     Each row: <time datetime>, respondents link (LR page or AP PDF), Release No.,
 *     File Number (AP) or "See Also" documents (LR: complaint / judgment PDFs).
 *   LR detail page: https://www.sec.gov/enforcement-litigation/litigation-releases/lr-NNNNN
 *     (HTML; article body gives the case caption + summary paragraphs).
 *   AP documents are PDFs under /files/litigation/admin/<year>/<release>.pdf — not parsed.
 *
 * `populate` matches respondent names / titles (e.g. "adviser" returns Womack
 * Investment Advisers, Headstart Advisers, …), not full text, and returns 0 rows
 * when combined with year/month — so keyword searches run with year=All.
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, HOUR, clampInt, trunc } from "./common";

const SEC = "https://www.sec.gov";
const PATHS = {
  litigation: "/enforcement-litigation/litigation-releases",
  admin: "/enforcement-litigation/administrative-proceedings",
} as const;
export type Feed = keyof typeof PATHS;

async function secText(url: string, timeoutMs = 20000): Promise<string> {
  const res = await politeFetch(url, {
    timeoutMs,
    retries: 2,
    headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Encoding": "gzip, deflate" },
  });
  if (res.status === 403) throw new Error(`sec.gov refused the request (403) — SEC blocks anonymous/bot User-Agents; VISTAMARK_USER_AGENT must identify a contact`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  return await res.text();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

export interface Release {
  date: string | null;
  releaseNo: string | null;
  respondents: string;
  url: string;
  fileNumber?: string | null;
  documents?: Array<{ label: string; url: string }>;
  summary?: string | null;
}

/** Parse the Drupal listing table into rows. */
function parseListing(html: string): Release[] {
  const rows: Release[] = [];
  const parts = html.split('<tr class="pr-list-page-row">').slice(1);
  for (const p of parts) {
    const date = p.match(/<time datetime="([^"]+)"/)?.[1] ?? null;
    const link = p.match(/release-view__respondents'><a href='([^']+)'>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const href = link[1]!;
    const url = href.startsWith("http") ? href : `${SEC}${href}`;
    const relNo = p.match(/subfield_release_number[\s\S]*?subfield_value">([^<]+)</)?.[1]?.trim() ?? null;
    const fileNo = p.match(/subfield_file_number[\s\S]*?subfield_value">([^<]+)</)?.[1]?.trim() ?? null;
    const docs: Array<{ label: string; url: string }> = [];
    const docRe = /<a href="([^"]+\.pdf)"[^>]*>([^<]+)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = docRe.exec(p))) docs.push({ label: decode(m[2]!), url: m[1]!.startsWith("http") ? m[1]! : `${SEC}${m[1]}` });
    rows.push({
      date: date ? date.slice(0, 10) : null,
      releaseNo: relNo,
      respondents: decode(link[2]!),
      url,
      fileNumber: fileNo ?? undefined,
      documents: docs.length ? docs : undefined,
    });
  }
  return rows;
}

/** Parse the RSS feed (latest 25). */
function parseRss(xml: string): Release[] {
  const out: Release[] = [];
  const items = xml.split("<item>").slice(1);
  for (const it of items) {
    const title = it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const link = it.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    const pub = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "";
    const creator = it.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1] ?? null;
    const d = pub ? new Date(pub) : null;
    out.push({
      date: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null,
      releaseNo: creator?.trim() ?? null,
      respondents: decode(title),
      url: link,
    });
  }
  return out;
}

function listingUrl(feed: Feed, opts: { keyword?: string; year?: string; month?: string; page: number }): string {
  const sp = new URLSearchParams();
  sp.set("populate", opts.keyword ?? "");
  sp.set("year", opts.year ?? "All");
  sp.set("month", opts.month ?? "All");
  if (opts.page) sp.set("page", String(opts.page));
  return `${SEC}${PATHS[feed]}?${sp.toString()}`;
}

async function loadListing(feed: Feed, opts: { keyword?: string; year?: string; month?: string; page: number }): Promise<Release[]> {
  const url = listingUrl(feed, opts);
  return cached(`sec:list:${url}`, 2 * HOUR, async () => parseListing(await secText(url)));
}

async function loadRss(feed: Feed): Promise<Release[]> {
  const url = `${SEC}${PATHS[feed]}/rss`;
  return cached(`sec:rss:${feed}`, HOUR, async () => parseRss(await secText(url, 15000)));
}

/** Pull the narrative from a litigation-release HTML page (first ~N chars of the article body). */
async function lrSummary(url: string, chars: number): Promise<string | null> {
  return cached(`sec:lr:${url}:${chars}`, 24 * HOUR, async () => {
    const html = await secText(url, 15000);
    const i = html.indexOf("field--name-body");
    const body = i > 0 ? html.slice(i, i + 30000) : html.slice(html.indexOf("<main"), html.indexOf("<main") + 40000);
    const text = decode(
      body
        .replace(/<script[\s\S]*?<\/script>/g, " ")
        .replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<\/(p|div|h\d|li)>/g, " ")
        .replace(/<[^>]+>/g, " ")
    );
    // Drop the agency boilerplate that precedes the caption.
    const j = text.search(/Litigation Release No\./i);
    const t = j >= 0 ? text.slice(j) : text;
    return trunc(t, chars);
  });
}

export interface EnforcementArgs {
  keyword?: string;
  year?: number | string;
  month?: number | string;
  since?: string;
  until?: string;
  limit?: number;
  pages?: number;
  includeSummary?: boolean;
  summaryChars?: number;
}

export async function enforcementFeed(feed: Feed, args: EnforcementArgs) {
  const keyword = String(args.keyword ?? "").trim();
  const year = args.year != null && String(args.year).trim() ? String(args.year).trim() : undefined;
  const month = args.month != null && String(args.month).trim() ? String(Number(args.month)) : undefined;
  if (month && !year) throw new Error("`month` requires `year`");
  if (year && !/^(19|20)\d{2}$/.test(year)) throw new Error("`year` must be YYYY (SEC listing covers 1995+)");
  const since = args.since ? String(args.since).slice(0, 10) : undefined;
  const until = args.until ? String(args.until).slice(0, 10) : undefined;
  const limit = clampInt(args.limit, 15, 1, 25);
  const pages = clampInt(args.pages, 1, 1, 3);
  const wantSummary = feed === "litigation" && Boolean(args.includeSummary);
  const summaryChars = clampInt(args.summaryChars, 600, 150, 1500);

  let rows: Release[];
  let via: string;
  const filtered = Boolean(keyword || year || since || until);
  if (!filtered && limit <= 25 && !args.pages) {
    rows = await loadRss(feed);
    via = `${SEC}${PATHS[feed]}/rss`;
  } else {
    rows = [];
    // The listing's `populate` search returns 0 rows when combined with a year,
    // so with a keyword we query all years and apply year/month locally.
    const srvYear = keyword ? undefined : year;
    const srvMonth = keyword ? undefined : month;
    via = listingUrl(feed, { keyword, year: srvYear, month: srvMonth, page: 0 });
    for (let p = 0; p < pages; p++) {
      const page = await loadListing(feed, { keyword, year: srvYear, month: srvMonth, page: p });
      rows.push(...page);
      if (page.length < 100) break;
      // Stop paging once we're past the `since` bound (listing is newest-first).
      if (since && page[page.length - 1]!.date && page[page.length - 1]!.date! < since) break;
    }
  }
  if (keyword && year) {
    const prefix = month ? `${year}-${month.padStart(2, "0")}` : year;
    rows = rows.filter((r) => (r.date ?? "").startsWith(prefix));
  }
  if (since) rows = rows.filter((r) => !r.date || r.date >= since);
  if (until) rows = rows.filter((r) => !r.date || r.date <= until);
  // Client-side keyword pass too, in case the listing search is looser than expected.
  if (keyword) {
    const kw = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    const strict = rows.filter((r) => kw.every((k) => r.respondents.toLowerCase().includes(k)));
    if (strict.length) rows = strict;
  }
  const total = rows.length;
  rows = rows.slice(0, limit);
  if (wantSummary) {
    const n = Math.min(rows.length, 6);
    await Promise.all(
      rows.slice(0, n).map(async (r) => {
        try {
          r.summary = await lrSummary(r.url, summaryChars);
        } catch (e) {
          r.summary = `(summary unavailable: ${(e as Error).message.slice(0, 80)})`;
        }
      })
    );
  }
  return {
    source: feed === "litigation" ? "SEC Litigation Releases (sec.gov/enforcement-litigation/litigation-releases)" : "SEC Administrative Proceedings (sec.gov/enforcement-litigation/administrative-proceedings)",
    fetchedAt: new Date().toISOString(),
    via,
    filters: { keyword: keyword || null, year: year ?? null, month: month ?? null, since: since ?? null, until: until ?? null },
    matched: total,
    returned: rows.length,
    note: wantSummary ? "summary = first paragraphs of the release page (max 6 per call)" : feed === "admin" ? "AP links are the order PDFs; release prefixes: IA- (Advisers Act), 34- (Exchange Act), 33- (Securities Act), IC- (Investment Company Act), AAER (accounting)" : undefined,
    releases: rows,
  };
}
