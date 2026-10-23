/**
 * SEC PAUSE list — Public Alert: Unregistered Soliciting Entities.
 *
 * Verified 2026-10-22: the list is a Drupal view at
 *   https://www.sec.gov/enforcement-litigation/public-alerts-unregistered-soliciting-entities?page=N
 * 100 rows per page (items_per_page is ignored), 17 pages ≈ 1,700 entities, two
 * columns (Name → detail URL, Category). Server-side filters exist
 * (field_display_title_value=<contains>, field_article_sub_type_secart_value=
 * "Public Alerts-UnregisteredSolicitingEntities" | "Public Alerts-ImpersonatorsofGenuineFirms" |
 * "Public Alerts-FictitiousRegulators") but there is no JSON/CSV export, so the
 * full list is scraped (≤8 concurrent requests, well under SEC's 10 req/s) and
 * cached 24 h. Detail pages carry the alert date, claimed address/phone/website
 * and narrative (e.g. which genuine firm is being impersonated).
 * SEC blocks requests without a descriptive User-Agent; politeFetch's UA passes.
 */
import { cached, clampInt, decodeEntities, fetchText, HOUR, htmlToText, nameScore, prepareName, str } from "./common";

const BASE = "https://www.sec.gov";
const LIST = `${BASE}/enforcement-litigation/public-alerts-unregistered-soliciting-entities`;
const TTL = 24 * HOUR;

export interface PauseEntry {
  name: string;
  category: string;
  url: string;
}

interface PauseDataset {
  entries: PauseEntry[];
  pages: number;
  fetchedAt: string;
}

const ROW_RE = /<tr class="pause-list-page-row">([\s\S]*?)<\/tr>/g;
const CELL_RE = /<a href="(\/enforcement-litigation\/public-alerts-unregistered-soliciting-entities\/[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?views-field-field-article-sub-type-secart">([\s\S]*?)<\/td>/;

function parsePage(html: string): PauseEntry[] {
  const out: PauseEntry[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const c = m[1]!.match(CELL_RE);
    if (!c) continue;
    out.push({ url: BASE + c[1]!, name: decodeEntities(c[2]!.replace(/<[^>]+>/g, "").trim()), category: decodeEntities(c[3]!.replace(/<[^>]+>/g, "").trim()) });
  }
  return out;
}

function lastPage(html: string): number {
  let max = 0;
  for (const m of html.matchAll(/href="\?page=(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export function loadPause(): Promise<PauseDataset> {
  return cached("sec:pause", TTL, async () => {
    const first = await fetchText(`${LIST}?page=0`, { timeoutMs: 20000 });
    const entries = parsePage(first);
    if (!entries.length) throw new Error("SEC PAUSE page 0 parsed no rows — markup may have changed");
    const last = lastPage(first);
    const pages = Array.from({ length: last }, (_, i) => i + 1);
    for (let i = 0; i < pages.length; i += 8) {
      const batch = pages.slice(i, i + 8);
      const htmls = await Promise.all(batch.map((p) => fetchText(`${LIST}?page=${p}`, { timeoutMs: 20000 })));
      for (const h of htmls) entries.push(...parsePage(h));
    }
    const seen = new Set<string>();
    const dedup = entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
    return { entries: dedup, pages: last + 1, fetchedAt: new Date().toISOString() };
  });
}

export interface PauseDetail {
  alertDate: string | null;
  contact: string | null;
  narrative: string | null;
  lastReviewed: string | null;
}

export function loadPauseDetail(url: string): Promise<PauseDetail> {
  return cached(`sec:pause:${url}`, TTL, async () => {
    const html = await fetchText(url, { timeoutMs: 20000 });
    const pick = (re: RegExp) => {
      const m = html.match(re);
      return m ? htmlToText(m[1]!) : null;
    };
    const dateTxt = pick(/field--name-field-publish-date[^>]*>([\s\S]*?)<\/div>/);
    const d = dateTxt ? new Date(dateTxt) : null;
    return {
      alertDate: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : dateTxt,
      contact: pick(/field--name-field-public-alerts-contact[^>]*>([\s\S]*?)<\/div>/)?.replace(/\n/g, "; ") ?? null,
      narrative: pick(/field--name-body[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.slice(0, 700) ?? null,
      lastReviewed: htmlToText(html.match(/Last Reviewed or Updated:([\s\S]{0,200}?)<\/(p|div|span)>/)?.[1] ?? "") || null,
    };
  });
}

const CATEGORY_ALIASES: Record<string, string> = {
  unregistered: "Unregistered Soliciting Entities",
  soliciting: "Unregistered Soliciting Entities",
  impersonat: "Impersonators of Genuine Firms",
  fictitious: "Fictitious Regulators",
  regulator: "Fictitious Regulators",
};

export async function secPauseList(args: any) {
  const name = str(args?.name);
  const catArg = str(args?.category).toLowerCase();
  const minScore = clampInt(args?.minScore, 80, 1, 100);
  const limit = clampInt(args?.limit, 10, 1, 25);
  const details = args?.details !== false;
  const ds = await loadPause();
  const category = catArg ? Object.entries(CATEGORY_ALIASES).find(([k]) => catArg.includes(k))?.[1] ?? null : null;
  if (catArg && !category) throw new Error('sec_pause_list: category must be one of "unregistered", "impersonators", "fictitious regulators"');

  const byCategory: Record<string, number> = {};
  for (const e of ds.entries) byCategory[e.category || "(uncategorized)"] = (byCategory[e.category || "(uncategorized)"] ?? 0) + 1;

  if (!name) {
    const rows = ds.entries.filter((e) => !category || e.category === category).slice(0, limit);
    return {
      source: "SEC PAUSE list (sec.gov Public Alert: Unregistered Soliciting Entities)",
      fetchedAt: ds.fetchedAt,
      total: ds.entries.length,
      byCategory,
      showing: rows.length,
      results: rows,
      note: "Pass `name` to screen an entity; the list is alphabetical, not chronological.",
    };
  }

  const q = prepareName(name, true);
  const qLoose = prepareName(name.replace(/\.(com|net|io|org|co|ltd)\b/gi, " "), false);
  const hits: Array<{ e: PauseEntry; score: number }> = [];
  for (const e of ds.entries) {
    if (category && e.category !== category) continue;
    const s = Math.max(nameScore(q, prepareName(e.name, true)), nameScore(qLoose, prepareName(e.name, false)));
    if (s >= minScore) hits.push({ e, score: s });
  }
  hits.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  const top = hits.slice(0, limit);
  const enriched = details && top.length ? await Promise.all(top.slice(0, 5).map((h) => loadPauseDetail(h.e.url).catch(() => null))) : [];
  return {
    source: "SEC PAUSE list (sec.gov Public Alert: Unregistered Soliciting Entities)",
    fetchedAt: ds.fetchedAt,
    total: ds.entries.length,
    query: { name, category, minScore },
    matchCount: hits.length,
    verdict: hits.length ? (hits[0]!.score >= 95 ? "ON_PAUSE_LIST" : "POSSIBLE_MATCH_REVIEW") : "NOT_LISTED",
    results: top.map((h, i) => ({ score: h.score, ...h.e, ...(enriched[i] ?? {}) })),
    note: "PAUSE lists entities that falsely claim US registration, impersonate genuine SEC-registered firms, or pose as regulators. A genuine firm may appear as the VICTIM of an impersonator — read the narrative. Not an SEC enforcement action list.",
  };
}
