/**
 * Treasury auction results + upcoming auctions via FiscalData, keyless.
 *
 * Verified live 2026-10-22:
 *   GET {FISCAL_BASE}/v1/accounting/od/auctions_query     — "Treasury Securities Auctions Data" (every auction since
 *       1979; ~120 fields; numbers as strings, "null" for missing). Results populate the afternoon of auction day.
 *       security_type is only Bill|Note|Bond — TIPS are Note/Bond rows with inflation_index_security=Yes, FRNs are
 *       Note rows with floating_rate=Yes, cash-management bills are Bill rows with cash_management_bill_cmb=Yes.
 *       Useful fields: security_type, security_term ("5-Year", "13-Week", "9-Year 10-Month"
 *       for reopenings), auction_date, issue_date, maturity_date, offering_amt, total_tendered, total_accepted,
 *       bid_to_cover_ratio, high_yield / high_discnt_rate / high_discnt_margin, avg_med_yield (median),
 *       low_yield, int_rate, price_per100, primary_dealer_accepted, direct_bidder_accepted,
 *       indirect_bidder_accepted, noncomp_accepted, soma_accepted, comp_accepted, allocation_pctage, reopening.
 *   GET {FISCAL_BASE}/v1/accounting/od/upcoming_auctions  — next ~2 weeks of announced/tentative auctions
 *       (record_date, security_type, security_term, reopening, cusip, offering_amt ("null" until announced),
 *        announcemt_date, auction_date, issue_date).
 * Filter syntax: filter=field:op:value[,field:op:value] with op in eq,lt,lte,gt,gte,in. Sort: sort=-auction_date.
 * Not available here: when-issued (WI) yield at the 1 p.m. close, so a true "tail" cannot be computed; we report
 * high minus median yield (a stop-through/tail proxy within the auction) instead.
 */
import { cached, fetchJson, fiscalUrl, FiscalResponse, fnum, round, clampInt, isoDaysAgo, MINUTE, HOUR, todayIso } from "./common";

const RESULT_FIELDS = [
  "cusip", "security_type", "security_term", "auction_date", "issue_date", "maturity_date", "reopening", "auction_format",
  "offering_amt", "total_tendered", "total_accepted", "bid_to_cover_ratio", "high_yield", "high_discnt_rate",
  "high_investment_rate", "high_discnt_margin", "avg_med_yield", "avg_med_discnt_rate", "avg_med_discnt_margin", "low_yield",
  "int_rate", "price_per100", "primary_dealer_accepted", "direct_bidder_accepted", "indirect_bidder_accepted",
  "noncomp_accepted", "soma_accepted", "comp_accepted", "allocation_pctage", "cash_management_bill_cmb",
  "inflation_index_security", "floating_rate", "series",
];

type Raw = Record<string, string>;

const TYPE_ALIASES: Record<string, string> = {
  bill: "Bill", bills: "Bill", note: "Note", notes: "Note", bond: "Bond", bonds: "Bond", tips: "TIPS", frn: "FRN", frns: "FRN", cmb: "CMB",
};

export function normalizeType(t: unknown): string | null {
  if (t == null || t === "") return null;
  const k = String(t).trim().toLowerCase();
  const v = TYPE_ALIASES[k];
  if (!v) throw new Error(`securityType '${t}' not recognized — use Bill, Note, Bond, TIPS, FRN or CMB`);
  return v;
}

/** Instrument label derived from type + flag columns. */
function instrument(r: Raw): "Bill" | "CMB" | "Note" | "Bond" | "TIPS" | "FRN" {
  if (r.inflation_index_security === "Yes") return "TIPS";
  if (r.floating_rate === "Yes") return "FRN";
  if (r.cash_management_bill_cmb === "Yes") return "CMB";
  return r.security_type as "Bill" | "Note" | "Bond";
}

/** FiscalData filter clauses for a user-facing type (nominal Note/Bond exclude TIPS/FRN; Bill excludes CMBs). */
function typeFilter(type: string): string[] {
  switch (type) {
    case "TIPS": return ["inflation_index_security:eq:Yes"];
    case "FRN": return ["floating_rate:eq:Yes"];
    case "CMB": return ["security_type:eq:Bill", "cash_management_bill_cmb:eq:Yes"];
    case "Bill": return ["security_type:eq:Bill", "cash_management_bill_cmb:eq:No"];
    default: return [`security_type:eq:${type}`, "inflation_index_security:eq:No", "floating_rate:eq:No"];
  }
}

/** "10y" | "10-year" | "10 Year" | "13w" | "13-week" -> "10-Year" | "13-Week" (also accepts "2y", "4w", "52-Week"). */
export function normalizeTerm(t: unknown): string | null {
  if (t == null || t === "") return null;
  const s = String(t).trim().toLowerCase();
  let m = s.match(/^(\d+)\s*-?\s*(y|yr|year|years)$/);
  if (m) return `${Number(m[1])}-Year`;
  m = s.match(/^(\d+)\s*-?\s*(w|wk|week|weeks)$/);
  if (m) return `${Number(m[1])}-Week`;
  m = s.match(/^(\d+)\s*-?\s*(d|day|days)$/);
  if (m) return `${Number(m[1])}-Day`;
  m = s.match(/^(\d+)\s*-?\s*(m|mo|month|months)$/);
  if (m) return `${Number(m[1])}-Month`;
  return String(t).trim();
}

/** Years to maturity, from a term like "9-Year 10-Month" or "13-Week". */
function termYears(term: string): number | null {
  let y = 0;
  let any = false;
  for (const m of term.matchAll(/(\d+)-(Year|Month|Week|Day)/gi)) {
    any = true;
    const n = Number(m[1]);
    const u = m[2]!.toLowerCase();
    y += u === "year" ? n : u === "month" ? n / 12 : u === "week" ? n * 7 / 365.25 : n / 365.25;
  }
  return any ? y : null;
}

function shapeResult(r: Raw) {
  const comp = fnum(r.comp_accepted);
  const dealer = fnum(r.primary_dealer_accepted);
  const direct = fnum(r.direct_bidder_accepted);
  const indirect = fnum(r.indirect_bidder_accepted);
  const denom = comp && comp > 0 ? comp : null;
  const pct = (n: number | null) => (denom && n != null ? round((n / denom) * 100, 1) : null);
  const type = instrument(r);
  const highYield = fnum(r.high_yield);
  const highRate = fnum(r.high_discnt_rate);
  const highMargin = fnum(r.high_discnt_margin);
  const median = fnum(r.avg_med_yield) ?? fnum(r.avg_med_discnt_rate) ?? fnum(r.avg_med_discnt_margin);
  const stop = type === "FRN" ? highMargin : type === "Bill" || type === "CMB" ? highRate : highYield;
  const bn = (v: unknown) => {
    const n = fnum(v);
    return n == null ? null : round(n / 1e9, 2);
  };
  return {
    auctionDate: r.auction_date,
    type,
    term: r.security_term,
    reopening: r.reopening === "Yes" ? true : undefined,
    resultsPending: fnum(r.bid_to_cover_ratio) == null ? true : undefined,
    cusip: r.cusip,
    issueDate: r.issue_date,
    maturityDate: r.maturity_date,
    offeredBn: bn(r.offering_amt),
    acceptedBn: bn(r.total_accepted),
    tenderedBn: bn(r.total_tendered),
    bidToCover: round(fnum(r.bid_to_cover_ratio), 2),
    // Stop-out level: high yield (notes/bonds/TIPS), high discount rate (bills), high discount margin (FRN) — percent.
    stop: round(stop, 3),
    stopKind: type === "FRN" ? "high_discount_margin" : type === "Bill" || type === "CMB" ? "high_discount_rate" : "high_yield",
    highInvestmentRate: type === "Bill" || type === "CMB" ? round(fnum(r.high_investment_rate), 3) : undefined,
    median: round(median, 3),
    highMinusMedianBp: stop != null && median != null ? round((stop - median) * 100, 1) : null,
    coupon: type === "Note" || type === "Bond" || type === "TIPS" ? round(fnum(r.int_rate), 3) : undefined,
    price: round(fnum(r.price_per100), 3),
    allotmentAtHighPct: round(fnum(r.allocation_pctage), 1),
    // Shares of competitive awards (standard dealer/direct/indirect split).
    indirectPct: pct(indirect),
    directPct: pct(direct),
    dealerPct: pct(dealer),
    nonCompBn: bn(r.noncomp_accepted),
    somaBn: bn(r.soma_accepted),
  };
}

export async function treasuryAuctions(args: {
  securityType?: string;
  term?: string;
  since?: string;
  until?: string;
  sinceDays?: number;
  limit?: number;
  fields?: string[];
}) {
  const type = normalizeType(args.securityType);
  const term = normalizeTerm(args.term);
  const limit = clampInt(args.limit, 12, 1, 25);
  const since = args.since ? String(args.since).slice(0, 10) : args.sinceDays != null ? isoDaysAgo(clampInt(args.sinceDays, 90, 1, 20000)) : null;
  const until = args.until ? String(args.until).slice(0, 10) : null;
  for (const d of [since, until]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("since/until must be YYYY-MM-DD");

  const filter: string[] = [];
  if (type) filter.push(...typeFilter(type));
  if (since) filter.push(`auction_date:gte:${since}`);
  if (until) filter.push(`auction_date:lte:${until}`);
  // Term filtering is done client-side so "10-Year" also matches "9-Year 10-Month" reopenings.
  const pageSize = term ? 100 : Math.min(100, limit * 2);
  const url = fiscalUrl("v1/accounting/od/auctions_query", { fields: RESULT_FIELDS, filter, sort: "-auction_date", pageSize });
  const resp = await cached(`fedboard:auctions:${url}`, 30 * MINUTE, () => fetchJson<FiscalResponse<Raw>>(url, 30000));
  let rows = resp.data;
  if (term) {
    const ty = termYears(term);
    rows = rows.filter((r) => {
      if (r.security_term === term) return true;
      if (r.security_term.startsWith(term)) return true;
      // reopenings: "9-Year 10-Month" ≈ 10-Year; "29-Year 11-Month" ≈ 30-Year
      const ry = termYears(r.security_term);
      return ty != null && ry != null && ty >= 1 && Math.abs(ry - ty) < 0.5 && !r.security_term.endsWith("-Week") && r.security_term.includes("Month");
    });
  }
  const today = todayIso();
  const results = rows.filter((r) => fnum(r.bid_to_cover_ratio) != null || r.auction_date < today);
  const pending = rows.filter((r) => fnum(r.bid_to_cover_ratio) == null && r.auction_date >= today);
  let shaped = results.slice(0, limit).map(shapeResult) as Array<Record<string, unknown>>;
  if (args.fields?.length) {
    const keep = new Set(["auctionDate", "type", "term", "resultsPending", ...args.fields]);
    shaped = shaped.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
  }
  const btc = shaped.map((r) => r.bidToCover as number | null).filter((x): x is number => x != null);
  return {
    source: "U.S. Treasury FiscalData — Treasury Securities Auctions Data (v1/accounting/od/auctions_query)",
    fetchedAt: new Date().toISOString(),
    filters: { securityType: type, term, since, until },
    totalMatching: resp.meta["total-count"] ?? null,
    returned: shaped.length,
    avgBidToCover: btc.length ? round(btc.reduce((a, b) => a + b, 0) / btc.length, 2) : null,
    pendingToday: pending.length ? pending.map((r) => ({ auctionDate: r.auction_date, type: r.security_type, term: r.security_term, offeredBn: round((fnum(r.offering_amt) ?? 0) / 1e9, 1) })) : undefined,
    auctions: shaped,
    units: "amounts $bn; stop/median/coupon in percent; highMinusMedianBp in basis points; indirect/direct/dealer = % of competitive awards",
    note: "securityType omitted → nominal and TIPS/FRN rows are both included (see `type` per row). No when-issued yield in this dataset, so tail vs WI is not computed; highMinusMedianBp is the in-auction dispersion proxy. Results post ~1:30–2 p.m. ET on auction day.",
  };
}

export async function treasuryUpcomingAuctions(args: { securityType?: string; days?: number; limit?: number }) {
  const type = normalizeType(args.securityType);
  if (type === "TIPS" || type === "FRN" || type === "CMB") throw new Error("upcoming_auctions only distinguishes Bill | Note | Bond (TIPS/FRN appear as Note/Bond by term, e.g. '4-Year 6-Month' TIPS); omit securityType and read the term");
  const days = clampInt(args.days, 21, 1, 60);
  const limit = clampInt(args.limit, 25, 1, 25);
  const today = todayIso();
  const url = fiscalUrl("v1/accounting/od/upcoming_auctions", { sort: "auction_date", pageSize: 100 });
  const resp = await cached("fedboard:upcoming", 30 * MINUTE, () => fetchJson<FiscalResponse<Raw>>(url, 30000));
  const horizon = isoDaysAgo(-days);
  let rows = resp.data.filter((r) => r.auction_date >= today && r.auction_date <= horizon);
  if (type) rows = rows.filter((r) => r.security_type === type);
  rows.sort((a, b) => a.auction_date.localeCompare(b.auction_date) || a.security_type.localeCompare(b.security_type));
  const shaped = rows.slice(0, limit).map((r) => ({
    auctionDate: r.auction_date,
    type: r.security_type,
    term: r.security_term,
    reopening: r.reopening === "Yes" ? true : undefined,
    cusip: r.cusip,
    offeredBn: fnum(r.offering_amt) != null ? round((fnum(r.offering_amt) as number) / 1e9, 1) : null,
    announced: fnum(r.offering_amt) != null,
    announcementDate: r.announcemt_date,
    issueDate: r.issue_date,
  }));
  const byDay: Record<string, string[]> = {};
  for (const r of shaped) (byDay[r.auctionDate] ??= []).push(`${r.term} ${r.type}${r.offeredBn != null ? ` $${r.offeredBn}bn` : ""}`);
  const coupons = shaped.filter((r) => r.type !== "Bill" && r.type !== "CMB");
  return {
    source: "U.S. Treasury FiscalData — Upcoming Auctions (v1/accounting/od/upcoming_auctions)",
    fetchedAt: new Date().toISOString(),
    asOf: resp.data.map((r) => r.record_date).sort().pop() ?? null,
    window: { from: today, to: horizon },
    count: shaped.length,
    couponSupplyBn: round(coupons.reduce((s, r) => s + (r.offeredBn ?? 0), 0), 1),
    couponAuctions: coupons.map((r) => `${r.auctionDate} ${r.term} ${r.type}${r.reopening ? " (reopen)" : ""}${r.offeredBn != null ? ` $${r.offeredBn}bn` : " (size TBA)"}`),
    byDay,
    auctions: shaped,
    note: "offeredBn is null until Treasury's announcement (typically Thursday for the following week's bills; coupon sizes announced at the quarterly refunding and weekly). Use treasury_auctions for results.",
  };
}

export { HOUR };
