/**
 * Federal Reserve Board RSS feeds + FOMC statement text, keyless.
 *
 * Feeds (verified live 2026-10-22, all HTTP 200, RSS 2.0, 15–20 items each,
 * UTF-8 BOM, CDATA-wrapped link/description/pubDate):
 *   https://www.federalreserve.gov/feeds/press_all.xml          (all press releases, 20 items ≈ last 5–6 weeks)
 *   https://www.federalreserve.gov/feeds/press_monetary.xml     (FOMC statements, minutes, discount-rate minutes)
 *   https://www.federalreserve.gov/feeds/press_bcreg.xml        (banking / consumer regulation)
 *   https://www.federalreserve.gov/feeds/press_enforcement.xml  (enforcement actions)
 *   https://www.federalreserve.gov/feeds/press_orders.xml       (orders on banking applications)
 *   https://www.federalreserve.gov/feeds/press_other.xml        (other announcements)
 *   https://www.federalreserve.gov/feeds/speeches.xml           (Board member speeches; title = "Surname, Title")
 *   https://www.federalreserve.gov/feeds/testimony.xml          (congressional testimony; sparse)
 *
 * FOMC statement pages: /newsevents/pressreleases/monetaryYYYYMMDDa.htm — body sits in
 * <div id="article"> ... <div class="col-xs-12 col-sm-8 col-md-8">; first paragraph of
 * newer statements carries "approved ... by a N – M vote"; older ones end with
 * "Voting for the monetary policy action were ...".
 */
import { cached, fetchText, HOUR, MINUTE, cdata, tagText, parsePubDate, htmlToText, clampInt, isoDaysAgo, decodeEntities } from "./common";

const FEED_BASE = "https://www.federalreserve.gov/feeds";
export const FEEDS = {
  all: "press_all.xml",
  monetary: "press_monetary.xml",
  bcreg: "press_bcreg.xml",
  enforcement: "press_enforcement.xml",
  orders: "press_orders.xml",
  other: "press_other.xml",
  speeches: "speeches.xml",
  testimony: "testimony.xml",
} as const;
export type FeedKey = keyof typeof FEEDS;

export interface FeedItem {
  title: string;
  date: string | null;
  publishedAt: string | null;
  link: string;
  category: string | null;
  summary: string;
}

export function loadFeed(feed: FeedKey): Promise<FeedItem[]> {
  return cached(`fedboard:feed:${feed}`, 15 * MINUTE, async () => {
    const xml = await fetchText(`${FEED_BASE}/${FEEDS[feed]}`, 20000, 2, "application/rss+xml, application/xml, text/xml, */*");
    const items: FeedItem[] = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const body = m[1]!;
      const title = decodeEntities(cdata(tagText(body, "title")));
      const link = cdata(tagText(body, "link")) || cdata(tagText(body, "guid"));
      const desc = htmlToText(cdata(tagText(body, "description")));
      const { date, at } = parsePubDate(cdata(tagText(body, "pubDate")));
      const category = cdata(tagText(body, "category")) || null;
      items.push({
        title,
        date,
        publishedAt: at,
        link,
        category,
        summary: desc === title ? "" : desc.slice(0, 300),
      });
    }
    if (!items.length) throw new Error(`Fed feed ${FEEDS[feed]} returned no <item> elements`);
    items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    return items;
  });
}

export async function fedPressReleases(args: { feed?: string; limit?: number; sinceDays?: number; keyword?: string }) {
  const feedArg = String(args.feed ?? "all").toLowerCase().trim();
  const feed = (Object.keys(FEEDS) as FeedKey[]).find((k) => k === feedArg || FEEDS[k] === feedArg || FEEDS[k] === `${feedArg}.xml`);
  if (!feed) throw new Error(`Unknown feed '${args.feed}'. Use one of: ${Object.keys(FEEDS).join(", ")}`);
  const limit = clampInt(args.limit, 10, 1, 25);
  const sinceDays = args.sinceDays == null ? null : clampInt(args.sinceDays, 30, 1, 3650);
  const kws = String(args.keyword ?? "")
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);

  const items = await loadFeed(feed);
  let rows = items;
  if (sinceDays != null) {
    const cutoff = isoDaysAgo(sinceDays);
    rows = rows.filter((r) => (r.date ?? "") >= cutoff);
  }
  if (kws.length) {
    rows = rows.filter((r) => {
      const hay = `${r.title} ${r.summary} ${r.category ?? ""}`.toLowerCase();
      return kws.every((k) => hay.includes(k));
    });
  }
  return {
    source: `Federal Reserve Board RSS (${FEEDS[feed]})`,
    fetchedAt: new Date().toISOString(),
    feed,
    feedCoverage: { items: items.length, newest: items[0]?.date ?? null, oldest: items[items.length - 1]?.date ?? null },
    matched: rows.length,
    items: rows.slice(0, limit),
    note:
      rows.length === 0
        ? "No items matched. Board feeds only carry the most recent 15–20 releases; widen sinceDays/keyword or use fed_enforcement_actions / fomc_calendar for history."
        : undefined,
  };
}

// ---------------------------------------------------------------- FOMC statement

export interface StatementResult {
  source: string;
  fetchedAt: string;
  meetingDate: string | null;
  title: string | null;
  releaseTime: string | null;
  url: string;
  vote: string | null;
  decision: string | null;
  text: string;
  truncated: boolean;
  chars: number;
  implementationNoteUrl: string | null;
}

const PRESS_BASE = "https://www.federalreserve.gov/newsevents/pressreleases";

function statementUrlFor(yyyymmdd: string): string {
  return `${PRESS_BASE}/monetary${yyyymmdd}a.htm`;
}

export function loadStatementPage(url: string): Promise<string> {
  return cached(`fedboard:page:${url}`, 6 * HOUR, () => fetchText(url, 25000, 2, "text/html,*/*"));
}

/** Extract the statement body from a Board press-release page. */
export function parseStatement(html: string, url: string, maxChars: number): StatementResult {
  const titleM = html.match(/<h3 class="title">([\s\S]*?)<\/h3>/i);
  const timeM = html.match(/<p class="article__time">([\s\S]*?)<\/p>/i);
  const relM = html.match(/<p class="releaseTime">([^<]*)/i);
  const bodyStart = html.search(/<div class="col-xs-12 col-sm-8 col-md-8">\s*(?!\s*<h3)/);
  let body = "";
  if (bodyStart >= 0) {
    const rest = html.slice(bodyStart);
    const end = rest.search(/<div id="lastUpdate"|<div class="col-xs-12 col-sm-4|<footer|<div class="article__footer/i);
    body = htmlToText(end > 0 ? rest.slice(0, end) : rest);
  } else {
    const art = html.match(/<div id="article">([\s\S]*?)<div id="lastUpdate"/i);
    body = htmlToText(art ? art[1]! : html);
  }
  // Drop boilerplate lines.
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^For media inquiries/i.test(l) && !/^Last Update/i.test(l) && !/^Implementation Note issued/i.test(l) && !/^Share$/i.test(l));
  const full = lines.join("\n");
  const voteLine = lines.find((l) => /voting (for|against)|by a \d+\s*[–-]\s*\d+ vote|unanimous/i.test(l)) ?? null;
  let vote: string | null = null;
  if (voteLine) {
    const m = voteLine.match(/by a (\d+)\s*[–-]\s*(\d+) vote/i);
    // Name lists contain "Chair;" / "Vice Chair;" and initials ("John C. Williams") so split on
    // sentence boundaries only where a period is followed by a space and a capital-letter word.
    const sentences = voteLine.split(/(?<=[a-z\)])\.\s+(?=[A-Z])/);
    const vf = sentences.find((x) => /^Voting for/i.test(x));
    const va = sentences.find((x) => /^Voting against/i.test(x));
    if (m) vote = `${m[1]}–${m[2]}`;
    else vote = [vf, va].filter(Boolean).map((x) => x!.trim().replace(/\.?$/, ".")).join(" ") || voteLine.slice(0, 500);
    if (m && va) vote += `; ${va.trim()}`;
    if (vf && !m) {
      const names = (vf.match(/were (.*)$/i)?.[1] ?? "").split(";").filter((x) => x.trim());
      const dissent = va ? va.replace(/^Voting against (?:this|the) action (?:was|were)\s*/i, "").split(/;| and /).filter((x) => /[A-Z][a-z]+ [A-Z]/.test(x)).length : 0;
      if (names.length) vote = `${names.length}–${dissent} — ${vote}`;
    }
  }
  const decision = lines.find((l) => /target range for the federal funds rate/i.test(l)) ?? null;
  const dm = url.match(/monetary(\d{4})(\d{2})(\d{2})/);
  const impl = html.match(/href="(\/newsevents\/pressreleases\/monetary\d{8}a1\.htm)"/i);
  const text = full.length > maxChars ? `${full.slice(0, maxChars).replace(/\s+\S*$/, "")} …` : full;
  return {
    source: "Federal Reserve Board press release",
    fetchedAt: new Date().toISOString(),
    meetingDate: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null,
    title: titleM ? htmlToText(titleM[1]!) : null,
    releaseTime: relM ? htmlToText(relM[1]!) : timeM ? htmlToText(timeM[1]!) : null,
    url,
    vote,
    decision: decision ? decision.slice(0, 400) : null,
    text,
    truncated: full.length > maxChars,
    chars: full.length,
    implementationNoteUrl: impl ? `https://www.federalreserve.gov${impl[1]}` : null,
  };
}

export async function fomcStatement(args: { date?: string; maxChars?: number }, latestStatementUrl: () => Promise<{ url: string; date: string } | null>) {
  const maxChars = clampInt(args.maxChars, 3000, 300, 5000);
  let url: string;
  if (args.date) {
    const d = String(args.date).replace(/-/g, "").trim();
    if (!/^\d{8}$/.test(d)) throw new Error("date must be YYYY-MM-DD (the FOMC decision day, e.g. 2024-09-18)");
    url = statementUrlFor(d);
  } else {
    const latest = await latestStatementUrl();
    if (!latest) throw new Error("Could not determine the latest FOMC statement from the calendar page");
    url = latest.url;
  }
  let html: string;
  try {
    html = await loadStatementPage(url);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)} — if you passed a date, it must be the second day of the FOMC meeting (decision day); use fomc_calendar to look up meeting dates.`);
  }
  const out = parseStatement(html, url, maxChars);
  if (!/FOMC statement/i.test(out.title ?? "") && !/Committee/i.test(out.text)) {
    out.text = `${out.text}`.slice(0, maxChars);
    return { ...out, note: "Page did not look like an FOMC statement; check the date with fomc_calendar." };
  }
  return out;
}
