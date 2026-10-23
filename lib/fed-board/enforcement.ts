/**
 * Federal Reserve Board enforcement actions, keyless.
 *
 * The search page https://www.federalreserve.gov/supervisionreg/enforcementactions.htm
 * is an Angular app that loads two static JSON files (verified live 2026-10-22):
 *   https://www.federalreserve.gov/supervisionreg/files/ea-cms-recent.json   (~90 KB, 2019-01 → today; 385 items)
 *   https://www.federalreserve.gov/supervisionreg/files/ea-old.json          (~566 KB, 1990s → 2018-12; 2,514 items)
 * (the same paths without /files/ return a one-line stub / stale copy — do not use them).
 * Item shape: {id, edt (effective), tdt (termination; "1950-01-01" = none), type,
 *              bkorg | person + porg, url (absolute or site-relative), urlname, note?}
 * A CSV export also exists: /supervisionreg/files/enforcementactions.csv (same rows).
 * Fallback: feeds/press_enforcement.xml (last 15 enforcement press releases).
 */
import { cached, fetchText, HOUR, clampInt, isoDaysAgo, decodeEntities } from "./common";
import { loadFeed } from "./press";

const SITE = "https://www.federalreserve.gov";
const RECENT_URL = `${SITE}/supervisionreg/files/ea-cms-recent.json`;
const OLD_URL = `${SITE}/supervisionreg/files/ea-old.json`;

interface RawItem {
  id: string | number;
  edt?: string;
  tdt?: string;
  type?: string;
  bkorg?: string;
  person?: string;
  porg?: string;
  url?: string;
  urlname?: string;
  note?: string;
}

export interface EnforcementAction {
  id: string;
  effectiveDate: string | null;
  terminationDate: string | null;
  status: "active" | "terminated";
  actionType: string;
  party: string;                // banking organization or individual name
  partyKind: "institution" | "individual";
  affiliation: string | null;   // for individuals: the institution
  state: string | null;         // parsed from "..., City, State" when present
  url: string | null;
  docType: string | null;
  note: string | null;
}

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "puerto rico": "PR",
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

/** "Ontario Bancorporation, Inc., Ontario, Wisconsin" -> "WI"; "Compass Bank, Birmingham, AL" -> "AL". */
export function parseState(s: string | undefined): string | null {
  if (!s) return null;
  const first = s.split(";")[0]!;
  const parts = first.split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 2); i--) {
    const p = parts[i]!.replace(/\.$/, "");
    const up = p.toUpperCase();
    if (STATE_CODES.has(up)) return up;
    const named = STATE_NAMES[p.toLowerCase()];
    if (named) return named;
  }
  return null;
}

function normalize(r: RawItem): EnforcementAction {
  const term = r.tdt && r.tdt !== "1950-01-01" ? r.tdt : null;
  const individual = !!r.person;
  const party = decodeEntities(individual ? r.person! : (r.bkorg ?? "")).trim();
  const affiliation = individual ? decodeEntities(r.porg ?? "").trim() || null : null;
  let url: string | null = r.url ? r.url.trim() : null;
  if (url && !/^https?:/i.test(url)) url = `${SITE}${url.startsWith("/") ? "" : "/"}${url}`;
  return {
    id: String(r.id),
    effectiveDate: r.edt ?? null,
    terminationDate: term,
    status: term ? "terminated" : "active",
    actionType: (r.type ?? "").trim(),
    party,
    partyKind: individual ? "individual" : "institution",
    affiliation,
    state: parseState(individual ? r.porg : r.bkorg),
    url,
    docType: r.urlname ?? null,
    note: r.note ? decodeEntities(r.note) : null,
  };
}

async function loadJson(url: string): Promise<EnforcementAction[]> {
  const text = await fetchText(url, 30000, 2, "application/json");
  const parsed = JSON.parse(text) as { eaitems?: RawItem[] };
  const items = (parsed.eaitems ?? []).filter((r) => r && r.id != null && (r.bkorg || r.person));
  return items.map(normalize);
}

export function loadRecent(): Promise<EnforcementAction[]> {
  return cached("fedboard:ea-recent", 6 * HOUR, () => loadJson(RECENT_URL));
}
export function loadOld(): Promise<EnforcementAction[]> {
  return cached("fedboard:ea-old", 24 * HOUR, () => loadJson(OLD_URL));
}

export async function fedEnforcementActions(args: {
  name?: string;
  state?: string;
  actionType?: string;
  status?: string;
  since?: string;
  sinceDays?: number;
  includeIndividuals?: boolean;
  includeHistorical?: boolean;
  limit?: number;
}) {
  const limit = clampInt(args.limit, 15, 1, 25);
  const kws = String(args.name ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const state = args.state ? String(args.state).trim().toUpperCase() : null;
  const stateCode = state ? (STATE_CODES.has(state) ? state : STATE_NAMES[state.toLowerCase()] ?? null) : null;
  if (state && !stateCode) throw new Error(`Unrecognized state '${args.state}' — use a two-letter code such as IL`);
  const typeKw = args.actionType ? String(args.actionType).toLowerCase() : null;
  const status = args.status ? String(args.status).toLowerCase() : "all";
  if (!["all", "active", "terminated"].includes(status)) throw new Error("status must be all | active | terminated");
  let since: string | null = args.since ? String(args.since) : null;
  if (!since && args.sinceDays != null) since = isoDaysAgo(clampInt(args.sinceDays, 365, 1, 20000));
  if (since && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(since)) throw new Error("since must be YYYY, YYYY-MM or YYYY-MM-DD");
  const includeIndividuals = args.includeIndividuals !== false;
  // Historical file is large; pull it only when asked or when the query is name-specific / dated before 2019.
  const wantOld = args.includeHistorical === true || (kws.length > 0 && args.includeHistorical !== false) || (since != null && since < "2019");

  let rows: EnforcementAction[];
  let sourceNote: string;
  try {
    const recent = await loadRecent();
    rows = wantOld ? recent.concat(await loadOld()) : recent;
    sourceNote = wantOld ? "ea-cms-recent.json + ea-old.json" : "ea-cms-recent.json (2019→today; set includeHistorical for pre-2019)";
  } catch (err) {
    // Fallback: RSS feed of enforcement press releases.
    const feed = await loadFeed("enforcement");
    const items = feed
      .filter((f) => !kws.length || kws.every((k) => f.title.toLowerCase().includes(k)))
      .slice(0, limit)
      .map((f) => ({ date: f.date, title: f.title, url: f.link }));
    return {
      source: "Federal Reserve Board press_enforcement.xml (fallback — enforcement JSON unavailable)",
      fetchedAt: new Date().toISOString(),
      warning: err instanceof Error ? err.message : String(err),
      matched: items.length,
      actions: items,
    };
  }

  let matched = rows.filter((r) => {
    if (!includeIndividuals && r.partyKind === "individual") return false;
    if (status !== "all" && r.status !== status) return false;
    if (stateCode && r.state !== stateCode) return false;
    if (since && (r.effectiveDate ?? "") < since) return false;
    if (typeKw && !r.actionType.toLowerCase().includes(typeKw)) return false;
    if (kws.length) {
      const hay = `${r.party} ${r.affiliation ?? ""}`.toLowerCase();
      if (!kws.every((k) => hay.includes(k))) return false;
    }
    return true;
  });
  matched.sort((a, b) => (b.effectiveDate ?? "").localeCompare(a.effectiveDate ?? ""));
  const byType: Record<string, number> = {};
  for (const r of matched) byType[r.actionType] = (byType[r.actionType] ?? 0) + 1;
  const dedupeIds = new Set<string>();
  matched = matched.filter((r) => (dedupeIds.has(r.id) ? false : (dedupeIds.add(r.id), true)));

  return {
    source: `Federal Reserve Board enforcement actions (${sourceNote})`,
    fetchedAt: new Date().toISOString(),
    filters: { name: args.name ?? null, state: stateCode, actionType: args.actionType ?? null, status, since, includeIndividuals },
    matched: matched.length,
    byActionType: Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t, n]) => ({ type: t, n })),
    actions: matched.slice(0, limit).map((r) => ({
      effectiveDate: r.effectiveDate,
      terminationDate: r.terminationDate ?? undefined,
      status: r.status,
      actionType: r.actionType,
      party: r.party,
      partyKind: r.partyKind,
      affiliation: r.affiliation ?? undefined,
      state: r.state ?? undefined,
      url: r.url ?? undefined,
      note: r.note ?? undefined,
    })),
    note: "Board actions only (state member banks, BHCs, FBOs, individuals). OCC/FDIC/CFPB actions are published separately.",
  };
}
