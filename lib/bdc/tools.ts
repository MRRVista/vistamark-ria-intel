/**
 * MCP tool handlers for Business Development Company (BDC) intelligence.
 *
 * BDCs report to the SEC like operating companies (10-K/10-Q, N-2, DEF 14A)
 * rather than as registered funds, so their financials live in EDGAR XBRL.
 * This module layers a curated listed-BDC universe (see ./universe) on top of
 * the existing EDGAR client: it resolves tickers to CIKs against the live SEC
 * map and pulls BDC-relevant financial facts. No new external dependency.
 *
 * Tools:
 *   bdc_list     -- the tracked BDC universe, with live CIK resolution
 *   bdc_profile  -- one BDC's key financials + recent filings
 *   bdc_screen   -- rank the universe by a chosen financial metric
 *
 * Caveat: BDC XBRL tagging varies by filer/year. Each metric reports the
 * concept that actually returned data (resolvedConcept) or null; nothing is
 * fabricated. NAV-per-share in particular is frequently untagged.
 */
import {
  companyTickers,
  submissions,
  companyConcept,
  padCik,
  type TickerEntry,
  type CompanyConceptResponse,
} from "../edgar/client";
import { BDC_UNIVERSE, BDC_UNIVERSE_SOURCE } from "./universe";

// Candidate us-gaap tags per BDC metric, tried in order until one returns data.
const BDC_CONCEPTS: Record<string, string[]> = {
  totalAssets: ["Assets"],
  netAssets: [
    "NetAssets",
    "StockholdersEquity",
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  totalInvestmentsFairValue: ["InvestmentOwnedAtFairValue", "Investments"],
  totalInvestmentIncome: [
    "InvestmentIncomeOperating",
    "GrossInvestmentIncomeOperating",
    "InvestmentIncomeInterestAndDividend",
  ],
  netInvestmentIncome: ["NetInvestmentIncome"],
  navPerShare: ["NetAssetValuePerShare"],
};
const VALID_METRICS = Object.keys(BDC_CONCEPTS);

function resolveBdcCik(
  tickers: TickerEntry[],
  ticker: string
): { cik: string; name: string } | null {
  const t = ticker.trim().toUpperCase();
  const hit = tickers.find((x) => x.ticker.toUpperCase() === t);
  return hit ? { cik: padCik(hit.cik), name: hit.title } : null;
}

function conceptHasData(d: CompanyConceptResponse | null): boolean {
  if (!d || !d.units) return false;
  return Object.values(d.units).some((a) => Array.isArray(a) && a.length > 0);
}

/** Latest reported value across a set of candidate tags. Returns null if none tagged. */
async function latestConcept(
  cik: string,
  candidates: string[],
  annualOnly: boolean
): Promise<{
  resolvedConcept: string;
  unit: string | null;
  value: any;
  end: string | null;
  fy: any;
  fp: any;
  form: any;
} | null> {
  for (const cand of candidates) {
    try {
      const d = await companyConcept(cik, cand, "us-gaap");
      if (!conceptHasData(d)) continue;
      const units = d.units ?? {};
      const unitKey = Object.keys(units)[0] ?? null;
      let pts = unitKey ? units[unitKey]! : [];
      if (annualOnly) {
        pts = pts.filter(
          (p) => String(p.form ?? "").toUpperCase().startsWith("10-K") || p.fp === "FY"
        );
      }
      if (!pts.length) continue;
      pts = [...pts].sort((a, b) => String(a.end).localeCompare(String(b.end)));
      const last = pts[pts.length - 1];
      return {
        resolvedConcept: cand,
        unit: unitKey,
        value: last.val ?? null,
        end: last.end ?? null,
        fy: last.fy ?? null,
        fp: last.fp ?? null,
        form: last.form ?? null,
      };
    } catch {
      // Non-OK (usually 404 -- filer never tagged this concept). Try next.
    }
  }
  return null;
}

export interface BdcListArgs {
  nameContains?: string;
  tickerContains?: string;
  limit?: number;
}

export async function bdcList(args: BdcListArgs) {
  const tickers = await companyTickers();
  let universe = BDC_UNIVERSE;
  if (args.nameContains) {
    const n = args.nameContains.trim().toLowerCase();
    universe = universe.filter((b) => b.name.toLowerCase().includes(n));
  }
  if (args.tickerContains) {
    const t = args.tickerContains.trim().toUpperCase();
    universe = universe.filter((b) => b.ticker.toUpperCase().includes(t));
  }
  const limit = Math.min(args.limit ?? 100, 100);
  const rows = universe.slice(0, limit).map((b) => {
    const r = resolveBdcCik(tickers, b.ticker);
    return {
      ticker: b.ticker,
      name: b.name,
      cik: r?.cik ?? null,
      secRegisteredName: r?.name ?? null,
      resolved: !!r,
    };
  });
  const unresolved = rows.filter((r) => !r.resolved).map((r) => r.ticker);
  return {
    dataSource: "Curated listed-BDC universe + SEC EDGAR ticker resolution",
    universeSource: BDC_UNIVERSE_SOURCE,
    count: rows.length,
    totalInUniverse: BDC_UNIVERSE.length,
    bdcs: rows,
    unresolvedTickers: unresolved,
    note: unresolved.length
      ? `These tickers did not resolve against the live SEC ticker map and may have changed or delisted: ${unresolved.join(", ")}. Reconcile the curated list against the live BIZD holdings file.`
      : "All curated tickers resolved to a live SEC CIK. Use a returned cik/ticker with bdc_profile or any edgar_* tool.",
  };
}

export interface BdcProfileArgs {
  ticker?: string;
  name?: string;
  annualOnly?: boolean;
}

export async function bdcProfile(args: BdcProfileArgs) {
  const tickers = await companyTickers();
  let resolved: { cik: string; name: string; ticker: string | null } | null = null;
  if (args.ticker) {
    const r = resolveBdcCik(tickers, args.ticker);
    if (r) resolved = { cik: r.cik, name: r.name, ticker: args.ticker.trim().toUpperCase() };
  }
  if (!resolved && args.name) {
    const n = args.name.trim().toLowerCase();
    const u = BDC_UNIVERSE.find((b) => b.name.toLowerCase().includes(n));
    if (u) {
      const r = resolveBdcCik(tickers, u.ticker);
      if (r) resolved = { cik: r.cik, name: r.name, ticker: u.ticker };
    }
    if (!resolved) {
      const hit = tickers.find((x) => x.title.toLowerCase().includes(n));
      if (hit) resolved = { cik: padCik(hit.cik), name: hit.title, ticker: hit.ticker };
    }
  }
  if (!resolved) {
    return {
      dataSource: "BDC profile (SEC EDGAR)",
      error:
        "Could not resolve a BDC. Provide a ticker (e.g. ARCC) or a name. See bdc_list for the tracked universe.",
      profile: null,
    };
  }
  const annualOnly = args.annualOnly ?? true;
  const metrics: Record<string, any> = {};
  for (const [key, cands] of Object.entries(BDC_CONCEPTS)) {
    metrics[key] = await latestConcept(resolved.cik, cands, key === "navPerShare" ? false : annualOnly);
  }
  let recentFilings: any[] = [];
  let meta: any = {};
  try {
    const sub = await submissions(resolved.cik);
    meta = {
      name: sub.name ?? resolved.name,
      exchanges: sub.exchanges ?? null,
      sic: sub.sic ?? null,
      sicDescription: sub.sicDescription ?? null,
    };
    const recent = sub.filings?.recent ?? {};
    const forms: string[] = recent.form ?? [];
    const dates: string[] = recent.filingDate ?? [];
    const accs: string[] = recent.accessionNumber ?? [];
    const docs: string[] = recent.primaryDocument ?? [];
    const cikNum = Number(resolved.cik);
    for (let i = 0; i < forms.length && recentFilings.length < 8; i++) {
      const f = String(forms[i] ?? "").toUpperCase();
      if (f === "10-K" || f === "10-Q" || f === "8-K" || f === "N-2" || f === "DEF 14A") {
        const acc = accs[i] ?? "";
        const accND = acc.replace(/-/g, "");
        recentFilings.push({
          form: forms[i],
          filingDate: dates[i] ?? null,
          url: acc
            ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accND}/${docs[i] ?? ""}`
            : null,
        });
      }
    }
  } catch {
    // submissions unavailable; metrics still returned
  }
  return {
    dataSource: "BDC profile (SEC EDGAR XBRL + submissions, live)",
    bdc: {
      ticker: resolved.ticker,
      cik: resolved.cik,
      name: meta.name ?? resolved.name,
      exchanges: meta.exchanges ?? null,
      sic: meta.sic ?? null,
      sicDescription: meta.sicDescription ?? null,
    },
    basis: annualOnly ? "annual (10-K / full-year)" : "most recent reported",
    metrics: {
      totalAssetsUsd: metrics.totalAssets,
      netAssetsUsd: metrics.netAssets,
      totalInvestmentsFairValueUsd: metrics.totalInvestmentsFairValue,
      totalInvestmentIncomeUsd: metrics.totalInvestmentIncome,
      netInvestmentIncomeUsd: metrics.netInvestmentIncome,
      navPerShare: metrics.navPerShare,
    },
    recentFilings,
    note:
      "Financials are pulled from SEC XBRL facts (companyconcept). BDC XBRL tagging varies by filer and year; each metric reports the resolvedConcept that actually returned data, or null if this filer tagged no candidate concept (NAV/share is frequently untagged). Figures are as-reported, not adjusted -- cross-check the filing for definitional nuances.",
  };
}

export interface BdcScreenArgs {
  metric?: string;
  limit?: number;
  annualOnly?: boolean;
}

export async function bdcScreen(args: BdcScreenArgs) {
  const metricKey = args.metric && BDC_CONCEPTS[args.metric] ? args.metric : "netAssets";
  const cands = BDC_CONCEPTS[metricKey]!;
  const annualOnly = args.annualOnly ?? true;
  const limit = Math.min(args.limit ?? 12, BDC_UNIVERSE.length);
  const tickers = await companyTickers();
  const subset = BDC_UNIVERSE.slice(0, limit);
  const rows: any[] = [];
  for (const b of subset) {
    const r = resolveBdcCik(tickers, b.ticker);
    if (!r) {
      rows.push({ ticker: b.ticker, name: b.name, resolved: false, value: null });
      continue;
    }
    const m = await latestConcept(r.cik, cands, metricKey === "navPerShare" ? false : annualOnly);
    rows.push({
      ticker: b.ticker,
      name: r.name,
      cik: r.cik,
      resolved: true,
      metric: metricKey,
      resolvedConcept: m?.resolvedConcept ?? null,
      unit: m?.unit ?? null,
      value: m?.value ?? null,
      asOf: m?.end ?? null,
      fy: m?.fy ?? null,
      form: m?.form ?? null,
    });
  }
  const ranked = rows
    .filter((r) => typeof r.value === "number")
    .sort((a, b) => (b.value as number) - (a.value as number));
  const missing = rows.filter((r) => typeof r.value !== "number").map((r) => r.ticker);
  return {
    dataSource: "BDC screen (SEC EDGAR XBRL, live)",
    universeSource: BDC_UNIVERSE_SOURCE,
    metric: metricKey,
    metricCandidatesTried: cands,
    basis: annualOnly ? "annual (10-K / full-year)" : "most recent reported",
    processed: subset.length,
    ranked,
    missingOrUnresolved: missing,
    note: `Ranked ${ranked.length} BDCs by latest ${metricKey} from SEC XBRL facts (descending). Processed the first ${subset.length} of ${BDC_UNIVERSE.length} tracked BDCs (raise limit to widen; each BDC is a separate SEC call, so larger limits are slower). Valid metric values: ${VALID_METRICS.join(", ")}. 'missing' = filer tagged no candidate concept, or ticker did not resolve.`,
  };
}
