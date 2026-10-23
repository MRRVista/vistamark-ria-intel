/**
 * NY Fed research datasets (newyorkfed.org/medialibrary — public files, no key).
 *
 * ACM Treasury term premia (Adrian-Crump-Moench):
 *   PRIMARY  .../research/data_indicators/ACMTermPremium.xls   (legacy BIFF8 .xls ONLY, ~10MB;
 *            sheets 'ACM Monthly' and 'ACM Daily'; columns DATE, ACMY01..10 fitted yields,
 *            ACMTP01..10 term premia, ACMRNY01..10 risk-neutral yields). Parsed by ./biff.ts.
 *   FALLBACK .../research/data_indicators/acmPlot_data.csv     (monthly, 10y only: TERMYld,
 *            ACMFITYld, GSWYld) — the interactive chart's feed.
 *
 * Yield-curve recession probability (Estrella-Mishkin probit on 10y–3m spread):
 *   PRIMARY  .../research/capital_markets/yield/assets/data/yield.csv  (interactive's feed; monthly,
 *            includes the 12 forward months of probabilities; Rec_prob as 'xx.xx%')
 *   FALLBACK .../research/capital_markets/allmonth.xls (legacy BIFF, same columns, fractions)
 * The ycfaq page itself is an Angular shell — no data in HTML.
 */
import { HOUR, cached, clampInt, fetchBuffer, fetchText, normDate, num, parseCsv, round } from "./common";
import { openXls } from "./biff";

const MEDIA = "https://www.newyorkfed.org/medialibrary/media/research";
const ACM_XLS = `${MEDIA}/data_indicators/ACMTermPremium.xls`;
const ACM_CSV = `${MEDIA}/data_indicators/acmPlot_data.csv`;
const YC_CSV = `${MEDIA}/capital_markets/yield/assets/data/yield.csv`;
const YC_XLS = `${MEDIA}/capital_markets/allmonth.xls`;

interface AcmRow { date: string; y: (number | null)[]; tp: (number | null)[]; rny: (number | null)[] }
interface AcmData { monthly: AcmRow[]; daily: AcmRow[]; source: "xls" }

function acmRows(grid: (string | number | null)[][]): AcmRow[] {
  const header = (grid[0] ?? []).map((h) => String(h ?? "").toUpperCase().trim());
  const idx = (p: string, m: number) => header.indexOf(`${p}${String(m).padStart(2, "0")}`);
  const out: AcmRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const date = normDate(row[0]);
    if (!date) continue;
    const pick = (p: string) => Array.from({ length: 10 }, (_, k) => { const i = idx(p, k + 1); return i >= 0 ? num(row[i]) : null; });
    out.push({ date, y: pick("ACMY"), tp: pick("ACMTP"), rny: pick("ACMRNY") });
  }
  return out;
}

async function loadAcm(): Promise<AcmData> {
  return cached("nyfed:acm:xls", 6 * HOUR, async () => {
    const book = openXls(await fetchBuffer(ACM_XLS, 60000));
    const mName = book.sheetNames.find((n) => /monthly/i.test(n)) ?? book.sheetNames[0];
    const dName = book.sheetNames.find((n) => /daily/i.test(n));
    const monthly = acmRows(book.sheet(mName));
    const daily = dName ? acmRows(book.sheet(dName)) : [];
    if (!monthly.length && !daily.length) throw new Error("ACM xls parsed but yielded no rows");
    return { monthly, daily, source: "xls" as const };
  });
}

async function loadAcmCsvFallback() {
  return cached("nyfed:acm:csv", 6 * HOUR, async () => {
    const grid = parseCsv(await fetchText(ACM_CSV));
    const h = grid[0].map((x) => x.trim());
    const iTp = h.indexOf("TERMYld"), iFit = h.indexOf("ACMFITYld"), iGsw = h.indexOf("GSWYld");
    return grid.slice(1).map((r) => ({ date: normDate(r[0]), tp10: num(r[iTp]), fitted10: num(r[iFit]), gsw10: num(r[iGsw]) })).filter((r) => r.date);
  });
}

export async function nyfedTermPremia(args: { frequency?: string; recent?: number; maturities?: number[] }) {
  const freq = (args.frequency ?? "daily").toLowerCase() === "monthly" ? "monthly" : "daily";
  const recent = clampInt(args.recent, freq === "daily" ? 10 : 12, 1, 400);
  const mats = (args.maturities?.length ? args.maturities : [1, 2, 5, 10]).map((m) => clampInt(m, 10, 1, 10));
  const uniqMats = [...new Set(mats)].sort((a, b) => a - b);

  let data: AcmData;
  try {
    data = await loadAcm();
  } catch (e: any) {
    const rows = await loadAcmCsvFallback();
    const tail = rows.slice(-recent).reverse();
    return {
      dataSource: "NY Fed — ACM term premia (fallback: monthly 10y CSV; legacy .xls unavailable)",
      fallbackReason: String(e?.message ?? e).slice(0, 200),
      latest: tail[0] ?? null,
      series: tail,
      note: "10-year only: tp10 = ACM 10y term premium (%), fitted10 = ACM fitted 10y yield, gsw10 = Gürkaynak-Sack-Wright zero-coupon 10y yield. Full 1–10y curve requires the .xls: " + ACM_XLS,
    };
  }

  const rows = freq === "daily" && data.daily.length ? data.daily : data.monthly;
  if (!rows.length) return { dataSource: "NY Fed ACM", note: "No rows parsed", sampleRaw: null };
  const latest = rows[rows.length - 1];
  const back = (n: number) => rows[Math.max(0, rows.length - 1 - n)];
  const [ago1m, ago1y] = freq === "daily" ? [back(21), back(252)] : [back(1), back(12)];
  const tpOf = (r: AcmRow, m: number) => round(r.tp[m - 1], 3);

  const curve = Array.from({ length: 10 }, (_, k) => ({
    maturityYears: k + 1,
    termPremium: round(latest.tp[k], 3),
    fittedYield: round(latest.y[k], 3),
    riskNeutralYield: round(latest.rny[k], 3),
  }));

  const tp10 = rows.map((r) => r.tp[9]).filter((v): v is number => v != null);
  const pctRank = latest.tp[9] != null && tp10.length ? round((tp10.filter((v) => v <= latest.tp[9]!).length / tp10.length) * 100, 1) : null;

  return {
    dataSource: "Federal Reserve Bank of New York — Adrian-Crump-Moench (ACM) Treasury term premia",
    frequency: freq,
    asOf: latest.date,
    latestCurve: curve,
    tenYear: {
      termPremium: tpOf(latest, 10),
      change1m: latest.tp[9] != null && ago1m.tp[9] != null ? round(latest.tp[9]! - ago1m.tp[9]!, 3) : null,
      change1y: latest.tp[9] != null && ago1y.tp[9] != null ? round(latest.tp[9]! - ago1y.tp[9]!, 3) : null,
      percentileSince1961: pctRank,
    },
    series: rows.slice(-recent).reverse().map((r) => {
      const o: Record<string, number | string | null> = { date: r.date };
      for (const m of uniqMats) o[`tp${m}y`] = tpOf(r, m);
      return o;
    }),
    note: "All values in percent. Fitted yield = expected average short rate (risk-neutral yield) + term premium. Positive/rising term premium = investors demand extra compensation for duration risk (supply, fiscal, inflation uncertainty) — it drove much of the 10y move when the risk-neutral component is flat. Daily data lags ~1 business day; monthly = month-end. Series newest-first. Model estimates, not market quotes. Cached 6h (source is a ~10MB legacy .xls).",
  };
}

// ---------------------------------------------------------------------------
// Recession probability
// ---------------------------------------------------------------------------

interface YcRow { date: string; y10: number | null; y3m: number | null; y3mBey: number | null; spread: number | null; prob: number | null; nber: number | null }

async function loadYc(): Promise<{ rows: YcRow[]; source: string }> {
  return cached("nyfed:yc", 6 * HOUR, async () => {
    try {
      const grid = parseCsv(await fetchText(YC_CSV));
      const h = grid[0].map((x) => x.trim().toLowerCase());
      const col = (re: RegExp) => h.findIndex((x) => re.test(x));
      const i10 = col(/^10 year/), i3 = col(/^3 month treasury yield$/), i3b = col(/bond equivalent/), iS = col(/^spread/), iP = col(/rec_prob/), iN = col(/nber/);
      const rows = grid.slice(1).map((r) => {
        const p = num(r[iP]);
        return { date: normDate(r[0])!, y10: num(r[i10]), y3m: num(r[i3]), y3mBey: num(r[i3b]), spread: num(r[iS]), prob: p, nber: num(r[iN]) };
      }).filter((r) => r.date);
      if (rows.length < 100 || iP < 0) throw new Error("yield.csv shape unexpected");
      return { rows, source: "yield.csv" };
    } catch {
      const book = openXls(await fetchBuffer(YC_XLS, 45000));
      const grid = book.sheet(book.sheetNames[0]);
      const rows = grid.slice(1).map((r) => {
        const p = num(r[5]);
        return { date: normDate(r[0])!, y10: num(r[1]), y3m: num(r[2]), y3mBey: num(r[3]), spread: num(r[4]), prob: p == null ? null : p * 100, nber: num(r[6]) };
      }).filter((r) => r.date);
      return { rows, source: "allmonth.xls" };
    }
  });
}

export async function nyfedRecessionProbability(args: { recent?: number }) {
  const recent = clampInt(args.recent, 12, 1, 120);
  const { rows, source } = await loadYc();
  const withProb = rows.filter((r) => r.prob != null);
  const withSpread = rows.filter((r) => r.spread != null);
  const lastObs = withSpread[withSpread.length - 1];
  const lastProb = withProb[withProb.length - 1];
  const forward = rows.filter((r) => r.prob != null && r.spread == null);
  const history = withSpread.slice(-recent).reverse();
  const peak = withProb.slice(-120).reduce<YcRow | null>((a, r) => (!a || r.prob! > a.prob! ? r : a), null);
  return {
    dataSource: `Federal Reserve Bank of New York — yield-curve recession probability (${source})`,
    headline: lastProb
      ? { probabilityPct: round(lastProb.prob, 2), forMonth: lastProb.date.slice(0, 7), basedOnSpreadMonth: lastObs?.date.slice(0, 7) ?? null, spreadPct: round(lastObs?.spread, 2) }
      : null,
    latestCurveInputs: lastObs ? { month: lastObs.date.slice(0, 7), tenYear: lastObs.y10, threeMonth: lastObs.y3m, threeMonthBondEquiv: round(lastObs.y3mBey, 2), spread: round(lastObs.spread, 2) } : null,
    forwardPath: forward.map((r) => ({ month: r.date.slice(0, 7), probabilityPct: round(r.prob, 2) })),
    recentHistory: history.map((r) => ({ month: r.date.slice(0, 7), spread: round(r.spread, 2), probabilityPct: round(r.prob, 2), nberRecession: r.nber })),
    tenYearPeak: peak ? { month: peak.date.slice(0, 7), probabilityPct: round(peak.prob, 2) } : null,
    note: "Probit model (Estrella-Mishkin) of a U.S. recession 12 months ahead from the monthly-average 10y minus 3m (bond-equivalent) Treasury spread. The probability dated month T was produced from the spread in T−12, so headline = probability of being in recession in forMonth given the latest spread; forwardPath = the 12 months already implied by observed spreads. Historically ~30%+ has preceded every recession since 1968 (with false positives, e.g. 2023-24). spread/yields in %, monthly averages. Updated monthly by the NY Fed; recentHistory newest-first.",
  };
}
