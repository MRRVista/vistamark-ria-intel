/**
 * CFTC RED List (Registration Deficient List) — foreign entities soliciting US
 * customers for FX/binary options/crypto derivatives without CFTC registration.
 *
 * Verified 2026-10-22: https://www.cftc.gov/LearnAndProtect/RedList is a 404;
 * the live page is https://www.cftc.gov/LearnAndProtect/Resources/Check/redlist.htm
 * (Drupal view "registration_deficient"). `?items_per_page=All` returns the whole
 * table in one ~200 KB page: rows of <time datetime> + <a href="/REDlist/node/N">Company</a>
 * (~280 entities). Node pages add web address, origin country, owner/operator and
 * type of offering. No CSV/JSON export exists; cached 24 h.
 */
import { cached, clampInt, decodeEntities, fetchText, HOUR, htmlToText, nameScore, prepareName, str } from "./common";

const BASE = "https://www.cftc.gov";
const LIST = `${BASE}/LearnAndProtect/Resources/Check/redlist.htm?items_per_page=All`;
const TTL = 24 * HOUR;

export interface RedEntry {
  name: string;
  dateEntered: string | null;
  url: string;
}

interface RedDataset {
  entries: RedEntry[];
  fetchedAt: string;
}

const ROW_RE = /<time datetime="(\d{4}-\d{2}-\d{2})[^"]*">[^<]*<\/time>[\s\S]*?<a href="(\/REDlist\/node\/\d+)"[^>]*>([\s\S]*?)<\/a>/g;

export function loadRedList(): Promise<RedDataset> {
  return cached("cftc:red", TTL, async () => {
    const html = await fetchText(LIST, { timeoutMs: 25000 });
    const entries: RedEntry[] = [];
    for (const m of html.matchAll(ROW_RE)) {
      entries.push({ dateEntered: m[1]!, url: BASE + m[2]!, name: decodeEntities(m[3]!.replace(/<[^>]+>/g, "").trim()) });
    }
    if (entries.length < 50) throw new Error(`CFTC RED list parsed only ${entries.length} rows — markup may have changed`);
    return { entries, fetchedAt: new Date().toISOString() };
  });
}

export interface RedDetail {
  website: string | null;
  origin: string | null;
  ownedOperatedBy: string | null;
  offerings: string | null;
}

export function loadRedDetail(url: string): Promise<RedDetail> {
  return cached(`cftc:red:${url}`, TTL, async () => {
    const html = await fetchText(url, { timeoutMs: 20000 });
    const body = html.match(/field--name-body[^>]*>([\s\S]*?)Registration Matters/)?.[1] ?? html;
    const text = htmlToText(body);
    const grab = (label: RegExp) => text.match(label)?.[1]?.trim() ?? null;
    return {
      website: grab(/Web address:\s*([^\n]+)/i),
      origin: grab(/Origin:\s*([^\n]+)/i),
      ownedOperatedBy: grab(/Owned and Operated by:\s*([^\n]+)/i),
      offerings: grab(/Type of Offerings?:\s*([^\n]+)/i),
    };
  });
}

export async function cftcRedListSearch(args: any) {
  const name = str(args?.name);
  const minScore = clampInt(args?.minScore, 80, 1, 100);
  const limit = clampInt(args?.limit, 10, 1, 25);
  const details = args?.details !== false;
  const ds = await loadRedList();

  if (!name) {
    const recent = ds.entries.slice().sort((a, b) => (b.dateEntered ?? "").localeCompare(a.dateEntered ?? "")).slice(0, limit);
    return {
      source: "CFTC RED List (cftc.gov Registration Deficient List)",
      fetchedAt: ds.fetchedAt,
      total: ds.entries.length,
      latestEntry: recent[0]?.dateEntered ?? null,
      showing: recent.length,
      results: recent,
      note: "Pass `name` to screen an entity.",
    };
  }
  const q = prepareName(name, true);
  const qLoose = prepareName(name.replace(/\.(com|net|io|org|co|ltd)\b/gi, " "), false);
  const hits: Array<{ e: RedEntry; score: number }> = [];
  for (const e of ds.entries) {
    const s = Math.max(nameScore(q, prepareName(e.name, true)), nameScore(qLoose, prepareName(e.name, false)));
    if (s >= minScore) hits.push({ e, score: s });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);
  const enriched = details && top.length ? await Promise.all(top.slice(0, 5).map((h) => loadRedDetail(h.e.url).catch(() => null))) : [];
  return {
    source: "CFTC RED List (cftc.gov Registration Deficient List)",
    fetchedAt: ds.fetchedAt,
    total: ds.entries.length,
    query: { name, minScore },
    matchCount: hits.length,
    verdict: hits.length ? (hits[0]!.score >= 95 ? "ON_RED_LIST" : "POSSIBLE_MATCH_REVIEW") : "NOT_LISTED",
    results: top.map((h, i) => ({ score: h.score, ...h.e, ...(enriched[i] ?? {}) })),
    note: "RED-listing means the entity appears to require CFTC registration but is not registered; it is not a finding of violation. Check registration status separately at NFA BASIC.",
  };
}
