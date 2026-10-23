/**
 * FinCEN MSB Registrant Search — full registrant list.
 *
 * The public page https://www.fincen.gov/msb-registrant-search iframes
 * https://msb.fincen.gov/ (PHP). The "download all registrants" export is a
 * POST (verified 2026-10-22):
 *   POST https://msb.fincen.gov/retrieve.msb.list.php   body: site=AA
 *   → 200, Content-Type application/vnd.ms-excell (sic), ~5.4 MB, actually a
 *     UTF-8 TAB-separated text file: 1 header row, ~34k registrant rows, then a
 *     blank line and a legend/disclaimer trailer that must be dropped.
 * Columns: LEGAL NAME | DBA NAME | STREET ADDRESS | CITY | STATE | ZIP | MSB ACTIVITIES
 *          | STATES OF MSB ACTIVITIES | ALL STATES & TERRITORIES & FOREIGN FLAG** | FOREIGN LOCATION
 *          | # OF BRANCHES | AUTH SIGN DATE | RECEIVED DATE
 * ZIP arrives Excel-quoted ("'60521"). Activity codes are the Form 107 key below.
 * The older guessed path fincen.gov/sites/default/files/shared/msb_list.csv is a 404.
 * Only CURRENT registrations are listed (registrations lapse after 2 years).
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, clampInt, HOUR, nameScore, prepareName, str, usDateToIso } from "./common";

const URL = "https://msb.fincen.gov/retrieve.msb.list.php";
const TTL = 24 * HOUR;

export const MSB_ACTIVITY: Record<string, string> = {
  "401": "Issuer of traveler's checks",
  "402": "Seller of traveler's checks",
  "403": "Redeemer of traveler's checks",
  "404": "Issuer of money orders",
  "405": "Seller of money orders",
  "406": "Redeemer of money orders",
  "407": "Currency dealer or exchanger",
  "408": "Check casher",
  "409": "Money transmitter",
  "410": "Traveler's checks sales and/or redemption",
  "411": "Money orders sales and/or redemption",
  "412": "U.S. Postal Service",
  "413": "Seller of prepaid access",
  "414": "Provider of prepaid access",
  "415": "Dealer in foreign exchange",
  "499": "Other",
};

const SCOPE_FLAG: Record<string, string> = { A: "All states, territories and foreign", B: "All states", C: "All territories", D: "Foreign" };

export interface MsbRow {
  legalName: string;
  dba: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  activityCodes: string[];
  activityStates: string[];
  scopeFlag: string | null;
  foreignLocation: string | null;
  branches: number | null;
  authSignDate: string | null;
  receivedDate: string | null;
}

interface MsbDataset {
  rows: MsbRow[];
  fetchedAt: string;
  lastModified: string | null;
}

export function loadMsb(): Promise<MsbDataset> {
  return cached("fincen:msb", TTL, async () => {
    const res = await politeFetch(URL, {
      method: "POST",
      body: "site=AA",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "*/*" },
      timeoutMs: 45000,
      retries: 2,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(URL)} (FinCEN MSB export)`);
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8").replace(/^﻿/, "");
    const lines = text.split(/\r?\n/);
    const header = (lines[0] ?? "").toUpperCase();
    if (!header.startsWith("LEGAL NAME")) throw new Error(`FinCEN MSB export: unexpected first line "${lines[0]?.slice(0, 60)}"`);
    const rows: MsbRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) break; // trailer (legend + disclaimer) follows the first blank line
      const c = line.split("\t");
      if (c.length < 8) continue;
      const n = (v: string | undefined) => {
        const s = str(v);
        return s ? s : null;
      };
      const zip = n(c[5])?.replace(/^'/, "") ?? null;
      const branches = Number(str(c[10]));
      rows.push({
        legalName: str(c[0]),
        dba: n(c[1]),
        street: n(c[2]),
        city: n(c[3]),
        state: n(c[4]),
        zip,
        activityCodes: str(c[6]).split(/\s+/).filter(Boolean),
        activityStates: str(c[7]).split(/\s+/).filter(Boolean),
        scopeFlag: n(c[8]),
        foreignLocation: n(c[9]),
        branches: Number.isFinite(branches) ? branches : null,
        authSignDate: usDateToIso(c[11]),
        receivedDate: usDateToIso(c[12]),
      });
    }
    if (rows.length < 5000) throw new Error(`FinCEN MSB export parsed only ${rows.length} rows — format may have changed`);
    return {
      rows,
      fetchedAt: new Date().toISOString(),
      lastModified: res.headers.get("last-modified"),
    };
  });
}

function compact(r: MsbRow) {
  return {
    legalName: r.legalName,
    dba: r.dba ?? undefined,
    address: [r.street, r.city, r.state, r.zip].filter(Boolean).join(", "),
    state: r.state,
    zip: r.zip,
    foreignLocation: r.foreignLocation ?? undefined,
    activities: r.activityCodes.map((c) => MSB_ACTIVITY[c] ?? c),
    activityScope: r.scopeFlag
      ? r.scopeFlag.split("").map((f) => SCOPE_FLAG[f] ?? f).join(" + ")
      : r.activityStates.length > 12
        ? `${r.activityStates.length} states`
        : r.activityStates.join(" "),
    branches: r.branches,
    registeredDate: r.authSignDate,
    receivedDate: r.receivedDate !== r.authSignDate ? r.receivedDate : undefined,
  };
}

export async function fincenMsbSearch(args: any) {
  const name = str(args?.name);
  const state = str(args?.state).toUpperCase();
  const zip = str(args?.zip).replace(/\D/g, "").slice(0, 5);
  const city = str(args?.city).toLowerCase();
  const activity = str(args?.activity);
  if (!name && !state && !zip && !city) throw new Error("fincen_msb_search: pass at least one of `name`, `state`, `zip`, `city`");
  const limit = clampInt(args?.limit, 15, 1, 25);
  const minScore = clampInt(args?.minScore, 85, 1, 100);
  const ds = await loadMsb();

  const actCode = activity ? Object.entries(MSB_ACTIVITY).find(([code, label]) => code === activity || label.toLowerCase().includes(activity.toLowerCase()))?.[0] : null;
  if (activity && !actCode) throw new Error(`fincen_msb_search: unknown activity "${activity}" — use a code (401–499) or words like "money transmitter", "check casher", "prepaid"`);

  const q = name ? prepareName(name, true) : null;
  const hits: Array<{ row: MsbRow; score: number }> = [];
  for (const r of ds.rows) {
    if (state && r.state !== state) continue;
    if (zip && !(r.zip ?? "").startsWith(zip)) continue;
    if (city && (r.city ?? "").toLowerCase() !== city) continue;
    if (actCode && !r.activityCodes.includes(actCode)) continue;
    let score = 100;
    if (q) {
      score = nameScore(q, prepareName(r.legalName, true));
      if (score < 100 && r.dba) score = Math.max(score, nameScore(q, prepareName(r.dba.replace(/\bdba\b/gi, " "), true)));
      if (score < minScore) continue;
    }
    hits.push({ row: r, score });
  }
  hits.sort((a, b) => b.score - a.score || (b.row.authSignDate ?? "").localeCompare(a.row.authSignDate ?? ""));
  return {
    source: "FinCEN MSB Registrant Search full-list export (msb.fincen.gov)",
    fetchedAt: ds.fetchedAt,
    registrantsOnFile: ds.rows.length,
    query: { name: name || null, state: state || null, zip: zip || null, city: city || null, activity: actCode ? MSB_ACTIVITY[actCode] : null, minScore: q ? minScore : null },
    matchCount: hits.length,
    verdict: name ? (hits.length ? (hits[0]!.score >= 95 ? "REGISTERED_MATCH" : "POSSIBLE_MATCH_REVIEW") : "NOT_FOUND") : undefined,
    results: hits.slice(0, limit).map((h) => ({ score: q ? h.score : undefined, ...compact(h.row) })),
    note: "List contains CURRENT registrations only (MSB registrations lapse every 2 years). Absence ≠ unregistered if the business is exempt (e.g. agents, banks).",
  };
}
