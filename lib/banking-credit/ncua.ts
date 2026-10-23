/**
 * NCUA credit-union data (keyless, live).
 *
 * 1) Mapping / Research-a-Credit-Union API behind https://mapping.ncua.gov
 *    (Angular SPA; endpoints recovered from its bundle, verified 2026-10-22):
 *      POST /api/ResearchCreditUnion/GetDetailSearch
 *           {cuName,city,state,zipCode,cuType("1"=FCU,"2"=FISCU),cuStatus("A"|"I"),fomType,lowIncome,isMdi,skip,take}
 *           -> {totalResultCount, results:[{charterNumber,name,city,state,isCorporate,isActive}]}
 *      POST /api/ResearchCreditUnion/GetQuickSearch {charter:<int>,skip,take}
 *      POST /api/Search/GetSearchLocations  (branch locator, radius search)
 *           {searchText:"60521", rdSearchType:"zipcode"|"cuname"|"cunumber"|"address"|"city"|"state",
 *            rdSearchRadiusList:<miles>, is_*:false..., skip, take, sort_item, sort_direction}
 *           -> {latitude,longitude,valid,list:[{creditUnionName,creditUnionNumber,creditUnionSiteName,
 *               isMainOffice,street,city,state,zipcode,phone,url,distance,siteFunctions,...}],totalResults}
 *      GET  /api/CreditUnionDetails/GetCreditUnionDetails/<charter>
 *           -> profile: assets, members, type, status, charter year, FOM, peer group, address,
 *              website, CEO, callReportCycleDates{...}
 *      GET  /api/DataQuery/GetCurrentCycle -> "2026-06-30T00:00:00"
 *    GetCreditUnionDetails answers in ~0.3 s. GetDetailSearch ignores empty strings but
 *    city match is exact-ish uppercase; zipCode matches the charter's mailing ZIP only.
 *
 * 2) 5300 Call Report quarterly zip:
 *      https://ncua.gov/files/publications/analysis/call-report-data-YYYY-MM.zip (~8 MB)
 *    Pipe-free CSV text files; we read FOICU.txt (identity), FS220.txt / FS220A.txt
 *    (core balance sheet + income) and FS220L.txt (real-estate detail). Accounts are
 *    documented in AcctDesc.txt. YTD income items are annualized here using the cycle
 *    quarter. Data is final ~8 weeks after quarter-end; "current cycle" per the API.
 *
 * The FPR site (fpr.ncua.gov) and GetDownloadCallReport only return PDFs — not used.
 */
import AdmZip from "adm-zip";
import { politeFetch, jsonFetch, redactUrl } from "../data/http";
import { cached, HOUR, round, clampInt, fetchBuffer } from "../research/common";

const MAP = "https://mapping.ncua.gov/api";
const SOURCE_MAP = "NCUA Credit Union Locator / Research API (mapping.ncua.gov, live, keyless)";
const SOURCE_CR = "NCUA 5300 Call Report quarterly data (ncua.gov/analysis, keyless)";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${MAP}${path}`;
  const res = await politeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20000,
    retries: 2,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`NCUA HTTP ${res.status} from ${redactUrl(url)}: ${text.slice(0, 160)}`);
  try { return JSON.parse(text) as T; } catch { throw new Error(`NCUA returned non-JSON from ${path}`); }
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Profile                                                              */
/* ------------------------------------------------------------------ */

export interface CuProfile {
  charter: number;
  name: string;
  type: string | null;
  status: string | null;
  isCorporate: boolean;
  chartered: string | null;
  insuredSince: string | null;
  charterState: string | null;
  region: string | null;
  fieldOfMembership: string | null;
  lowIncomeDesignated: boolean | null;
  fhlbMember: boolean | null;
  peerGroup: string | null;
  totalAssets: number | null;
  members: number | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  phone: string | null;
  website: string | null;
  ceo: string | null;
  latestCallReportCycle: string | null;
}

export function loadProfile(charter: number): Promise<CuProfile | null> {
  return cached(`ncua:profile:${charter}`, 12 * HOUR, async () => {
    const url = `${MAP}/CreditUnionDetails/GetCreditUnionDetails/${charter}`;
    const res = await politeFetch(url, { timeoutMs: 15000, retries: 2 });
    if (res.status === 404) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`NCUA profile HTTP ${res.status} for charter ${charter}`);
    const d = JSON.parse(text);
    if (!d || d.isError || !d.creditUnionName) return null;
    const cycles = d.callReportCycleDates && typeof d.callReportCycleDates === "object" ? Object.values(d.callReportCycleDates) as string[] : [];
    return {
      charter,
      name: String(d.creditUnionName).trim(),
      type: d.creditUnionType || null,
      status: d.creditUnionStatus || null,
      isCorporate: !!d.isCorpCu,
      chartered: d.creditUnionIssuedDate || d.creditUnionYear || null,
      insuredSince: d.creditUnionInsuredDate || null,
      charterState: d.creditUnionCharterState || null,
      region: d.creditUnionRegion || null,
      fieldOfMembership: d.creditUnionFom || null,
      lowIncomeDesignated: d.creditUnionIli == null ? null : /^y/i.test(String(d.creditUnionIli)),
      fhlbMember: d.creditUnionFhlb == null ? null : /^y/i.test(String(d.creditUnionFhlb)),
      peerGroup: d.creditUnionPeerGroup || null,
      totalAssets: num(d.creditUnionAssets),
      members: num(d.creditUnionNom),
      address: [d.creditUnionAddress, d.creditUnionAddress2].filter((x) => x && String(x).trim()).join(", ") || null,
      city: d.creditUnionCity || null,
      state: d.creditUnionState || null,
      zip: d.creditUnionZip || null,
      county: d.creditUnionCounty || null,
      phone: d.phoneFormatted || d.creditUnionPhone || null,
      website: d.creditUnionWebsite || null,
      ceo: d.creditUnionCeo || null,
      latestCallReportCycle: cycles[0] ?? null,
    };
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* ncua_credit_union_search                                             */
/* ------------------------------------------------------------------ */

export interface CuSearchArgs {
  name?: string;
  charter?: number | string;
  state?: string;
  city?: string;
  zip?: string;
  radius_miles?: number;
  type?: "FCU" | "FISCU" | string;
  active_only?: boolean;
  limit?: number;
  include_profile?: boolean;
  sort_by?: "assets" | "members" | "distance" | "name";
}

const PROFILE_FIELDS: (keyof CuProfile)[] = ["type", "status", "chartered", "fieldOfMembership", "lowIncomeDesignated", "peerGroup", "totalAssets", "members", "address", "zip", "county", "phone", "website", "ceo"];

export async function ncuaCreditUnionSearch(args: CuSearchArgs) {
  const limit = clampInt(args.limit, 15, 1, 25);
  const activeOnly = args.active_only !== false;
  const includeProfile = args.include_profile !== false;
  const mode = args.zip ? "radius" : args.charter ? "charter" : "detail";
  let hits: Array<{ charter: number; name: string; city: string | null; state: string | null; isActive: boolean | null; isCorporate: boolean | null; distanceMiles?: number | null; nearestBranch?: any }> = [];
  let total: number | null = null;

  if (mode === "charter") {
    const ch = Number(args.charter);
    if (!Number.isInteger(ch) || ch <= 0) throw new Error("charter must be a positive integer (NCUA charter number)");
    const r = await postJson<any>("/ResearchCreditUnion/GetQuickSearch", { charter: ch, skip: 0, take: 5 });
    total = r?.totalResultCount ?? null;
    hits = (r?.results ?? []).map(mapResult);
  } else if (mode === "radius") {
    const zip = String(args.zip).trim();
    if (!/^\d{5}$/.test(zip)) throw new Error("zip must be a 5-digit ZIP code");
    const radius = [2, 5, 10, 15, 25, 50].includes(Number(args.radius_miles)) ? Number(args.radius_miles) : Number(args.radius_miles) > 0 ? Number(args.radius_miles) : 10;
    const body: any = {
      searchText: zip, rdSearchType: "zipcode", rdSearchRadiusList: radius,
      is_mainOffice: false, is_mdi: false, is_member: false, is_drive: false, is_atm: false, is_itm: false, is_shared: false,
      is_bilingual: false, is_credit_builder: false, is_fin_counseling: false, is_homebuyer: false, is_school: false,
      is_low_wire: false, is_no_draft: false, is_no_tax: false, is_payday: false,
      skip: 0, take: 200, sort_item: "", sort_direction: "asc",
    };
    const r = await postJson<any>("/Search/GetSearchLocations", body);
    if (r && r.valid === false) throw new Error(`NCUA locator could not geocode ZIP ${zip}`);
    total = r?.totalResults ?? null;
    const byCu = new Map<number, any>();
    for (const b of r?.list ?? []) {
      const cu = Number(b.creditUnionNumber);
      if (!cu) continue;
      const prev = byCu.get(cu);
      if (!prev || Number(b.distance) < Number(prev.distance)) byCu.set(cu, b);
    }
    hits = Array.from(byCu.values())
      .sort((a, b) => Number(a.distance) - Number(b.distance))
      .map((b) => ({
        charter: Number(b.creditUnionNumber),
        name: String(b.creditUnionName ?? "").trim(),
        city: b.city ?? null,
        state: b.state ?? null,
        isActive: true,
        isCorporate: null,
        distanceMiles: round(Number(b.distance), 1),
        nearestBranch: {
          site: b.creditUnionSiteName || (b.isMainOffice ? "Main Office" : null),
          isMainOffice: !!b.isMainOffice,
          address: [b.street, b.city, b.state, b.zipcode].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join(", "),
          phone: b.phone || null,
          website: b.url || null,
          services: String(b.siteFunctions ?? "").split(";").map((s) => s.trim()).filter(Boolean),
        },
      }));
    if (args.name) {
      const t = String(args.name).toLowerCase();
      hits = hits.filter((h) => h.name.toLowerCase().includes(t));
    }
  } else {
    if (!args.name && !args.state && !args.city) throw new Error("Provide name, state and/or city (or zip for a radius search, or charter).");
    const typeCode = args.type ? (/^f?i?s?c?u$/i.test(String(args.type)) && /s/i.test(String(args.type)) ? "2" : /fcu|federal/i.test(String(args.type)) ? "1" : null) : null;
    const body = {
      cuName: args.name?.trim() || null,
      city: args.city?.trim().toUpperCase() || null,
      state: args.state?.trim().toUpperCase() || null,
      cuType: typeCode,
      cuStatus: activeOnly ? "A" : null,
      zipCode: null, fomType: null, lowIncome: null, isMdi: null, region: null,
      skip: 0,
      take: Math.max(limit * 3, 50),
    };
    const r = await postJson<any>("/ResearchCreditUnion/GetDetailSearch", body);
    total = r?.totalResultCount ?? null;
    hits = (r?.results ?? []).map(mapResult);
  }

  if (activeOnly) hits = hits.filter((h) => h.isActive !== false);
  hits = hits.filter((h) => !h.isCorporate);
  const candidates = hits.slice(0, Math.max(limit, includeProfile && (args.sort_by === "assets" || args.sort_by === "members") ? Math.min(hits.length, 40) : limit));

  let rows: any[] = candidates;
  if (includeProfile && candidates.length) {
    const profiles = await mapLimit(candidates, 6, async (h) => {
      try { return await loadProfile(h.charter); } catch { return null; }
    });
    rows = candidates.map((h, i) => {
      const p = profiles[i];
      const o: any = { ...h };
      if (p) for (const f of PROFILE_FIELDS) o[f] = p[f];
      if (p?.latestCallReportCycle) o.latestCallReportCycle = p.latestCallReportCycle;
      return o;
    });
  }
  const sortBy = args.sort_by ?? (mode === "radius" ? "distance" : includeProfile ? "assets" : "name");
  if (sortBy === "assets" || sortBy === "members") rows.sort((a, b) => (Number(b[sortBy === "assets" ? "totalAssets" : "members"]) || 0) - (Number(a[sortBy === "assets" ? "totalAssets" : "members"]) || 0));
  else if (sortBy === "name") rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  rows = rows.slice(0, limit);

  return {
    source: SOURCE_MAP,
    fetchedAt: new Date().toISOString(),
    mode,
    request: { name: args.name ?? null, charter: args.charter ?? null, state: args.state ?? null, city: args.city ?? null, zip: args.zip ?? null, radius_miles: mode === "radius" ? (args.radius_miles ?? 10) : null, active_only: activeOnly, sort_by: sortBy },
    totalMatches: total,
    returned: rows.length,
    creditUnions: rows,
    note:
      "totalAssets and members are from the NCUA profile (latest filed 5300 call report; USD and headcount). type FCU = federal charter, FISCU = federally insured state charter. Radius mode uses the branch locator (dedupes branches to one row per credit union, nearest branch shown) — the only way to find credit unions that SERVE an area, since detail search matches the charter's mailing address. Use ncua_call_report with the charter for the full financial summary (net worth ratio, ROA, loan mix, mortgages).",
  };
}

function mapResult(r: any) {
  return {
    charter: Number(r.charterNumber),
    name: String(r.name ?? "").trim(),
    city: r.city && String(r.city).trim() ? String(r.city).trim() : null,
    state: r.state && String(r.state).trim() ? String(r.state).trim() : null,
    isActive: typeof r.isActive === "boolean" ? r.isActive : null,
    isCorporate: typeof r.isCorporate === "boolean" ? r.isCorporate : null,
  };
}

/* ------------------------------------------------------------------ */
/* ncua_call_report                                                     */
/* ------------------------------------------------------------------ */

interface CycleData {
  cycle: string; // YYYY-MM
  cycleDate: string; // YYYY-MM-DD
  quarter: number; // 1..4 (for annualizing YTD income)
  foicu: Map<string, Record<string, string>>;
  fs220: Map<string, Record<string, string>>;
  fs220a: Map<string, Record<string, string>>;
  fs220l: Map<string, Record<string, string>>;
  desc: Map<string, string>;
  url: string;
}

function parseCsvText(text: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  const lines = text.split(/\r?\n/);
  const header = splitLine(lines[0] ?? "").map((h) => h.trim().toUpperCase());
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    const cells = splitLine(ln);
    const rec: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) rec[header[j]!] = (cells[j] ?? "").trim();
    const id = rec.CU_NUMBER;
    if (id) out.set(id, rec);
  }
  return out;
}

function splitLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') { q = !q; continue; }
    if (c === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export async function currentCycle(): Promise<string> {
  return cached("ncua:cycle", 6 * HOUR, async () => {
    try {
      const s = await jsonFetch<string>(`${MAP}/DataQuery/GetCurrentCycle`, { timeoutMs: 10000, retries: 1 });
      const m = String(s).match(/^(\d{4})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}`;
    } catch { /* fall through */ }
    // Fallback: most recent quarter-end at least 60 days old.
    const d = new Date(Date.now() - 60 * 86400000);
    const q = Math.floor(d.getUTCMonth() / 3) * 3; // 0,3,6,9 = first month of quarter
    const endMonth = q === 0 ? 12 : q; // previous quarter end month
    const year = q === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
    return `${year}-${String(endMonth).padStart(2, "0")}`;
  });
}

function prevCycle(c: string): string {
  const [y, m] = c.split("-").map(Number) as [number, number];
  return m === 3 ? `${y - 1}-12` : `${y}-${String(m - 3).padStart(2, "0")}`;
}

export function loadCycle(cycle: string): Promise<CycleData> {
  return cached(`ncua:cr:${cycle}`, 24 * HOUR, async () => {
    const url = `https://ncua.gov/files/publications/analysis/call-report-data-${cycle}.zip`;
    let buf: Buffer;
    try {
      buf = await fetchBuffer(url, 50000, 1);
    } catch (e: any) {
      if (/HTTP 404/.test(String(e?.message))) throw new Error(`NCUA call-report zip for cycle ${cycle} is not published (404). Try the prior quarter (${prevCycle(cycle)}).`);
      throw e;
    }
    const zip = new AdmZip(buf);
    const read = (name: string) => {
      const e = zip.getEntries().find((x) => x.entryName.toLowerCase() === name.toLowerCase());
      if (!e) throw new Error(`NCUA zip ${cycle} missing ${name}`);
      return e.getData().toString("latin1");
    };
    const foicu = parseCsvText(read("FOICU.txt"));
    const fs220 = parseCsvText(read("FS220.txt"));
    const fs220a = parseCsvText(read("FS220A.txt"));
    let fs220l = new Map<string, Record<string, string>>();
    try { fs220l = parseCsvText(read("FS220L.txt")); } catch { /* optional */ }
    const desc = new Map<string, string>();
    try {
      for (const ln of read("AcctDesc.txt").split(/\r?\n/).slice(1)) {
        const c = splitLine(ln);
        if (c[0]) desc.set(c[0].trim().toUpperCase(), (c[1] ?? "").trim());
      }
    } catch { /* optional */ }
    const [y, m] = cycle.split("-").map(Number) as [number, number];
    const quarter = Math.round(m / 3);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { cycle, cycleDate: `${y}-${String(m).padStart(2, "0")}-${lastDay}`, quarter, foicu, fs220, fs220a, fs220l, desc, url };
  });
}

function pick(rec: Record<string, string> | undefined, acct: string): number | null {
  if (!rec) return null;
  const v = rec[acct.toUpperCase()];
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function summarizeCu(cd: CycleData, id: string) {
  const f = cd.foicu.get(id);
  const a = cd.fs220.get(id);
  const b = cd.fs220a.get(id);
  const l = cd.fs220l.get(id);
  if (!f || !a) return null;
  const ann = (v: number | null) => (v == null ? null : (v * 4) / cd.quarter);
  const assets = pick(a, "ACCT_010");
  const loans = pick(a, "ACCT_025B");
  const shares = pick(a, "ACCT_018");
  const members = pick(a, "ACCT_083");
  const netWorth = pick(b, "ACCT_997");
  const nwRatio = pick(b, "ACCT_998");
  const delinq = pick(a, "ACCT_041B");
  const netIncomeYtd = pick(b, "ACCT_661A");
  const intIncomeYtd = pick(b, "ACCT_115");
  const nonIntIncomeYtd = pick(b, "ACCT_117");
  const nonIntExpYtd = pick(a, "ACCT_671");
  const provisionYtd = pick(a, "ACCT_300");
  const dividendsYtd = pick(a, "ACCT_380");
  const intBorrowYtd = pick(a, "ACCT_340");
  const chargeOffsYtd = pick(a, "ACCT_550");
  const recoveriesYtd = pick(a, "ACCT_551");
  const firstMtg = pick(l, "ACCT_703A") ?? pick(a, "ACCT_703");
  const juniorLien = pick(l, "ACCT_386A");
  const otherRe = pick(l, "ACCT_386B");
  const firstMtgRate = pick(l, "ACCT_563A");
  const borrowings = pick(a, "ACCT_860C");
  const uninsured = pick(a, "ACCT_068");
  const loansGrantedYtdAmt = pick(a, "ACCT_031B");
  const loansGrantedYtdN = pick(a, "ACCT_031A");
  const avgAssets = assets; // single-cycle approximation (period-end, not average)
  // NCUA stores Acct_998 (net worth ratio) and loan rates in basis points (917 = 9.17%, 575 = 5.75%).
  const nwr = nwRatio != null ? round(nwRatio / 10000, 4) : netWorth != null && assets ? round(netWorth / assets, 4) : null;

  return {
    charter: Number(id),
    name: f.CU_NAME,
    city: f.CITY,
    state: f.STATE,
    zip: f.ZIP_CODE,
    charterType: f.CU_TYPE === "1" ? "FCU" : f.CU_TYPE === "2" ? "FISCU" : f.CU_TYPE,
    yearOpened: f.YEAR_OPENED ? Number(f.YEAR_OPENED) : null,
    peerGroup: f.PEER_GROUP ?? null,
    lowIncomeDesignated: f.LIMITED_INC === "1",
    isMdi: /true/i.test(f.ISMDI ?? ""),
    rssd: f.RSSD && f.RSSD !== "0" ? Number(f.RSSD) : null,
    balanceSheet: {
      totalAssets: assets,
      totalLoans: loans,
      totalSharesAndDeposits: shares,
      netWorth,
      borrowings,
      uninsuredShares: uninsured,
      members,
      potentialMembers: pick(a, "ACCT_084"),
    },
    ratios: {
      netWorthRatio: nwr,
      netWorthClassification: nwr == null ? null : nwr >= 0.07 ? "Well capitalized (≥7%)" : nwr >= 0.06 ? "Adequately capitalized (6–7%)" : nwr >= 0.04 ? "Undercapitalized (4–6%)" : nwr >= 0.02 ? "Significantly undercapitalized (2–4%)" : "Critically undercapitalized (<2%)",
      loansToShares: loans != null && shares ? round(loans / shares, 4) : null,
      loansToAssets: loans != null && assets ? round(loans / assets, 4) : null,
      delinquencyRatio: delinq != null && loans ? round(delinq / loans, 4) : null,
      netChargeOffRatioAnn: chargeOffsYtd != null && loans ? round((ann(chargeOffsYtd - (recoveriesYtd ?? 0)) ?? 0) / loans, 4) : null,
      roaAnnualized: netIncomeYtd != null && avgAssets ? round((ann(netIncomeYtd) ?? 0) / avgAssets, 4) : null,
      operatingExpenseToAssetsAnn: nonIntExpYtd != null && avgAssets ? round((ann(nonIntExpYtd) ?? 0) / avgAssets, 4) : null,
      costOfFundsAnn: dividendsYtd != null && shares ? round(((ann(dividendsYtd) ?? 0) + (ann(intBorrowYtd) ?? 0)) / ((shares ?? 0) + (borrowings ?? 0) || 1), 4) : null,
      assetsPerMember: assets != null && members ? Math.round(assets / members) : null,
      firstMortgageShareOfLoans: firstMtg != null && loans ? round(firstMtg / loans, 4) : null,
    },
    incomeYtd: {
      quartersInYtd: cd.quarter,
      totalInterestIncome: intIncomeYtd,
      totalNonInterestIncome: nonIntIncomeYtd,
      provisionForLoanLosses: provisionYtd,
      totalNonInterestExpense: nonIntExpYtd,
      dividendsOnShares: dividendsYtd,
      netIncome: netIncomeYtd,
      netIncomeAnnualized: ann(netIncomeYtd) != null ? Math.round(ann(netIncomeYtd)!) : null,
      loansGrantedYtd: { count: loansGrantedYtdN, amount: loansGrantedYtdAmt },
    },
    realEstate: {
      firstLien1to4Family: firstMtg,
      juniorLien1to4Family: juniorLien,
      otherRealEstate: otherRe,
      firstLienAvgRate: firstMtgRate != null ? round(firstMtgRate / 10000, 4) : null,
    },
  };
}

export interface CallReportArgs {
  charter?: number | string;
  name?: string;
  state?: string;
  cycle?: string;
  compare_prior_year?: boolean;
  rank_state?: boolean;
  limit?: number;
}

export async function ncuaCallReport(args: CallReportArgs) {
  const cycleArg = args.cycle ? String(args.cycle).trim() : null;
  if (cycleArg && !/^\d{4}-(03|06|09|12)$/.test(cycleArg)) throw new Error("cycle must be YYYY-MM with MM in 03/06/09/12 (quarter end), e.g. 2026-06");
  let cycle = cycleArg ?? (await currentCycle());
  let cd: CycleData;
  try {
    cd = await loadCycle(cycle);
  } catch (e: any) {
    if (!cycleArg && /not published/.test(String(e?.message))) {
      cycle = prevCycle(cycle);
      cd = await loadCycle(cycle);
    } else throw e;
  }

  // Ranking mode: top credit unions in a state by assets.
  if (args.rank_state || (!args.charter && !args.name && args.state)) {
    const st = String(args.state ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) throw new Error("state (2-letter) is required for ranking mode");
    const limit = clampInt(args.limit, 15, 1, 25);
    const ids = Array.from(cd.foicu.values()).filter((f) => (f.STATE ?? "").toUpperCase() === st).map((f) => f.CU_NUMBER!);
    const rows = ids
      .map((id) => summarizeCu(cd, id))
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => (b.balanceSheet.totalAssets ?? 0) - (a.balanceSheet.totalAssets ?? 0));
    const stateAssets = rows.reduce((s, r) => s + (r.balanceSheet.totalAssets ?? 0), 0);
    const stateMembers = rows.reduce((s, r) => s + (r.balanceSheet.members ?? 0), 0);
    return {
      source: SOURCE_CR,
      fetchedAt: new Date().toISOString(),
      cycle: cd.cycleDate,
      state: st,
      stateTotals: { creditUnions: rows.length, totalAssets: stateAssets, members: stateMembers },
      creditUnions: rows.slice(0, limit).map((r, i) => ({
        rank: i + 1, charter: r.charter, name: r.name, city: r.city, charterType: r.charterType,
        totalAssets: r.balanceSheet.totalAssets, members: r.balanceSheet.members, netWorthRatio: r.ratios.netWorthRatio,
        roaAnnualized: r.ratios.roaAnnualized, loansToShares: r.ratios.loansToShares, delinquencyRatio: r.ratios.delinquencyRatio,
        firstLien1to4Family: r.realEstate.firstLien1to4Family, assetShareOfState: stateAssets ? round((r.balanceSheet.totalAssets ?? 0) / stateAssets, 4) : null,
      })),
      note: "Ranked by total assets from the 5300 call report for the cycle shown (USD). ROA and expense ratios annualize year-to-date income by quarters elapsed. Pass charter (or name) for the full single-credit-union summary.",
    };
  }

  // Resolve a single credit union.
  let id: string | null = null;
  if (args.charter != null && String(args.charter).trim()) {
    id = String(Number(args.charter));
    if (!cd.foicu.has(id)) throw new Error(`Charter ${id} not in the ${cd.cycleDate} call report (merged/liquidated, corporate CU, or wrong number). Use ncua_credit_union_search to find the charter.`);
  } else if (args.name && String(args.name).trim()) {
    const terms = String(args.name).toUpperCase().split(/\s+/).filter(Boolean);
    const st = args.state ? String(args.state).trim().toUpperCase() : null;
    const cands = Array.from(cd.foicu.values())
      .filter((f) => terms.every((t) => (f.CU_NAME ?? "").toUpperCase().includes(t)) && (!st || (f.STATE ?? "").toUpperCase() === st))
      .map((f) => ({ f, assets: pick(cd.fs220.get(f.CU_NUMBER!), "ACCT_010") ?? 0 }))
      .sort((x, y) => y.assets - x.assets);
    if (!cands.length) throw new Error(`No credit union named like "${args.name}"${st ? ` in ${st}` : ""} in the ${cd.cycleDate} call report. Try a shorter name or ncua_credit_union_search.`);
    id = cands[0]!.f.CU_NUMBER!;
    if (cands.length > 1) {
      (args as any).__alternates = cands.slice(1, 6).map((c) => ({ charter: Number(c.f.CU_NUMBER), name: c.f.CU_NAME, city: c.f.CITY, state: c.f.STATE, totalAssets: c.assets }));
    }
  } else {
    throw new Error("Provide charter (NCUA charter number), name (+ optional state), or state alone to rank the state's credit unions by assets.");
  }

  const cur = summarizeCu(cd, id)!;
  let prior: any = null;
  let growth: any = null;
  if (args.compare_prior_year) {
    const [y, m] = cd.cycle.split("-");
    const pc = `${Number(y) - 1}-${m}`;
    try {
      const pd = await loadCycle(pc);
      const p = summarizeCu(pd, id);
      if (p) {
        prior = { cycle: pd.cycleDate, totalAssets: p.balanceSheet.totalAssets, totalLoans: p.balanceSheet.totalLoans, totalSharesAndDeposits: p.balanceSheet.totalSharesAndDeposits, members: p.balanceSheet.members, netWorthRatio: p.ratios.netWorthRatio, roaAnnualized: p.ratios.roaAnnualized, firstLien1to4Family: p.realEstate.firstLien1to4Family };
        const g = (a: number | null, b: number | null) => (a != null && b ? round(a / b - 1, 4) : null);
        growth = {
          assets: g(cur.balanceSheet.totalAssets, p.balanceSheet.totalAssets),
          loans: g(cur.balanceSheet.totalLoans, p.balanceSheet.totalLoans),
          shares: g(cur.balanceSheet.totalSharesAndDeposits, p.balanceSheet.totalSharesAndDeposits),
          members: g(cur.balanceSheet.members, p.balanceSheet.members),
          firstMortgages: g(cur.realEstate.firstLien1to4Family, p.realEstate.firstLien1to4Family),
        };
      }
    } catch (e: any) {
      prior = { error: String(e?.message ?? e).slice(0, 160) };
    }
  }

  // Peer context within the state (rank by assets).
  const st = cur.state;
  const stateIds = Array.from(cd.foicu.values()).filter((f) => f.STATE === st).map((f) => f.CU_NUMBER!);
  const stateAssets = stateIds.map((x) => pick(cd.fs220.get(x), "ACCT_010") ?? 0).sort((a, b) => b - a);
  const rank = stateAssets.findIndex((v) => v <= (cur.balanceSheet.totalAssets ?? 0)) + 1;

  return {
    source: SOURCE_CR,
    fetchedAt: new Date().toISOString(),
    cycle: cd.cycleDate,
    sourceUrl: cd.url,
    creditUnion: cur,
    stateContext: { state: st, creditUnionsInState: stateIds.length, assetRankInState: rank || null },
    ...(prior ? { priorYear: prior, yoyGrowth: growth } : {}),
    ...((args as any).__alternates ? { otherNameMatches: (args as any).__alternates } : {}),
    note:
      "USD; headcounts for members. Ratios: netWorthRatio = net worth / assets (NCUA well-capitalized ≥ 7%); ROA, operating-expense and charge-off ratios annualize YTD flows by quarters elapsed and use period-end assets (not averages), so they differ slightly from NCUA FPR figures. realEstate.firstLien1to4Family is the residential first-mortgage book (incl. HELOCs in first position); firstLienAvgRate is a decimal (0.0575 = 5.75%). All ratios are decimals. Set compare_prior_year for YoY growth (downloads one more ~8 MB quarterly file, cached 24 h).",
  };
}
