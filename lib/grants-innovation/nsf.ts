/**
 * NSF Awards API v1 — https://api.nsf.gov/services/v1/awards.json (GET, keyless).
 * Params verified live: keyword, piFirstName, piLastName, awardeeName,
 * awardeeCity, awardeeStateCode, dateStart/dateEnd (MM/DD/YYYY), rpp (≤25),
 * offset (0-based RECORD offset — offset=1 skips the first record), printFields
 * (comma list; abstractText is returned regardless and is dropped here).
 * response.metadata.totalCount is the hit count. activeAwd is NOT a valid
 * filter param (400) — filtered client-side. Amounts are whole USD strings.
 */
import { cached, clampInt, HOUR, iso, jsonGet, sumBy, toNum, trunc } from "./common";

const BASE = "https://api.nsf.gov/services/v1/awards.json";
const PRINT = [
  "id", "title", "piFirstName", "piLastName", "piEmail", "awardeeName", "awardeeCity", "awardeeStateCode",
  "awardeeZipCode", "fundsObligatedAmt", "estimatedTotalAmt", "startDate", "expDate", "date", "fundProgramName",
  "dirAbbr", "divAbbr", "transType", "activeAwd", "ueiNumber", "perfLocation", "perfCity",
].join(",");

export async function nsfAwardsSearch(args: any) {
  const q = new URLSearchParams();
  const limit = clampInt(args?.limit, 15, 1, 25);
  if (args?.keyword) q.set("keyword", String(args.keyword));
  if (args?.pi_first_name) q.set("piFirstName", String(args.pi_first_name));
  if (args?.pi_last_name) q.set("piLastName", String(args.pi_last_name));
  if (args?.awardee_name) q.set("awardeeName", `"${String(args.awardee_name).replace(/"/g, "")}"`);
  if (args?.city) q.set("awardeeCity", String(args.city));
  if (args?.state) q.set("awardeeStateCode", String(args.state).toUpperCase());
  if (args?.start_date_from) q.set("dateStart", usDate(args.start_date_from));
  if (args?.start_date_to) q.set("dateEnd", usDate(args.start_date_to));
  if (![...q.keys()].length) throw new Error("nsf_awards_search needs at least one of keyword, pi_last_name, awardee_name, city+state");
  q.set("rpp", String(limit));
  q.set("offset", String(clampInt(args?.offset, 0, 0, 100000)));
  q.set("printFields", PRINT);

  const url = `${BASE}?${q.toString()}`;
  const data = await cached(`nsf:${url}`, 12 * HOUR, () => jsonGet<any>(url));
  if (data?.response?.serviceNotification) {
    const n = data.response.serviceNotification[0] ?? data.response.serviceNotification;
    throw new Error(`NSF API: ${n?.notificationMessage ?? JSON.stringify(n).slice(0, 200)}`);
  }
  let rows = (data?.response?.award ?? []).map((a: any) => ({
    awardId: a.id,
    title: trunc(a.title, 140),
    pi: [a.piFirstName, a.piLastName].filter(Boolean).join(" ") || null,
    piEmail: a.piEmail || null,
    awardee: a.awardeeName ?? null,
    city: a.awardeeCity ?? null,
    state: a.awardeeStateCode ?? null,
    zip: a.awardeeZipCode ?? null,
    uei: a.ueiNumber || null,
    fundsObligated: toNum(a.fundsObligatedAmt),
    estimatedTotal: toNum(a.estimatedTotalAmt),
    start: iso(a.startDate),
    expires: iso(a.expDate),
    awardedOn: iso(a.date),
    program: a.fundProgramName ?? null,
    directorate: [a.dirAbbr, a.divAbbr].filter(Boolean).join("/") || null,
    type: a.transType ?? null,
    active: a.activeAwd === "true",
    url: `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${a.id}`,
  }));
  if (args?.active_only) rows = rows.filter((r: any) => r.active);
  return {
    source: "NSF Awards API v1 (api.nsf.gov)",
    fetchedAt: new Date().toISOString(),
    query: Object.fromEntries([...q.entries()].filter(([k]) => k !== "printFields")),
    total: data?.response?.metadata?.totalCount ?? null,
    returned: rows.length,
    pageObligated: Math.round(rows.reduce((s: number, r: any) => s + (r.fundsObligated ?? 0), 0)),
    totalsByAwardee: sumBy(rows, (r: any) => r.awardee, (r: any) => r.fundsObligated, 8),
    totalsByPi: sumBy(rows, (r: any) => r.pi, (r: any) => r.fundsObligated, 8),
    awards: rows,
    note: "Page with offset (0-based record offset) in steps of limit. active_only filters the returned page only. fundsObligated = cumulative obligations to date, estimatedTotal = full planned award.",
  };
}

function usDate(v: unknown): string {
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
}
