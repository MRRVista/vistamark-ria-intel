/**
 * Aswath Damodaran (NYU Stern) data, keyless.
 *
 * Endpoints (verified live 2026-10-21):
 *   Implied ERP, annual:  https://pages.stern.nyu.edu/~adamodar/pc/datasets/histimpl.xlsx
 *                         (sheet "Historical Impl Premiums", 1960–last Dec; updated each January)
 *   Implied ERP, monthly: https://pages.stern.nyu.edu/~adamodar/pc/implprem/ERPbymonth.xlsx
 *                         (start-of-month rows from 2008-09; updated monthly)
 *   Industry datasets:    https://pages.stern.nyu.edu/~adamodar/pc/datasets/<file>.xls
 *                         ONLY legacy .xls (BIFF8) is published for these — the
 *                         .xlsx URLs 404 — so they are decoded with ./xls.ts.
 *                         Sheet "Industry Averages": title block, a header row
 *                         starting "Industry Name", ~95 industries, then
 *                         "Total Market" / "Total Market (without financials)".
 *                         Ratios are decimals (0.0802 = 8.02%). Refreshed each January.
 *   Regional variants: <file>Global/Europe/Japan/emerg/China/India/Rest.xls exist
 *   for wacc, betas (beta<Region>), ev_ebitda, margins, roe, taxrate, dividends,
 *   debt, growth, totalbeta — but NOT pe / pbv / ps (US only).
 */
import { cached, fetchBuffer, HOUR, clampInt, excelSerialToIso, normDate, round, toNum } from "./common";
import { readXlsxGrid, type Cell } from "./xlsx";
import { parseXls, type XlsCell } from "./xls";

const DS = "https://pages.stern.nyu.edu/~adamodar/pc/datasets";
const HISTIMPL_URL = `${DS}/histimpl.xlsx`;
const ERPMONTH_URL = "https://pages.stern.nyu.edu/~adamodar/pc/implprem/ERPbymonth.xlsx";

// ---------------------------------------------------------------------------
// damodaran_erp
// ---------------------------------------------------------------------------

type Grid = (Cell | XlsCell)[][];

function headerRow(grid: Grid, test: (c0: string) => boolean, maxScan = 40): number {
  for (let r = 0; r < Math.min(grid.length, maxScan); r++) {
    const c0 = grid[r]?.[0];
    if (typeof c0 === "string" && test(c0.trim())) return r;
  }
  return -1;
}

function colFinder(header: (Cell | XlsCell)[]) {
  const names = header.map((h) => String(h ?? "").trim());
  return (re: RegExp) => names.findIndex((n) => re.test(n));
}

export interface DamodaranErpArgs {
  years?: number;
  months?: number;
}

export async function damodaranErp(args: DamodaranErpArgs) {
  const yearsN = clampInt(args.years, 10, 1, 70);
  const monthsN = clampInt(args.months, 12, 0, 220);

  const [annual, monthly] = await Promise.allSettled([
    cached("dam:histimpl", 24 * HOUR, async () => {
      const buf = await fetchBuffer(HISTIMPL_URL);
      return readXlsxGrid(buf, "Historical Impl Premiums").grid;
    }),
    monthsN > 0
      ? cached("dam:erpmonth", 12 * HOUR, async () => {
          const buf = await fetchBuffer(ERPMONTH_URL);
          return readXlsxGrid(buf).grid;
        })
      : Promise.resolve(null),
  ]);

  const out: Record<string, unknown> = {
    dataSource: "Aswath Damodaran, NYU Stern — implied equity risk premium for the S&P 500 (histimpl.xlsx annual; ERPbymonth.xlsx monthly)",
  };

  if (annual.status === "fulfilled") {
    const g = annual.value as Grid;
    const h = headerRow(g, (c) => /^year$/i.test(c));
    if (h < 0) {
      out.annualError = "header row 'Year' not found";
      out.sampleRaw = g.slice(0, 10).map((r) => (r ?? []).slice(0, 8));
    } else {
      const f = colFinder(g[h]!);
      const cYear = 0;
      const cFcfe = f(/^Implied ERP \(FCFE\)$/i);
      const cDdm = f(/^Implied Premium \(DDM\)$/i);
      const cSust = f(/sustainable payout/i);
      const cAdjRf = f(/risk adjusted riskfree/i);
      const cBond = f(/^T\.?\s*Bond Rate$/i);
      const cBill = f(/^T\.?\s*Bill Rate$/i);
      const cSp = f(/^S&P 500$/i);
      const cEy = f(/^Earnings Yield$/i);
      const cDy = f(/^Dividend Yield$/i);
      const cGrowth = f(/^Analyst Growth Estimate$/i);
      const rows: Record<string, number | null>[] = [];
      for (let r = h + 1; r < g.length; r++) {
        const y = toNum(g[r]?.[cYear]);
        if (y == null || y < 1900 || y > 2200) continue;
        const v = (c: number) => (c >= 0 ? round(toNum(g[r]?.[c]), 4) : null);
        rows.push({
          year: y,
          impliedErpFcfe: v(cFcfe),
          impliedErpDdm: v(cDdm),
          impliedErpSustainablePayout: v(cSust),
          impliedErpAdjRiskfree: v(cAdjRf),
          tBondRate: v(cBond),
          tBillRate: v(cBill),
          sp500: v(cSp),
          earningsYield: v(cEy),
          dividendYield: v(cDy),
          analystGrowth: v(cGrowth),
        });
      }
      // Period averages block in the footer: ("", "Period", "ERP", "ERP + Riskfree Rate")
      const averages: { period: string; erp: number | null; erpPlusRiskfree: number | null }[] = [];
      for (let r = h + 1; r < g.length; r++) {
        const row = g[r] ?? [];
        const lab = row[1];
        if (typeof lab === "string" && /^(\d{4}-\d{4}|End of \d{4})$/.test(lab.trim()) && toNum(row[2]) != null) {
          averages.push({ period: lab.trim(), erp: round(toNum(row[2]), 4), erpPlusRiskfree: round(toNum(row[3]), 4) });
        }
      }
      const fcfe = rows.map((r) => r.impliedErpFcfe).filter((v): v is number => v != null);
      const latest = rows[rows.length - 1] ?? null;
      out.annual = {
        latest,
        historyStats: fcfe.length
          ? {
              years: fcfe.length,
              mean: round(fcfe.reduce((a, b) => a + b, 0) / fcfe.length, 4),
              min: round(Math.min(...fcfe), 4),
              max: round(Math.max(...fcfe), 4),
              latestPercentile: latest?.impliedErpFcfe != null ? round((fcfe.filter((v) => v <= latest.impliedErpFcfe!).length / fcfe.length) * 100, 1) : null,
            }
          : null,
        periodAverages: averages,
        recent: rows.slice(-yearsN).reverse(),
      };
    }
  } else {
    out.annualError = String((annual.reason as Error)?.message ?? annual.reason);
  }

  if (monthly.status === "fulfilled" && monthly.value) {
    const g = monthly.value as Grid;
    const h = headerRow(g, (c) => /^start of month$/i.test(c));
    if (h < 0) {
      out.monthlyError = "header row 'Start of month' not found";
    } else {
      const f = colFinder(g[h]!);
      const cT12 = f(/^ERP \(T12m\)$/i);
      const cSust = f(/sustainable payout/i);
      const cAdj = f(/adj riskfree/i);
      const cSmooth = f(/^ERP \(Smoothed\)$/i);
      const cBond = f(/^T\.?\s*Bond Rate$/i);
      const cRf = f(/\$\s*Riskfree Rate/i);
      const cSp = f(/^S&P 500$/i);
      const cG = f(/^Expected growth rate$/i);
      const rows: Record<string, number | string | null>[] = [];
      for (let r = h + 1; r < g.length; r++) {
        const row = g[r] ?? [];
        const d = normDate(row[0] as Cell);
        if (!d) continue;
        const v = (c: number) => (c >= 0 ? round(toNum(row[c]), 4) : null);
        rows.push({
          month: d.slice(0, 7),
          impliedErpT12m: v(cT12),
          impliedErpSustainablePayout: v(cSust),
          impliedErpAdjRiskfree: v(cAdj),
          impliedErpSmoothed: v(cSmooth),
          tBondRate: v(cBond),
          dollarRiskfreeRate: v(cRf),
          sp500: v(cSp),
          expectedGrowth: v(cG),
        });
      }
      out.monthly = {
        latest: rows[rows.length - 1] ?? null,
        recent: rows.slice(-monthsN).reverse(),
        coverage: rows.length ? `${rows[0]!.month} to ${rows[rows.length - 1]!.month}` : null,
      };
    }
  } else if (monthly.status === "rejected") {
    out.monthlyError = String((monthly.reason as Error)?.message ?? monthly.reason);
  }

  if (!out.annual && !out.monthly) throw new Error(`Damodaran ERP unavailable: ${out.annualError ?? ""} ${out.monthlyError ?? ""}`.trim());

  out.sourceUrls = [HISTIMPL_URL, ERPMONTH_URL];
  out.note =
    "All rates are DECIMALS (0.0423 = 4.23%). periodAverages labels are verbatim from the spreadsheet footer (Damodaran has been known to leave a stale 'End of YYYY' label; the last entry is the latest year-end). Damodaran's headline is the FCFE-based implied ERP (annual: impliedErpFcfe at each year-end; monthly: impliedErpT12m at the start of each month, using trailing-12m cash returned). 'Sustainable payout' and 'adjusted riskfree' are his alternative variants; 'Smoothed' (monthly) uses normalized 10-year average cash flows. The monthly file is the current reading (updated at each month start); the annual file is updated each January. Implied ERP = forward-looking premium priced into the S&P 500, not a historical realized premium. Cost of capital by industry uses the January ERP — see damodaran_industry.";
  return out;
}

// ---------------------------------------------------------------------------
// damodaran_industry
// ---------------------------------------------------------------------------

interface IndustryDef {
  us: string;
  regional?: string; // base name for <base><Region>.xls
  label: string;
}

const INDUSTRY_DATASETS: Record<string, IndustryDef> = {
  wacc: { us: "wacc", regional: "wacc", label: "Cost of equity, cost of debt and cost of capital (WACC)" },
  betas: { us: "betas", regional: "beta", label: "Levered / unlevered / cash-corrected betas, D/E, std dev" },
  pe: { us: "pedata", label: "PE ratios (current, trailing, forward), PEG, expected growth" },
  ev_ebitda: { us: "vebitda", regional: "vebitda", label: "EV/EBITDA, EV/EBIT, EV/EBITDAR&D multiples" },
  margins: { us: "margin", regional: "margin", label: "Gross, net, operating, EBITDA margins; cost ratios" },
  pbv: { us: "pbvdata", label: "Price/book, ROE, EV/invested capital, ROIC" },
  ps: { us: "psdata", label: "Price/sales, EV/sales, margins" },
  roe: { us: "roe", regional: "roe", label: "Return on equity (unadjusted and R&D-adjusted)" },
  taxrate: { us: "taxrate", regional: "taxrate", label: "Effective and cash tax rates" },
  dividends: { us: "divfund", regional: "divfund", label: "Dividends, buybacks, payout, FCFE" },
  debt: { us: "dbtfund", regional: "dbtfund", label: "Debt ratios, interest coverage, debt/EBITDA" },
  growth: { us: "fundgrEB", regional: "fundgrEB", label: "ROC, reinvestment rate, fundamental EBIT growth" },
  totalbeta: { us: "totalbeta", regional: "totalbeta", label: "Total beta (for undiversified owners), correlation with market" },
};

const REGION_SUFFIX: Record<string, string> = {
  us: "",
  global: "Global",
  europe: "Europe",
  japan: "Japan",
  emerging: "emerg",
  china: "China",
  india: "India",
  rest: "Rest",
};

interface IndustryTable {
  url: string;
  updated: string | null;
  columns: string[];
  rows: { industry: string; values: (number | null)[] }[];
  sampleRaw?: unknown;
}

function parseIndustryGrid(grid: XlsCell[][], url: string): IndustryTable {
  const h = headerRow(grid, (c) => /^industry\s*name$/i.test(c));
  let updated: string | null = null;
  const d0 = grid[0]?.[1];
  if (typeof d0 === "number" && d0 > 30000 && d0 < 80000) updated = excelSerialToIso(d0);
  if (h < 0) return { url, updated, columns: [], rows: [], sampleRaw: grid.slice(0, 12).map((r) => (r ?? []).slice(0, 6)) };

  const header = grid[h]!;
  const group = h > 0 ? grid[h - 1]! : [];
  const width = header.length;
  const raw: string[] = [];
  let carry = "";
  for (let c = 1; c < width; c++) {
    const g = group[c];
    if (typeof g === "string" && g.trim()) carry = g.trim();
    raw.push(String(header[c] ?? "").replace(/\s+/g, " ").trim() || `col${c}`);
  }
  // Disambiguate duplicate names with the group label carried from the row above.
  const columns = raw.map((name, i) => {
    const dup = raw.filter((n) => n === name).length > 1;
    if (!dup) return name;
    let lab = "";
    for (let c = i + 1; c >= 1; c--) {
      const g = group[c];
      if (typeof g === "string" && g.trim()) {
        lab = g.trim();
        break;
      }
    }
    return lab ? `${name} [${lab}]` : name;
  });
  // Year-number headers (beta history) arrive as numbers: label them.
  for (let i = 0; i < columns.length; i++) {
    if (/^\d{4}(\.0)?$/.test(columns[i]!)) columns[i] = `Unlevered beta (cash-corrected) ${columns[i]!.slice(0, 4)}`;
  }

  const rows: IndustryTable["rows"] = [];
  for (let r = h + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const name = row[0];
    if (typeof name !== "string" || !name.trim()) continue;
    const values = columns.map((_, i) => {
      const n = toNum(row[i + 1] as Cell);
      return n == null ? null : round(n, 6);
    });
    if (values.every((v) => v == null)) continue;
    rows.push({ industry: name.replace(/\s+/g, " ").trim(), values });
  }
  return { url, updated, columns, rows };
}

function loadIndustry(file: string): Promise<IndustryTable> {
  return cached(`dam:ind:${file}`, 24 * HOUR, async () => {
    const url = `${DS}/${file}.xls`;
    const buf = await fetchBuffer(url);
    const wb = parseXls(buf, ["Industry Averages"]);
    const grid = wb.get("Industry Averages") ?? [...wb.values()][0];
    if (!grid) throw new Error(`Damodaran ${file}.xls: no 'Industry Averages' sheet`);
    return parseIndustryGrid(grid, url);
  });
}

export interface DamodaranIndustryArgs {
  dataset?: string;
  region?: string;
  industry?: string;
  columns?: string[];
  sortBy?: string;
  descending?: boolean;
  limit?: number;
}

export async function damodaranIndustry(args: DamodaranIndustryArgs) {
  const key = String(args.dataset ?? "wacc").toLowerCase().replace(/[\s/-]+/g, "_").replace(/^ev_?ebitda$/, "ev_ebitda").replace(/^beta$/, "betas").replace(/^margin$/, "margins").replace(/^cost_of_capital$/, "wacc");
  const def = INDUSTRY_DATASETS[key];
  if (!def) throw new Error(`dataset must be one of: ${Object.keys(INDUSTRY_DATASETS).join(", ")}`);
  const regionKey = String(args.region ?? "us").toLowerCase().replace(/[\s_-]+/g, "");
  const regionNorm = regionKey === "emergingmarkets" || regionKey === "em" ? "emerging" : regionKey === "unitedstates" || regionKey === "usa" ? "us" : regionKey;
  const suffix = REGION_SUFFIX[regionNorm];
  if (suffix == null) throw new Error(`region must be one of: ${Object.keys(REGION_SUFFIX).join(", ")}`);
  if (suffix && !def.regional) throw new Error(`Dataset ${key} is published for US only (no regional file).`);
  const file = suffix ? `${def.regional}${suffix}` : def.us;

  const t = await loadIndustry(file);
  if (!t.rows.length) {
    return { dataSource: `Damodaran ${file}.xls`, note: "Downloaded but no industry rows recognized — layout may have changed.", sampleRaw: t.sampleRaw };
  }

  let colIdx = t.columns.map((_, i) => i);
  if (args.columns?.length) {
    const want = args.columns.map((c) => c.toLowerCase());
    colIdx = colIdx.filter((i) => want.some((w) => t.columns[i]!.toLowerCase().includes(w)));
    if (!colIdx.length) throw new Error(`No columns match ${args.columns.join(", ")}. Available: ${t.columns.join(" | ")}`);
  }

  const totals = t.rows.filter((r) => /^total market/i.test(r.industry));
  let rows = t.rows.filter((r) => !/^total market/i.test(r.industry));
  if (args.industry) {
    const words = args.industry.toLowerCase().split(/[\s,/&()]+/).filter((w) => w.length > 1);
    rows = rows.filter((r) => words.every((w) => r.industry.toLowerCase().includes(w)));
  }
  if (args.sortBy) {
    const sb = args.sortBy.toLowerCase();
    const si = t.columns.findIndex((c) => c.toLowerCase() === sb) >= 0 ? t.columns.findIndex((c) => c.toLowerCase() === sb) : t.columns.findIndex((c) => c.toLowerCase().includes(sb));
    if (si < 0) throw new Error(`sortBy "${args.sortBy}" matches no column. Available: ${t.columns.join(" | ")}`);
    const desc = args.descending ?? true;
    rows = [...rows].sort((a, b) => {
      const x = a.values[si];
      const y = b.values[si];
      if (x == null) return 1;
      if (y == null) return -1;
      return desc ? y - x : x - y;
    });
  }
  const limit = clampInt(args.limit, args.industry ? 20 : 15, 1, 120);
  const shape = (r: IndustryTable["rows"][number]) => {
    const o: Record<string, string | number | null> = { industry: r.industry };
    colIdx.forEach((i) => (o[t.columns[i]!] = r.values[i] ?? null));
    return o;
  };

  return {
    dataSource: `Aswath Damodaran, NYU Stern — ${def.label} (${regionNorm.toUpperCase()}, ${file}.xls)`,
    dataset: key,
    region: regionNorm,
    dataAsOf: t.updated,
    columns: colIdx.map((i) => t.columns[i]!),
    matched: rows.length,
    industries: rows.slice(0, limit).map(shape),
    totalMarket: totals.map(shape),
    sourceUrl: t.url,
    note:
      "Percent-type fields (cost of equity/capital, margins, tax rates, D/(D+E), growth, ROE) are DECIMALS (0.0802 = 8.02%); multiples and betas are plain numbers. Damodaran refreshes these once a year in early January using year-end data (dataAsOf). Filter with industry (all words must match, e.g. 'bank regional', 'software'), choose columns by substring, sortBy a column for rankings, and use region for Global/Europe/Japan/Emerging/China/India/Rest variants (pe, pbv, ps are US-only). Call without industry to get a ranked or alphabetical slice plus the Total Market rows.",
    availableDatasets: Object.fromEntries(Object.entries(INDUSTRY_DATASETS).map(([k, v]) => [k, v.label])),
  };
}
