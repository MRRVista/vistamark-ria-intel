/**
 * AQR Capital Management public factor datasets, keyless.
 *
 * Endpoint (verified live 2026-10-21, no login / no cookie wall):
 *   https://www.aqr.com/-/media/AQR/Documents/Insights/Data-Sets/<Name>.xlsx
 *   Landing pages: https://www.aqr.com/Insights/Datasets/<Name>
 * Layout: first sheet holds a ~17-row title/disclaimer block, then a header
 * row ("DATE", country codes / factor names), then monthly rows with dates as
 * "MM/DD/YYYY" strings (or Excel serials in the TSMOM file) and returns as
 * DECIMALS. Trailing rows are blank-string padding. QMJ/BAB/HML-Devil workbooks
 * also carry companion sheets (MKT, SMB, HML FF, UMD, RF) by country.
 * Daily variants exist but are 25–32 MB each, so only monthly files are wired.
 */
import { cached, fetchBuffer, HOUR, clampInt, normDate, returnStats, round, windowFilter } from "./common";
import { readXlsxGrid, xlsxSheetNames, type Cell } from "./xlsx";

const BASE = "https://www.aqr.com/-/media/AQR/Documents/Insights/Data-Sets";

interface AqrDatasetDef {
  file: string;
  label: string;
  defaultColumns: string[];
  paper: string;
}

export const AQR_DATASETS: Record<string, AqrDatasetDef> = {
  qmj: {
    file: "Quality-Minus-Junk-Factors-Monthly",
    label: "Quality Minus Junk (QMJ) factors, monthly",
    defaultColumns: ["USA", "Global", "Global Ex USA", "Europe", "North America", "Pacific"],
    paper: "Asness, Frazzini & Pedersen (2019), Quality Minus Junk",
  },
  bab: {
    file: "Betting-Against-Beta-Equity-Factors-Monthly",
    label: "Betting Against Beta (BAB) equity factors, monthly",
    defaultColumns: ["USA", "Global", "Global Ex USA", "Europe", "North America", "Pacific"],
    paper: "Frazzini & Pedersen (2014), Betting Against Beta",
  },
  hml_devil: {
    file: "The-Devil-in-HMLs-Details-Factors-Monthly",
    label: "HML Devil (timely book-to-market value) factors, monthly",
    defaultColumns: ["USA", "Global", "Global Ex USA", "Europe", "North America", "Pacific"],
    paper: "Asness & Frazzini (2013), The Devil in HML's Details",
  },
  vme: {
    file: "Value-and-Momentum-Everywhere-Factors-Monthly",
    label: "Value and Momentum Everywhere factors, monthly",
    defaultColumns: ["VAL", "MOM", "VAL^SS", "MOM^SS", "VAL^AA", "MOM^AA", "VALLS_VME_US90", "MOMLS_VME_US90"],
    paper: "Asness, Moskowitz & Pedersen (2013), Value and Momentum Everywhere",
  },
  tsmom: {
    file: "Time-Series-Momentum-Factors-Monthly",
    label: "Time Series Momentum (TSMOM) factors, monthly",
    defaultColumns: ["TSMOM", "TSMOM^CM", "TSMOM^EQ", "TSMOM^FI", "TSMOM^FX"],
    paper: "Moskowitz, Ooi & Pedersen (2012), Time Series Momentum",
  },
  century: {
    file: "Century-of-Factor-Premia-Monthly",
    label: "A Century of Factor Premia (value/momentum/carry/defensive across asset classes), monthly",
    defaultColumns: [
      "US Stock Selection Value",
      "US Stock Selection Momentum",
      "US Stock Selection Defensive",
      "All asset classes Value",
      "All asset classes Momentum",
      "All asset classes Carry",
      "All asset classes Defensive",
      "All asset classes Multi-style",
    ],
    paper: "Ilmanen, Israel, Lee, Moskowitz & Thapar (2021), How Do Factor Premia Vary Over Time? A Century of Evidence",
  },
};

interface AqrTable {
  sheet: string;
  sheets: string[];
  columns: string[];
  rows: { date: string; period: string; values: (number | null)[] }[];
  sampleRaw?: Cell[][];
}

function isDateCell(c: Cell): string | null {
  if (c == null) return null;
  if (typeof c === "number") return c > 3000 && c < 80000 ? normDate(c) : null;
  return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c.trim()) ? normDate(c) : null;
}

function parseAqrGrid(grid: Cell[][]): { columns: string[]; rows: AqrTable["rows"] } {
  let first = -1;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (isDateCell(row[0] ?? null) && row.slice(1).some((v) => typeof v === "number")) {
      first = r;
      break;
    }
  }
  if (first < 0) return { columns: [], rows: [] };
  let hdr = first - 1;
  while (hdr >= 0 && (grid[hdr] ?? []).slice(1).filter((v) => typeof v === "string").length < 1) hdr--;
  const header = hdr >= 0 ? grid[hdr]! : [];
  const width = Math.max(header.length, ...grid.slice(first, first + 50).map((r) => (r ?? []).length));
  const columns: string[] = [];
  for (let c = 1; c < width; c++) columns.push(String(header[c] ?? `col${c}`).trim());
  const rows: AqrTable["rows"] = [];
  for (let r = first; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const d = isDateCell(row[0] ?? null);
    if (!d) continue;
    const values = columns.map((_, i) => {
      const v = row[i + 1];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    });
    rows.push({ date: d, period: d.slice(0, 7), values });
  }
  // Trim trailing rows with no data at all (AQR pads the sheet).
  while (rows.length && rows[rows.length - 1]!.values.every((v) => v == null)) rows.pop();
  return { columns, rows };
}

function loadAqr(key: string, sheet?: string): Promise<AqrTable> {
  const def = AQR_DATASETS[key]!;
  return cached(`aqr:${key}:${sheet ?? ""}`, 24 * HOUR, async () => {
    const buf = await cached(`aqr:buf:${key}`, 24 * HOUR, () => fetchBuffer(`${BASE}/${def.file}.xlsx`, 60000));
    const sheets = xlsxSheetNames(buf);
    const { sheet: used, grid } = readXlsxGrid(buf, sheet);
    if (sheet && used.toLowerCase() !== sheet.toLowerCase()) {
      throw new Error(`Sheet "${sheet}" not in ${def.file}. Sheets: ${sheets.join(", ")}`);
    }
    const { columns, rows } = parseAqrGrid(grid);
    const out: AqrTable = { sheet: used, sheets, columns, rows };
    if (!rows.length) out.sampleRaw = grid.slice(0, 25).map((r) => (r ?? []).slice(0, 6));
    return out;
  });
}

export interface AqrFactorsArgs {
  dataset?: string;
  columns?: string[];
  sheet?: string;
  recent?: number;
  start?: string;
  end?: string;
  years?: number;
}

export async function aqrFactors(args: AqrFactorsArgs) {
  const key = String(args.dataset ?? "qmj").toLowerCase().replace(/[\s-]+/g, "_");
  const def = AQR_DATASETS[key];
  if (!def) throw new Error(`dataset must be one of: ${Object.keys(AQR_DATASETS).join(", ")}`);
  const t = await loadAqr(key, args.sheet);
  if (!t.rows.length) {
    return {
      dataSource: `AQR — ${def.label}`,
      note: "Workbook downloaded but no dated rows were recognized — layout may have changed.",
      sheets: t.sheets,
      sampleRaw: t.sampleRaw,
    };
  }

  const want = (args.columns?.length ? args.columns : def.defaultColumns).map((c) => c.toLowerCase());
  let idx = t.columns.map((_, i) => i).filter((i) => want.includes(t.columns[i]!.toLowerCase()));
  if (args.columns?.length && idx.length < want.length) {
    // allow partial matches for user-specified names
    for (const w of want) {
      if (idx.some((i) => t.columns[i]!.toLowerCase() === w)) continue;
      const j = t.columns.findIndex((c) => c.toLowerCase().includes(w));
      if (j >= 0 && !idx.includes(j)) idx.push(j);
    }
  }
  if (!idx.length) idx = t.columns.slice(0, 8).map((_, i) => i);
  const cols = idx.map((i) => t.columns[i]!);

  // Latest non-null row per selected column set (AQR fills some markets later).
  let lastIdx = t.rows.length - 1;
  while (lastIdx > 0 && idx.every((i) => t.rows[lastIdx]!.values[i] == null)) lastIdx--;
  const series = t.rows.slice(0, lastIdx + 1);

  const recentN = clampInt(args.recent, 12, 1, 120);
  const pct = (v: number | null | undefined) => (v == null ? null : round(v * 100, 3));
  const recent = series.slice(-recentN).map((r) => {
    const o: Record<string, string | number | null> = { month: r.period };
    idx.forEach((i) => (o[t.columns[i]!] = pct(r.values[i])));
    return o;
  });

  const years = args.start || args.end ? args.years : args.years ?? 10;
  const win = windowFilter(series, { start: args.start, end: args.end, years });
  const windowStats: Record<string, unknown> = {};
  const fullStats: Record<string, unknown> = {};
  for (const i of idx) {
    const s = returnStats(win.map((r) => r.values[i]).filter((v): v is number => v != null), 12);
    windowStats[t.columns[i]!] = {
      months: s.periods,
      cumulativeReturnPct: pct(s.cumulativeReturn),
      annualizedReturnPct: pct(s.annualizedReturn),
      annualizedVolPct: pct(s.annualizedVol),
      sharpe: s.sharpeLike,
      worstMonthPct: pct(s.worst),
    };
    const fullVals = series.map((r) => r.values[i]).filter((v): v is number => v != null);
    const f = returnStats(fullVals, 12);
    const firstWith = series.find((r) => r.values[i] != null)?.period ?? null;
    fullStats[t.columns[i]!] = { since: firstWith, annualizedReturnPct: pct(f.annualizedReturn), annualizedVolPct: pct(f.annualizedVol), sharpe: f.sharpeLike };
  }

  return {
    dataSource: `AQR Capital Management — ${def.label} (${t.sheet} sheet)`,
    dataset: key,
    paper: def.paper,
    latestMonth: series[series.length - 1]!.period,
    shownColumns: cols,
    availableColumns: t.columns.length > 60 ? t.columns.slice(0, 60).concat(["…"]) : t.columns,
    window: win.length ? { from: win[0]!.period, to: win[win.length - 1]!.period, months: win.length } : null,
    windowStats,
    fullHistoryStats: fullStats,
    recent,
    sheets: t.sheets,
    sourceUrl: `${BASE}/${def.file}.xlsx`,
    note:
      "Monthly long/short self-financing EXCESS returns, shown in PERCENT (0.85 = 0.85%); Sharpe is annualized mean/vol. Window stats default to the last 10 years (years/start/end override); fullHistoryStats run from each column's first observation. Country columns use ISO3 codes (USA, GBR, JPN…) plus aggregates (Global, Global Ex USA, Europe, North America, Pacific). AQR reconstructs full history on each update, so past values can revise. `sheet` reads a companion sheet (e.g. MKT, SMB, UMD, RF in qmj/bab/hml_devil). For Fama-French factors use kfrench_factors.",
  };
}
