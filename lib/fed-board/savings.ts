/**
 * Series I and Series EE savings bond rates, keyless.
 *
 * FiscalData has NO dataset of current I/EE bond rates (checked 2026-10-22: sb_rates, savings_bond_rates,
 * i_bond_rates etc. all 404; v2/accounting/od/sb_value and redemption_tables are redemption-VALUE tables
 * for paper bonds, not rates). TreasuryDirect publishes the rate tables as HTML, verified live:
 *   https://www.treasurydirect.gov/savings-bonds/i-bonds/i-bonds-interest-rates/
 *     "Current Interest Rate Series I Savings Bonds 4.26% … fixed rate of 0.90% … For I bonds issued May 1, 2026 to
 *      October 31, 2026" + three history tables (fixed rate by set date since Sept 1998; semiannual inflation
 *      rate by set date; composite rate by purchase window).
 *   https://www.treasurydirect.gov/savings-bonds/ee-bonds/            "Current Interest Rate Series EE Savings Bonds 2.40%"
 *   https://www.treasurydirect.gov/savings-bonds/ee-bonds/may-2005-and-later/   EE fixed-rate history table since May 2005.
 * Rates reset every May 1 and November 1. Pages are cached 12h.
 */
import { cached, fetchText, HOUR, htmlToText, decodeEntities, MONTH_INDEX, pad2, round, clampInt } from "./common";

const I_URL = "https://www.treasurydirect.gov/savings-bonds/i-bonds/i-bonds-interest-rates/";
const EE_URL = "https://www.treasurydirect.gov/savings-bonds/ee-bonds/";
const EE_HIST_URL = "https://www.treasurydirect.gov/savings-bonds/ee-bonds/may-2005-and-later/";

type Table = string[][];

function tables(html: string): Table[] {
  const out: Table[] = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows: string[][] = [];
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((c) => htmlToText(c).replace(/\s+/g, " ").trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length) out.push(rows);
  }
  return out;
}

function pct(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

/** "May 1, 2026" -> "2026-05-01"; "Nov. 2025" -> "2025-11". */
function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/([A-Za-z]+)\.?\s+(?:(\d{1,2}),\s*)?(\d{4})/);
  if (!m) return null;
  const mi = MONTH_INDEX[m[1]!.toLowerCase()];
  if (mi == null) return null;
  return m[2] ? `${m[3]}-${pad2(mi + 1)}-${pad2(Number(m[2]))}` : `${m[3]}-${pad2(mi + 1)}`;
}

interface IBondData {
  composite: number | null;
  fixed: number | null;
  inflationSemiannual: number | null;
  window: string | null;
  fixedHistory: Array<{ setDate: string; ratePct: number }>;
  inflationHistory: Array<{ setDate: string; semiannualPct: number }>;
  compositeByPurchase: Array<{ from: string; through: string; currentCompositePct: number }>;
}

function parseIBond(html: string): IBondData {
  const text = htmlToText(html).replace(/\s+/g, " ");
  const cur = text.match(/Series I Savings Bonds\s+(\d+(?:\.\d+)?)%\s+This includes a fixed rate of\s+(\d+(?:\.\d+)?)%\s+For I bonds issued\s+([A-Za-z]+ \d{1,2}, \d{4}) to ([A-Za-z]+ \d{1,2}, \d{4})/i);
  const tabs = tables(html);
  const fixedT = tabs.find((t) => /fixed rate was set/i.test(t[0]?.[0] ?? ""));
  const inflT = tabs.find((t) => /inflation rate was set/i.test(t[0]?.[0] ?? ""));
  const compT = tabs.find((t) => /Period when you bought/i.test(t[0]?.[0] ?? ""));
  const fixedHistory = (fixedT ?? []).slice(1).map((r) => ({ setDate: isoDate(r[0]) ?? r[0]!, ratePct: pct(r[1]) as number })).filter((r) => r.ratePct != null);
  const inflationHistory = (inflT ?? []).slice(1).map((r) => ({ setDate: isoDate(r[0]) ?? r[0]!, semiannualPct: pct(r[1]) as number })).filter((r) => r.semiannualPct != null);
  const compositeByPurchase = (compT ?? [])
    .filter((r) => r.length >= 3 && pct(r[2]) != null)
    .map((r) => ({ from: isoDate(r[0]) ?? r[0]!, through: isoDate(r[1]) ?? r[1]!, currentCompositePct: pct(r[2]) as number }));
  const inflFromTable = inflationHistory[0]?.semiannualPct ?? null;
  return {
    composite: cur ? Number(cur[1]) : null,
    fixed: cur ? Number(cur[2]) : fixedHistory[0]?.ratePct ?? null,
    inflationSemiannual: inflFromTable,
    window: cur ? `${isoDate(cur[3])}..${isoDate(cur[4])}` : null,
    fixedHistory,
    inflationHistory,
    compositeByPurchase,
  };
}

function parseEE(html: string, histHtml: string | null) {
  const text = htmlToText(html).replace(/\s+/g, " ");
  const cur = text.match(/Series EE Savings Bonds\s+(\d+(?:\.\d+)?)%\s+For EE bonds issued\s+([A-Za-z]+ \d{1,2}, \d{4}) to ([A-Za-z]+ \d{1,2}, \d{4})/i);
  let history: Array<{ setDate: string; ratePct: number }> = [];
  if (histHtml) {
    const t = tables(histHtml).find((tb) => /fixed rate for EE/i.test(tb[0]?.join(" ") ?? ""));
    history = (t ?? []).slice(1).map((r) => ({ setDate: isoDate(r[0]) ?? r[0]!, ratePct: pct(r[1]) as number })).filter((r) => r.ratePct != null);
  }
  return {
    rate: cur ? Number(cur[1]) : history[0]?.ratePct ?? null,
    window: cur ? `${isoDate(cur[2])}..${isoDate(cur[3])}` : null,
    history,
  };
}

function loadI(): Promise<IBondData> {
  return cached("fedboard:ibond", 12 * HOUR, async () => {
    const d = parseIBond(await fetchText(I_URL, 25000, 2, "text/html,*/*"));
    if (d.composite == null && !d.fixedHistory.length) throw new Error("TreasuryDirect I bond page parsed no rates — layout may have changed");
    return d;
  });
}
function loadEE() {
  return cached("fedboard:eebond", 12 * HOUR, async () => {
    const [main, hist] = await Promise.all([fetchText(EE_URL, 25000, 2, "text/html,*/*"), fetchText(EE_HIST_URL, 25000, 2, "text/html,*/*").catch(() => null)]);
    const d = parseEE(main, hist);
    if (d.rate == null) throw new Error("TreasuryDirect EE bond page parsed no rate — layout may have changed");
    return d;
  });
}

export async function treasurySavingsBondRates(args: { series?: string; history?: number }) {
  const series = String(args.series ?? "both").toLowerCase();
  if (!["i", "ee", "both"].includes(series)) throw new Error("series must be I, EE or both");
  const n = clampInt(args.history, 8, 0, 60);
  const out: Record<string, unknown> = {
    source: "TreasuryDirect (U.S. Treasury Bureau of the Fiscal Service) — I bond and EE bond rate pages",
    fetchedAt: new Date().toISOString(),
  };
  if (series !== "ee") {
    const i = await loadI();
    const fixed = i.fixed;
    const infl = i.inflationSemiannual;
    out.iBond = {
      compositeRatePct: i.composite,
      fixedRatePct: fixed,
      semiannualInflationRatePct: infl,
      annualizedInflationComponentPct: infl != null ? round(infl * 2, 2) : null,
      compositeCheckPct: fixed != null && infl != null ? round((fixed / 100 + 2 * (infl / 100) + (fixed / 100) * (infl / 100)) * 100, 2) : null,
      issueWindow: i.window,
      fixedRateHistory: i.fixedHistory.slice(0, n),
      inflationRateHistory: i.inflationHistory.slice(0, n),
      currentCompositeByPurchaseWindow: i.compositeByPurchase.slice(0, n),
      url: I_URL,
    };
  }
  if (series !== "i") {
    const ee = await loadEE();
    out.eeBond = {
      fixedRatePct: ee.rate,
      issueWindow: ee.window,
      guarantee: "Doubles in value at 20 years (implied ≥3.5%/yr if held 20y); earns the fixed rate for 30 years otherwise.",
      fixedRateHistory: ee.history.slice(0, n),
      url: EE_URL,
    };
  }
  out.notes = [
    "Rates reset May 1 and November 1. The I bond fixed rate is locked for the bond's 30-year life; the inflation component (CPI-U NSA, 6-month change) is re-set semiannually and applied per bond on its issue-month anniversary.",
    "Purchase limits: $10,000 electronic per SSN per calendar year per series (paper I bonds via tax refund were discontinued for 2025+). 1-year lockup; 3-month interest penalty if redeemed before 5 years. Interest is state/local tax exempt and federally deferrable.",
  ];
  return out;
}
