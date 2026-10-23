/**
 * Robert Shiller "Irrational Exuberance" monthly stock-market data (ie_data.xls).
 *
 * Endpoint (verified live 2026-10-21):
 *   Shiller's maintained copy now lives on https://shillerdata.com/ (a GoDaddy
 *   site). The page links a blob URL of the form
 *     //img1.wsimg.com/blobby/go/<site>/downloads/<uuid>/ie_data.xls?ver=<n>
 *   whose uuid changes on re-upload, so we scrape the page for the current
 *   link. The legacy http://www.econ.yale.edu/~shiller/data/ie_data.xls is
 *   FROZEN at Sep-2023 and is used only as a last-resort fallback (flagged).
 *   The datahub/GitHub CSV mirror is not maintained (zeros after 2023).
 * Format: legacy .xls (BIFF8), decoded with ./xls.ts. Sheet "Data": 7-row
 *   stacked header, then monthly rows with Date as a decimal year-month
 *   (2026.1 = Oct 2026, 2026.01 = Jan 2026). Recent months carry price/CPI/
 *   GS10/CAPE but blank D and E (earnings arrive with a lag).
 */
import { cached, fetchBuffer, fetchText, HOUR, clampInt, percentileRank, quantile, round, toNum } from "./common";
import { parseXls, type XlsCell } from "./xls";

const SITE = "https://shillerdata.com/";
const YALE = "http://www.econ.yale.edu/~shiller/data/ie_data.xls";
/** Last blob link seen on shillerdata.com (2026-10-21); used when the page itself is unreachable. */
const KNOWN_BLOB =
  "https://img1.wsimg.com/blobby/go/e5e77e0b-59d1-44d9-ab25-4763ac982e53/downloads/1449043e-a1ed-4e2e-8e9c-7b9a2a064493/ie_data.xls";

interface ShillerRow {
  month: string; // YYYY-MM
  price: number | null;
  dividend: number | null;
  earnings: number | null;
  cpi: number | null;
  gs10: number | null;
  realPrice: number | null;
  cape: number | null;
  trCape: number | null;
  excessCapeYield: number | null;
}

interface ShillerData {
  url: string;
  source: "site" | "known-blob" | "yale";
  fromYaleFallback: boolean;
  rows: ShillerRow[];
  footnote: string | null;
}

/**
 * Candidate download URLs in preference order. shillerdata.com (GoDaddy) is
 * intermittently slow/503 regardless of User-Agent (observed 2026-10-21), so
 * the page scrape gets a short timeout; the wsimg.com blob host itself is fast.
 */
async function candidateUrls(): Promise<{ url: string; source: "site" | "known-blob" | "yale" }[]> {
  const out: { url: string; source: "site" | "known-blob" | "yale" }[] = [];
  try {
    const html = await cached("shiller:page", 6 * HOUR, () => fetchText(SITE, 8000, 0));
    const m = html.match(/(?:https?:)?\/\/img1\.wsimg\.com\/[^"'\s>]*\/ie_data\.xls[^"'\s>]*/i);
    if (m) {
      const u = m[0].startsWith("//") ? `https:${m[0]}` : m[0];
      out.push({ url: u.replace(/&amp;/g, "&"), source: "site" });
    }
  } catch {
    /* page unreachable — use the known blob */
  }
  out.push({ url: KNOWN_BLOB, source: "known-blob" });
  out.push({ url: YALE, source: "yale" });
  return out;
}

function monthOf(v: XlsCell): string | null {
  const n = typeof v === "number" ? v : toNum(v);
  if (n == null || n < 1800 || n > 2300) return null;
  const y = Math.floor(n);
  const m = Math.round((n - y) * 100);
  if (m < 1 || m > 12) return null;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function loadShiller(): Promise<ShillerData> {
  return cached("shiller:ie", 12 * HOUR, async () => {
    let buf: Buffer | null = null;
    let url = "";
    let source: ShillerData["source"] = "yale";
    const errors: string[] = [];
    for (const c of await candidateUrls()) {
      try {
        buf = await fetchBuffer(c.url, 30000);
        url = c.url;
        source = c.source;
        break;
      } catch (e: any) {
        errors.push(`${c.source}: ${e?.message ?? e}`);
      }
    }
    if (!buf) throw new Error(`Shiller ie_data.xls unavailable (${errors.join("; ")})`);
    const fallback = source === "yale";
    const wb = parseXls(buf, ["Data"]);
    const g = wb.get("Data");
    if (!g) throw new Error("Shiller ie_data.xls: no 'Data' sheet");
    let h = -1;
    for (let r = 0; r < 20; r++) if (String(g[r]?.[0] ?? "").trim() === "Date") h = r;
    if (h < 0) throw new Error("Shiller ie_data.xls: header row 'Date' not found");
    const width = Math.max(...g.slice(h - 6, h + 1).map((r) => (r ?? []).length));
    const label: string[] = [];
    for (let c = 0; c < width; c++) {
      label.push(
        g
          .slice(Math.max(0, h - 6), h + 1)
          .map((r) => String(r?.[c] ?? "").trim())
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
      );
    }
    const find = (re: RegExp, not?: RegExp) => label.findIndex((l) => re.test(l) && !(not && not.test(l)));
    const cP = find(/S&P Comp\. P$/);
    const cD = find(/Dividend D$/);
    const cE = find(/Earnings E$/);
    const cCpi = find(/CPI$/);
    const cGs10 = find(/GS10/);
    const cRealP = find(/^Real Price$/);
    const cCape = find(/P\/E10 or CAPE$/, /TR/);
    const cTr = find(/TR P\/E10 or TR CAPE$/);
    const cEcy = find(/Excess CAPE Yield$/);
    if (cCape < 0) {
      const err = new Error("Shiller ie_data.xls: CAPE column not found (header drift)") as Error & { sampleRaw?: unknown };
      err.sampleRaw = label;
      throw err;
    }
    const v = (row: XlsCell[], c: number) => (c >= 0 ? toNum(row[c]) : null);
    const rows: ShillerRow[] = [];
    let footnote: string | null = null;
    for (let r = h + 1; r < g.length; r++) {
      const row = g[r] ?? [];
      const month = monthOf(row[0] ?? null);
      if (!month) {
        const txt = row.filter((x) => typeof x === "string" && x.trim()).join("; ");
        if (txt && rows.length) footnote = txt.slice(0, 300);
        continue;
      }
      rows.push({
        month,
        price: v(row, cP),
        dividend: v(row, cD),
        earnings: v(row, cE),
        cpi: v(row, cCpi),
        gs10: v(row, cGs10),
        realPrice: v(row, cRealP),
        cape: v(row, cCape),
        trCape: v(row, cTr),
        excessCapeYield: v(row, cEcy),
      });
    }
    return { url, source, fromYaleFallback: fallback, rows, footnote };
  });
}

export interface ShillerCapeArgs {
  months?: number;
  since?: number;
}

export async function shillerCape(args: ShillerCapeArgs) {
  const d = await loadShiller();
  const withCape = d.rows.filter((r) => r.cape != null);
  if (!withCape.length) throw new Error("Shiller data has no CAPE values");
  const latest = withCape[withCape.length - 1]!;
  const sinceYear = clampInt(args.since, 1881, 1871, 2100);
  const hist = withCape.filter((r) => Number(r.month.slice(0, 4)) >= sinceYear).map((r) => r.cape!);
  const sorted = [...hist].sort((a, b) => a - b);
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const post1990 = withCape.filter((r) => r.month >= "1990-01").map((r) => r.cape!);
  const lastEarn = [...d.rows].reverse().find((r) => r.earnings != null);
  const lastDiv = [...d.rows].reverse().find((r) => r.dividend != null);
  const maxRow = withCape.reduce((a, b) => (b.cape! > a.cape! ? b : a));
  const monthsN = clampInt(args.months, 12, 1, 240);

  return {
    dataSource: `Robert J. Shiller, ie_data.xls (${d.fromYaleFallback ? "LEGACY Yale copy — frozen Sep-2023; shillerdata.com was unreachable" : d.source === "known-blob" ? "shillerdata.com file via last-known link (page unreachable)" : "shillerdata.com, maintained"})`,
    latest: {
      month: latest.month,
      cape: round(latest.cape, 2),
      trCape: round(latest.trCape, 2),
      excessCapeYieldPct: latest.excessCapeYield != null ? round(latest.excessCapeYield * 100, 2) : null,
      earningsYield10yPct: round(100 / latest.cape!, 2),
      sp500: round(latest.price, 2),
      gs10Pct: latest.gs10,
      cpi: round(latest.cpi, 3),
    },
    history: {
      since: `${sinceYear}`,
      months: hist.length,
      percentile: percentileRank(hist, latest.cape!),
      percentileSince1990: percentileRank(post1990, latest.cape!),
      mean: round(mean, 2),
      median: round(quantile(sorted, 0.5), 2),
      p10: round(quantile(sorted, 0.1), 2),
      p90: round(quantile(sorted, 0.9), 2),
      min: round(sorted[0], 2),
      max: round(sorted[sorted.length - 1], 2),
      maxMonth: maxRow.month,
      deviationFromMeanPct: round((latest.cape! / mean - 1) * 100, 1),
    },
    latestReportedEarnings: lastEarn ? { month: lastEarn.month, ttmEps: round(lastEarn.earnings, 2) } : null,
    latestReportedDividend: lastDiv ? { month: lastDiv.month, ttmDps: round(lastDiv.dividend, 2) } : null,
    recent: withCape.slice(-monthsN).reverse().map((r) => ({
      month: r.month,
      cape: round(r.cape, 2),
      trCape: round(r.trCape, 2),
      sp500: round(r.price, 2),
      gs10Pct: r.gs10,
      excessCapeYieldPct: r.excessCapeYield != null ? round(r.excessCapeYield * 100, 2) : null,
    })),
    sourceNote: d.footnote,
    sourceUrl: d.url,
    note:
      "CAPE = real S&P Composite price / 10-year average real earnings (Shiller P/E10); TR CAPE adjusts for payout-ratio shifts via a total-return price; Excess CAPE Yield = 1/CAPE minus the real 10-year yield (higher = equities cheaper vs bonds). Prices are monthly averages of daily closes (the latest month may be a partial/early-month value — see sourceNote). Earnings and dividends lag several months, so CAPE for recent months uses the latest available 10-year earnings. Percentile = share of months since `since` (default 1881) with CAPE ≤ latest. Monthly, updated by Shiller roughly monthly.",
  };
}
