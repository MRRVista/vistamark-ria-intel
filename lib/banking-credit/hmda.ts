/**
 * HMDA (Home Mortgage Disclosure Act) via the CFPB/FFIEC Data Browser API.
 *
 *   Aggregations: https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations
 *     ?years=2024&counties=17043&actions_taken=1[&loan_purposes=1,31,32]
 *     Rules (verified live 2026-10-22): years + exactly one geography family
 *     (counties | states | msamds) and/or leis, PLUS at least ONE and at most
 *     TWO "HMDA data" filters (actions_taken, loan_purposes, loan_types,
 *     dwelling_categories, total_units, lien_statuses, loan_products,
 *     construction_methods, races, sexes, ethnicities). Zero filters -> 400
 *     "provide-atleast-one-filter-criteria"; three -> 400
 *     "provide-two-or-less-filter-criteria". Multi-valued filters return one
 *     aggregation row per value combination (count + sum of loan_amount, $).
 *     Responses are gzip-encoded; fetch() transparently inflates.
 *   Loan-level CSV: /view/csv?years=2024&counties=17043&actions_taken=1
 *     -> 301 to files.ffiec.cfpb.gov/.../<hash>.csv (DuPage 2024: 6.1 MB /
 *     15,885 rows; Cook 2024: 28 MB / 73k rows). Streamed and reduced by LEI.
 *   Filers: /view/filers?years=2024 -> {institutions:[{lei,name,count}]} (~120 KB).
 *   Institutions: https://ffiec.cfpb.gov/v2/public/institutions/<lei>/year/<year>
 *
 * All keyless. Annual data; year N publishes ~June N+1 (2025 is partially
 * visible via quarterly filers). Public LAR loan_amount is the $10k-bucket
 * midpoint, so sums are approximate (+/- ~1%).
 */
import { politeFetch, jsonFetch, redactUrl } from "../data/http";
import { cached, HOUR, round, clampInt } from "../research/common";

const API = "https://ffiec.cfpb.gov/v2/data-browser-api/view";
const INST = "https://ffiec.cfpb.gov/v2/public/institutions";
const SOURCE = "CFPB/FFIEC HMDA Data Browser API (ffiec.cfpb.gov, live, keyless)";

/** FHFA baseline conforming loan limit (1-unit, contiguous US) by HMDA activity year. */
export const CONFORMING_LIMIT: Record<number, number> = {
  2018: 453100, 2019: 484350, 2020: 510400, 2021: 548250, 2022: 647200,
  2023: 726200, 2024: 766550, 2025: 806500, 2026: 832750,
};

const DATA_FILTERS = [
  "actions_taken", "loan_purposes", "loan_types", "dwelling_categories", "total_units",
  "lien_statuses", "loan_products", "construction_methods", "races", "sexes", "ethnicities",
] as const;
type DataFilter = (typeof DATA_FILTERS)[number];

const CODEBOOK: Record<string, Record<string, string>> = {
  actions_taken: { "1": "Originated", "2": "Approved not accepted", "3": "Denied", "4": "Withdrawn", "5": "Incomplete", "6": "Purchased", "7": "Preapproval denied", "8": "Preapproval approved not accepted" },
  loan_purposes: { "1": "Home purchase", "2": "Home improvement", "31": "Refinancing", "32": "Cash-out refinancing", "4": "Other", "5": "Not applicable" },
  loan_types: { "1": "Conventional", "2": "FHA", "3": "VA", "4": "USDA/FSA-RHS" },
  lien_statuses: { "1": "First lien", "2": "Subordinate lien" },
  construction_methods: { "1": "Site-built", "2": "Manufactured" },
};

const AGENCY: Record<number, string> = { 1: "OCC", 2: "Federal Reserve", 3: "FDIC", 5: "NCUA", 7: "HUD", 9: "CFPB" };

function csvList(v: unknown): string | null {
  if (v == null || v === "") return null;
  const arr = Array.isArray(v) ? v : String(v).split(",");
  const out = arr.map((x) => String(x).trim()).filter(Boolean);
  return out.length ? out.join(",") : null;
}

function parseYears(v: unknown, def = 2024): number[] {
  const list = csvList(v);
  const ys = (list ? list.split(",") : [String(def)]).map((y) => Number(y)).filter((y) => Number.isInteger(y) && y >= 2018 && y <= 2026);
  if (!ys.length) throw new Error("years: provide one or more HMDA activity years between 2018 and 2025 (e.g. 2024 or [2022,2023,2024])");
  return Array.from(new Set(ys)).sort();
}

function label(filter: string, code: string): string {
  return CODEBOOK[filter]?.[code] ?? code;
}

/* ------------------------------------------------------------------ */
/* Filers / lender names                                                */
/* ------------------------------------------------------------------ */

export interface Filer { lei: string; name: string; count: number }

export function loadFilers(year: number): Promise<Map<string, Filer>> {
  return cached(`hmda:filers:${year}`, 24 * HOUR, async () => {
    const raw = await jsonFetch<any>(`${API}/filers?years=${year}`, { timeoutMs: 20000 });
    const m = new Map<string, Filer>();
    for (const i of raw?.institutions ?? []) {
      if (i?.lei) m.set(String(i.lei).toUpperCase(), { lei: String(i.lei).toUpperCase(), name: String(i.name ?? ""), count: Number(i.count) || 0 });
    }
    if (!m.size) throw new Error(`HMDA filers list for ${year} came back empty — year may not be published yet`);
    return m;
  });
}

/* ------------------------------------------------------------------ */
/* hmda_aggregations                                                    */
/* ------------------------------------------------------------------ */

export interface HmdaAggArgs {
  years?: unknown;
  counties?: unknown;
  states?: unknown;
  msamds?: unknown;
  leis?: unknown;
  actions_taken?: unknown;
  loan_purposes?: unknown;
  loan_types?: unknown;
  dwelling_categories?: unknown;
  total_units?: unknown;
  lien_statuses?: unknown;
  loan_products?: unknown;
  construction_methods?: unknown;
  races?: unknown;
  sexes?: unknown;
  ethnicities?: unknown;
  resolve_names?: boolean;
}

export async function hmdaAggregations(args: HmdaAggArgs) {
  const years = parseYears(args.years);
  const geo: Record<string, string> = {};
  for (const g of ["counties", "states", "msamds"] as const) {
    const v = csvList(args[g]);
    if (v) geo[g] = g === "states" ? v.toUpperCase() : v;
  }
  const leis = csvList(args.leis)?.toUpperCase() ?? null;
  if (Object.keys(geo).length > 1) throw new Error("Provide only ONE geography family per call: counties (5-digit FIPS), states (2-letter) or msamds (5-digit MSA/MD).");
  if (!Object.keys(geo).length && !leis) throw new Error("Provide a geography (counties=17043 | states=IL | msamds=16984) and/or leis.");

  const filters: Record<string, string> = {};
  for (const f of DATA_FILTERS) {
    const v = csvList(args[f as keyof HmdaAggArgs]);
    if (v) filters[f] = v;
  }
  if (!Object.keys(filters).length) filters.actions_taken = "1";
  const fkeys = Object.keys(filters) as DataFilter[];
  if (fkeys.length > 2) {
    throw new Error(`HMDA aggregations accept at most TWO data filters per call; you passed ${fkeys.length} (${fkeys.join(", ")}). Drop one, or run separate calls.`);
  }

  const buildUrl = (year: number) => {
    const p = new URLSearchParams({ years: String(year) });
    for (const [k, v] of Object.entries(geo)) p.set(k, v);
    if (leis) p.set("leis", leis);
    for (const [k, v] of Object.entries(filters)) p.set(k, v);
    return `${API}/aggregations?${p.toString()}`;
  };

  const perYear = await Promise.all(
    years.map((year) =>
      cached(`hmda:agg:${buildUrl(year)}`, 12 * HOUR, async () => {
        const url = buildUrl(year);
        const res = await politeFetch(url, { timeoutMs: 25000, retries: 2 });
        const text = await res.text();
        if (!res.ok) {
          let msg = text.slice(0, 200);
          try { msg = JSON.parse(text)?.message ?? msg; } catch { /* keep raw */ }
          throw new Error(`HMDA aggregations HTTP ${res.status} for ${year}: ${msg} (${redactUrl(url)})`);
        }
        return { year, body: JSON.parse(text) as any };
      })
    )
  );

  const rows: any[] = [];
  const totals = { count: 0, sumLoanAmount: 0 };
  for (const { year, body } of perYear) {
    for (const a of body?.aggregations ?? []) {
      const count = Number(a.count) || 0;
      const sum = Number(a.sum) || 0;
      totals.count += count;
      totals.sumLoanAmount += sum;
      const row: any = { year, count, sumLoanAmount: Math.round(sum), avgLoanAmount: count ? Math.round(sum / count) : null };
      for (const f of fkeys) {
        if (a[f] != null) row[f] = `${a[f]} — ${label(f, String(a[f]))}`;
      }
      if (a.lei) row.lei = a.lei;
      rows.push(row);
    }
  }

  // Multi-LEI queries return per-LEI rows; attach names when cheap.
  if (leis && args.resolve_names !== false && rows.some((r) => r.lei)) {
    try {
      const filers = await loadFilers(years[years.length - 1]!);
      for (const r of rows) if (r.lei) r.lender = filers.get(String(r.lei).toUpperCase())?.name ?? null;
    } catch { /* names are optional */ }
  }

  return {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    request: { years, ...geo, ...(leis ? { leis } : {}), filters },
    rows: rows.slice(0, 60),
    totals: {
      count: totals.count,
      sumLoanAmount: Math.round(totals.sumLoanAmount),
      avgLoanAmount: totals.count ? Math.round(totals.sumLoanAmount / totals.count) : null,
    },
    note:
      "count = HMDA records matching the filters (actions_taken=1 means originated loans); sumLoanAmount in USD (public LAR amounts are $10k-bucket midpoints, so sums are approximate). Multi-valued filters (e.g. loan_purposes=1,31,32) produce one row per value. At most two data filters per call — the API rejects more. Conforming-limit (jumbo) splits are not an aggregation filter: use hmda_jumbo_lenders.",
  };
}

/* ------------------------------------------------------------------ */
/* hmda_jumbo_lenders (loan-level CSV, streamed and reduced by LEI)     */
/* ------------------------------------------------------------------ */

interface LenderAgg {
  lei: string;
  count: number;
  sum: number;
  jumboCount: number;
  jumboSum: number;
  rateSum: number;
  rateN: number;
}

interface LoanRow {
  lei: string;
  amount: number;
  rate: number | null;
  propertyValue: number | null;
  income: number | null;
  tract: string;
  purpose: string;
  jumbo: boolean;
}

interface CountyReduce {
  year: number;
  rows: number;
  jumboRows: number;
  sum: number;
  jumboSum: number;
  lenders: LenderAgg[];
  topLoans: LoanRow[];
  tracts: Record<string, { count: number; jumboCount: number; sum: number }>;
  sourceUrl: string;
  threshold: number;
}

/** Minimal CSV line splitter (HMDA public LAR has no quoted commas in the fields we read, but be safe). */
function splitCsv(line: string): string[] {
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

async function streamCountyLoans(opts: {
  year: number;
  geoKey: "counties" | "msamds";
  geoVal: string;
  purposes: Set<string> | null;
  occupancy: Set<string> | null;
  lienFirstOnly: boolean;
  tracts: Set<string> | null;
  minAmount: number | null;
  loanTypes: Set<string> | null;
}): Promise<CountyReduce> {
  const { year } = opts;
  const url = `${API}/csv?years=${year}&${opts.geoKey}=${encodeURIComponent(opts.geoVal)}&actions_taken=1`;
  const res = await politeFetch(url, { timeoutMs: 55000, retries: 1, headers: { Accept: "text/csv" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HMDA loan-level CSV HTTP ${res.status} for ${year}/${opts.geoVal} (${redactUrl(url)})`);
  const threshold = CONFORMING_LIMIT[year] ?? CONFORMING_LIMIT[2024]!;

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let header: string[] | null = null;
  let idx: Record<string, number> = {};
  const lenders = new Map<string, LenderAgg>();
  const tracts: CountyReduce["tracts"] = {};
  const topLoans: LoanRow[] = [];
  let rows = 0, jumboRows = 0, sum = 0, jumboSum = 0;
  const TOP = 40;

  const handle = (line: string) => {
    if (!line) return;
    const cells = splitCsv(line);
    if (!header) {
      header = cells.map((h) => h.trim());
      header.forEach((h, i) => (idx[h] = i));
      for (const need of ["lei", "loan_amount", "conforming_loan_limit", "loan_purpose", "census_tract"]) {
        if (idx[need] == null) throw new Error(`HMDA CSV missing expected column ${need}`);
      }
      return;
    }
    const purpose = cells[idx.loan_purpose!] ?? "";
    if (opts.purposes && !opts.purposes.has(purpose)) return;
    if (opts.lienFirstOnly && idx.lien_status != null && cells[idx.lien_status] !== "1") return;
    if (opts.occupancy && idx.occupancy_type != null && !opts.occupancy.has(cells[idx.occupancy_type] ?? "")) return;
    if (opts.loanTypes && idx.loan_type != null && !opts.loanTypes.has(cells[idx.loan_type] ?? "")) return;
    // Exclude business/commercial-purpose and multifamily to keep to household mortgages.
    if (idx.business_or_commercial_purpose != null && cells[idx.business_or_commercial_purpose] === "1") return;
    if (idx.total_units != null) {
      const tu = cells[idx.total_units] ?? "";
      if (tu && !/^[1-4]$/.test(tu)) return;
    }
    const tract = cells[idx.census_tract!] ?? "";
    if (opts.tracts && !opts.tracts.has(tract)) return;
    const amount = Number(cells[idx.loan_amount!]);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const cll = cells[idx.conforming_loan_limit!] ?? "";
    const jumbo = opts.minAmount != null ? amount >= opts.minAmount : cll === "NC" || (cll !== "C" && amount > threshold);
    const lei = (cells[idx.lei!] ?? "").toUpperCase();
    rows++;
    sum += amount;
    let L = lenders.get(lei);
    if (!L) { L = { lei, count: 0, sum: 0, jumboCount: 0, jumboSum: 0, rateSum: 0, rateN: 0 }; lenders.set(lei, L); }
    L.count++;
    L.sum += amount;
    const t = (tracts[tract] ??= { count: 0, jumboCount: 0, sum: 0 });
    t.count++;
    t.sum += amount;
    if (jumbo) {
      jumboRows++;
      jumboSum += amount;
      L.jumboCount++;
      L.jumboSum += amount;
      t.jumboCount++;
      const rate = idx.interest_rate != null ? Number(cells[idx.interest_rate]) : NaN;
      if (Number.isFinite(rate) && rate > 0 && rate < 20) { L.rateSum += rate; L.rateN++; }
      const pv = idx.property_value != null ? Number(cells[idx.property_value]) : NaN;
      const inc = idx.income != null ? Number(cells[idx.income]) : NaN;
      const row: LoanRow = {
        lei, amount, rate: Number.isFinite(rate) ? rate : null,
        propertyValue: Number.isFinite(pv) ? pv : null, income: Number.isFinite(inc) ? inc * 1000 : null,
        tract, purpose, jumbo,
      };
      if (topLoans.length < TOP) {
        topLoans.push(row);
        if (topLoans.length === TOP) topLoans.sort((a, b) => b.amount - a.amount);
      } else if (amount > topLoans[TOP - 1]!.amount) {
        topLoans[TOP - 1] = row;
        topLoans.sort((a, b) => b.amount - a.amount);
      }
    }
  };

  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 400 * 1024 * 1024) { reader.cancel().catch(() => undefined); throw new Error("HMDA CSV exceeded 400 MB — narrow to a county"); }
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      handle(line);
    }
  }
  buf += dec.decode();
  if (buf.trim()) handle(buf.replace(/\r$/, ""));
  if (!header) throw new Error(`HMDA CSV for ${year}/${opts.geoVal} was empty`);
  topLoans.sort((a, b) => b.amount - a.amount);
  return { year, rows, jumboRows, sum, jumboSum, lenders: Array.from(lenders.values()), topLoans, tracts, sourceUrl: url, threshold };
}

export interface HmdaJumboArgs {
  year?: number | string;
  county?: string | number;
  msamd?: string | number;
  loan_purposes?: unknown;
  loan_types?: unknown;
  occupancy_types?: unknown;
  first_lien_only?: boolean;
  census_tracts?: unknown;
  min_loan_amount?: number;
  segment?: "jumbo" | "all";
  limit?: number;
  include_top_loans?: boolean;
  include_tracts?: boolean;
}

export async function hmdaJumboLenders(args: HmdaJumboArgs) {
  const year = parseYears(args.year ?? 2024)[0]!;
  const county = args.county != null ? String(args.county).trim().padStart(5, "0") : null;
  const msamd = args.msamd != null ? String(args.msamd).trim() : null;
  if (!county && !msamd) throw new Error("Provide county (5-digit FIPS, e.g. 17043 DuPage / 17031 Cook) or msamd (e.g. 16984 Chicago-Naperville-Evanston MD).");
  if (county && !/^\d{5}$/.test(county)) throw new Error(`county must be a 5-digit FIPS code, got "${county}"`);
  const purposesList = csvList(args.loan_purposes) ?? "1,31,32";
  const purposes = purposesList === "all" ? null : new Set(purposesList.split(","));
  const loanTypesList = csvList(args.loan_types);
  const loanTypes = loanTypesList ? new Set(loanTypesList.split(",")) : null;
  const occList = csvList(args.occupancy_types);
  const occupancy = occList ? new Set(occList.split(",")) : null;
  const lienFirstOnly = args.first_lien_only !== false;
  const tractList = csvList(args.census_tracts);
  const tracts = tractList ? new Set(tractList.split(",").map((t) => t.replace(/\D/g, ""))) : null;
  const minAmount = args.min_loan_amount != null && Number(args.min_loan_amount) > 0 ? Number(args.min_loan_amount) : null;
  const segment = args.segment === "all" ? "all" : "jumbo";
  const limit = clampInt(args.limit, 15, 1, 25);

  const key = `hmda:jumbo:${year}:${county ?? "msa" + msamd}:${purposesList}:${loanTypesList ?? ""}:${occList ?? ""}:${lienFirstOnly}:${tractList ?? ""}:${minAmount ?? ""}`;
  const red = await cached(key, 24 * HOUR, () =>
    streamCountyLoans({
      year,
      geoKey: county ? "counties" : "msamds",
      geoVal: county ?? msamd!,
      purposes, occupancy, lienFirstOnly, tracts, minAmount, loanTypes,
    })
  );
  if (!red.rows) {
    throw new Error(`No ${year} originations matched in ${county ?? "MSA " + msamd} with those filters — check the year is published (2024 is the latest full year) and the FIPS/tract codes.`);
  }

  let names = new Map<string, Filer>();
  try { names = await loadFilers(year); } catch { /* fall back to LEI only */ }
  const nameOf = (lei: string) => names.get(lei)?.name ?? null;

  const byJumbo = segment === "jumbo";
  const ranked = red.lenders
    .filter((l) => (byJumbo ? l.jumboCount > 0 : l.count > 0))
    .sort((a, b) => (byJumbo ? b.jumboSum - a.jumboSum || b.jumboCount - a.jumboCount : b.sum - a.sum));
  const denomCount = byJumbo ? red.jumboRows : red.rows;
  const denomSum = byJumbo ? red.jumboSum : red.sum;
  const top = ranked.slice(0, limit).map((l, i) => ({
    rank: i + 1,
    lender: nameOf(l.lei),
    lei: l.lei,
    ...(byJumbo
      ? {
          jumboLoans: l.jumboCount,
          jumboVolume: Math.round(l.jumboSum),
          shareOfJumboVolume: round(l.jumboSum / (denomSum || 1), 4),
          shareOfJumboCount: round(l.jumboCount / (denomCount || 1), 4),
          avgJumboLoan: Math.round(l.jumboSum / l.jumboCount),
          avgJumboRate: l.rateN ? round(l.rateSum / l.rateN, 3) : null,
          allLoans: l.count,
          jumboMixOfOwnBook: round(l.jumboCount / l.count, 3),
        }
      : {
          loans: l.count,
          volume: Math.round(l.sum),
          shareOfVolume: round(l.sum / (denomSum || 1), 4),
          shareOfCount: round(l.count / (denomCount || 1), 4),
          avgLoan: Math.round(l.sum / l.count),
          jumboLoans: l.jumboCount,
        }),
  }));
  const topN = top.reduce((s, r: any) => s + (byJumbo ? r.jumboVolume : r.volume), 0);

  const out: any = {
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    request: {
      year, county, msamd, segment,
      loan_purposes: purposesList, loan_types: loanTypesList, occupancy_types: occList,
      first_lien_only: lienFirstOnly, census_tracts: tractList, min_loan_amount: minAmount,
    },
    jumboDefinition: minAmount != null
      ? `loan_amount >= $${minAmount.toLocaleString()} (caller override)`
      : `HMDA conforming_loan_limit = NC (above the FHFA limit; ${year} baseline 1-unit limit $${red.threshold.toLocaleString()})`,
    market: {
      originations: red.rows,
      volume: Math.round(red.sum),
      jumboOriginations: red.jumboRows,
      jumboVolume: Math.round(red.jumboSum),
      jumboShareOfCount: round(red.jumboRows / red.rows, 4),
      jumboShareOfVolume: red.sum ? round(red.jumboSum / red.sum, 4) : null,
      avgLoan: Math.round(red.sum / red.rows),
      avgJumboLoan: red.jumboRows ? Math.round(red.jumboSum / red.jumboRows) : null,
      lendersActive: red.lenders.length,
      lendersWithJumbo: red.lenders.filter((l) => l.jumboCount > 0).length,
    },
    concentration: {
      topNVolumeShare: round(topN / (denomSum || 1), 4),
      top5VolumeShare: round(ranked.slice(0, 5).reduce((s, l) => s + (byJumbo ? l.jumboSum : l.sum), 0) / (denomSum || 1), 4),
    },
    lenders: top,
  };
  if (args.include_top_loans) {
    out.largestJumboLoans = red.topLoans.slice(0, 15).map((l) => ({
      amount: l.amount, lender: nameOf(l.lei), lei: l.lei, rate: l.rate, propertyValue: l.propertyValue,
      applicantIncome: l.income, censusTract: l.tract, purpose: label("loan_purposes", l.purpose),
    }));
  }
  if (args.include_tracts) {
    out.topTractsByJumboCount = Object.entries(red.tracts)
      .map(([tract, t]) => ({ tract, originations: t.count, jumbo: t.jumboCount, jumboShare: round(t.jumboCount / t.count, 3), avgLoan: Math.round(t.sum / t.count) }))
      .sort((a, b) => b.jumbo - a.jumbo || b.originations - a.originations)
      .slice(0, 15);
  }
  out.note =
    "Originated loans (action_taken=1) only; defaults keep 1-4 unit, first-lien, non-business purchase + refinance + cash-out (loan_purposes=1,31,32). Public LAR loan amounts are $10k-bucket midpoints and incomes are rounded $k, so volumes are approximate. Counties ~1-30 MB streamed; the first call for a county/year takes 3-10 s, then cached 24 h. Lender names come from the HMDA filers list; use hmda_lender_lookup for agency, HQ city and parent.";
  return out;
}

/* ------------------------------------------------------------------ */
/* hmda_lender_lookup                                                   */
/* ------------------------------------------------------------------ */

export interface HmdaLenderArgs {
  lei?: unknown;
  name?: string;
  year?: number | string;
  limit?: number;
  counties?: unknown;
  states?: unknown;
}

export async function hmdaLenderLookup(args: HmdaLenderArgs) {
  const year = parseYears(args.year ?? 2024)[0]!;
  const limit = clampInt(args.limit, 10, 1, 25);
  const filers = await loadFilers(year);
  let leis: string[] = [];
  let matchedBy = "lei";
  const given = csvList(args.lei);
  if (given) {
    leis = given.toUpperCase().split(",");
  } else if (args.name && String(args.name).trim()) {
    matchedBy = "name";
    const terms = String(args.name).toLowerCase().split(/\s+/).filter(Boolean);
    leis = Array.from(filers.values())
      .filter((f) => { const n = f.name.toLowerCase(); return terms.every((t) => n.includes(t)); })
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((f) => f.lei);
    if (!leis.length) throw new Error(`No ${year} HMDA filer name contains "${args.name}". Try a shorter fragment (filers list ~5,000 names) or pass lei.`);
  } else {
    throw new Error("Provide lei (one or more 20-char LEIs) or name (substring of the HMDA filer name).");
  }
  leis = leis.slice(0, limit);

  // Optional: volume in a geography for each lender (one aggregation call per LEI).
  const geoCounties = csvList(args.counties);
  const geoStates = csvList(args.states)?.toUpperCase() ?? null;

  const details = await Promise.all(
    leis.map(async (lei) => {
      const filer = filers.get(lei) ?? null;
      let inst: any = null;
      try {
        inst = await cached(`hmda:inst:${lei}:${year}`, 24 * HOUR, () => jsonFetch<any>(`${INST}/${encodeURIComponent(lei)}/year/${year}`, { timeoutMs: 15000, retries: 1 }));
      } catch (e: any) {
        inst = { _error: String(e?.message ?? e).slice(0, 120) };
      }
      let geoVolume: any = null;
      if (geoCounties || geoStates) {
        try {
          const p = new URLSearchParams({ years: String(year), leis: lei, actions_taken: "1" });
          if (geoCounties) p.set("counties", geoCounties); else if (geoStates) p.set("states", geoStates);
          const agg = await jsonFetch<any>(`${API}/aggregations?${p}`, { timeoutMs: 20000, retries: 1 });
          const a = agg?.aggregations?.[0];
          geoVolume = a ? { geography: geoCounties ?? geoStates, originations: Number(a.count) || 0, volume: Math.round(Number(a.sum) || 0) } : { geography: geoCounties ?? geoStates, originations: 0, volume: 0 };
        } catch (e: any) {
          geoVolume = { error: String(e?.message ?? e).slice(0, 120) };
        }
      }
      const agencyCode = Number(inst?.agency);
      return {
        lei,
        name: inst?.respondent?.name || filer?.name || null,
        hmdaRecordsNationwide: filer?.count ?? null,
        isHmdaFiler: inst?.hmdaFiler ?? (filer ? true : null),
        quarterlyFiler: inst?.quarterlyFiler ?? null,
        agency: Number.isFinite(agencyCode) && agencyCode > 0 ? `${agencyCode} — ${AGENCY[agencyCode] ?? "other"}` : null,
        hq: inst?.respondent ? [inst.respondent.city, inst.respondent.state].filter(Boolean).join(", ") || null : null,
        rssd: inst?.rssd && inst.rssd > 0 ? inst.rssd : null,
        taxId: inst?.taxId && inst.taxId !== "-1" ? inst.taxId : null,
        emailDomains: Array.isArray(inst?.emailDomains) ? inst.emailDomains.filter(Boolean).slice(0, 3) : [],
        parent: inst?.parent?.name ? inst.parent.name : null,
        topHolder: inst?.topHolder?.name ? inst.topHolder.name : null,
        assets: inst?.assets && inst.assets > 0 ? inst.assets : null,
        ...(geoVolume ? { geoVolume } : {}),
        ...(inst?._error ? { institutionsApiError: inst._error } : {}),
      };
    })
  );

  return {
    source: SOURCE + " — /view/filers + /v2/public/institutions",
    fetchedAt: new Date().toISOString(),
    year,
    matchedBy,
    lenders: details,
    note:
      "Names are the HMDA respondent names (filers list for the year). agency = regulator that receives the HMDA filing (9 = CFPB for large banks and most nonbank mortgage companies, 5 = NCUA credit unions, 1 OCC, 2 Fed, 3 FDIC, 7 HUD). Many fields (assets, parent, rssd) are -1/blank in the institutions API for nonbanks and are returned null. Pass counties/states to get the lender's originations in that geography. For corporate hierarchy use gleif_entity_profile with the LEI; for bank financials use FDIC BankFind tools.",
  };
}
