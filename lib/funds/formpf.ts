/**
 * Form PF — SEC Division of Investment Management "Private Fund Statistics".
 *
 * Form PF filings themselves are confidential; the SEC publishes aggregated
 * quarterly statistics. Verified 2026-10: the release page lists, per quarter,
 * a PDF report AND a machine-readable "supporting data" .xlsx (since ~2023Q4;
 * earlier quarters are PDF-only). The xlsx has ~140 tabs ("Tab.1.1" ...
 * "Tab.10.6") with a "Notes" index sheet; each tab is a time series with
 * quarters (2013Q1 ... latest) across columns and categories (fund type,
 * strategy, bucket) down rows.
 *
 * formpf_statistics parses the headline tables (fund counts, GAV, NAV by fund
 * type; borrowings) for the latest quarter with QoQ / YoY change, lists the
 * report links, and can return any other tab on request (table="Tab.8.10").
 */
import { bufferFetch, cached, H24, pageLinks, readXlsx, SEC, textFetch, type Workbook } from "./sec";

const PAGE = `${SEC}/data-research/investment-management-data/division-investment-management-private-fund-statistics`;
const DS = "SEC Division of Investment Management — Private Fund Statistics (Form PF aggregates, live xlsx)";

interface Release {
  label: string; // "2025 Q3"
  quarter: string | null; // "2025Q3"
  pdfUrl: string | null;
  xlsxUrl: string | null;
}

function quarterKey(s: string): string | null {
  const m = s.match(/(20\d\d)\s*[-_ ]?\s*q([1-4])/i) ?? s.match(/(20\d\d)q([1-4])/i);
  return m ? `${m[1]}Q${m[2]}` : null;
}

async function releases(): Promise<Release[]> {
  return cached("pf-releases", H24, async () => {
    const html = await textFetch(PAGE, 20000);
    const links = pageLinks(html, /\.(pdf|xlsx)$/i);
    const byQ = new Map<string, Release>();
    for (const l of links) {
      const q = quarterKey(l.href) ?? quarterKey(l.text);
      if (!q) continue;
      const r = byQ.get(q) ?? { label: q.replace("Q", " Q"), quarter: q, pdfUrl: null, xlsxUrl: null };
      if (/\.xlsx$/i.test(l.href)) r.xlsxUrl = r.xlsxUrl ?? l.href;
      else if (!/accessible|508/i.test(l.href)) r.pdfUrl = r.pdfUrl ?? l.href;
      else r.pdfUrl = r.pdfUrl ?? l.href;
      byQ.set(q, r);
    }
    return [...byQ.values()].sort((a, b) => (b.quarter ?? "").localeCompare(a.quarter ?? ""));
  });
}

interface Series {
  table: string;
  title: string;
  quarters: string[];
  rows: Array<{ label: string; values: Array<number | null> }>;
}

function toNum(s: string | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function readTable(wb: Workbook, table: string, titles: Map<string, string>): Series | null {
  const grid = wb.sheet(table);
  if (!grid) return null;
  const hIdx = grid.findIndex((r) => r.some((c) => /^20\d\dQ[1-4]$/.test(c)));
  if (hIdx < 0) return null;
  const header = grid[hIdx];
  const qCols: number[] = [];
  const quarters: string[] = [];
  header.forEach((c, i) => {
    if (/^20\d\dQ[1-4]$/.test(c)) { qCols.push(i); quarters.push(c); }
  });
  const rows: Series["rows"] = [];
  for (const r of grid.slice(hIdx + 1)) {
    const label = (r[0] ?? "").trim();
    if (!label || /return to notes/i.test(label)) continue;
    const values = qCols.map((i) => toNum(r[i]));
    if (values.every((v) => v == null)) continue;
    rows.push({ label, values });
  }
  return { table, title: titles.get(table) ?? table, quarters, rows };
}

function headline(s: Series | null, unit: string) {
  if (!s || !s.quarters.length) return null;
  const n = s.quarters.length;
  const li = n - 1;
  const pi = n - 2;
  const yi = n - 5;
  const pct = (a: number | null, b: number | null) => (a != null && b != null && b !== 0 ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);
  return {
    table: s.table,
    title: s.title,
    unit,
    latestQuarter: s.quarters[li],
    rows: s.rows.map((r) => ({
      category: r.label,
      latest: r.values[li],
      yearAgo: yi >= 0 ? r.values[yi] : null,
      qoqPct: pi >= 0 ? pct(r.values[li], r.values[pi]) : null,
      yoyPct: yi >= 0 ? pct(r.values[li], r.values[yi]) : null,
    })),
  };
}

export interface FormPfArgs {
  quarter?: string; // "2025Q3"
  table?: string; // "Tab.8.10"
  history?: number; // quarters of history for `table`
}

export async function formpfStatistics(args: FormPfArgs) {
  const a = args ?? {};
  const rel = await releases();
  const reportList = rel.slice(0, 8).map((r) => ({ quarter: r.quarter, pdfUrl: r.pdfUrl, xlsxUrl: r.xlsxUrl }));
  const wantQ = a.quarter ? quarterKey(a.quarter.replace(/\s+/g, "")) : null;
  const target = (wantQ ? rel.find((r) => r.quarter === wantQ) : rel.find((r) => r.xlsxUrl)) ?? null;
  if (!target) {
    return { dataSource: DS, error: wantQ ? `No release found for ${wantQ}.` : "Could not find any release on the SEC page.", pageUrl: PAGE, reports: reportList };
  }
  if (!target.xlsxUrl) {
    return {
      dataSource: DS,
      quarter: target.quarter,
      machineReadable: false,
      pdfUrl: target.pdfUrl,
      reports: reportList,
      note: "This quarter was published as PDF only (supporting-data xlsx began ~2023Q4). Omit quarter to use the latest xlsx, which carries the full 2013Q1-onward history in every table.",
    };
  }

  const wb = await cached(`pf-xlsx:${target.xlsxUrl}`, H24, async () => readXlsx(await bufferFetch(target.xlsxUrl!, 45000)));
  const notes = wb.sheet("Notes") ?? [];
  const titles = new Map<string, string>();
  for (const r of notes) if (/^Tab\.\d/.test(r[0] ?? "")) titles.set(r[0], (r[1] ?? "").split("\n")[0].trim());

  if (a.table) {
    const t = a.table.trim().replace(/^tab/i, "Tab").replace(/^Tab(?=\d)/, "Tab.");
    const s = readTable(wb, t, titles);
    if (!s) {
      return { dataSource: DS, quarter: target.quarter, error: `Table ${a.table} not found or not a quarterly series.`, availableTables: [...titles.entries()].slice(0, 200).map(([k, v]) => `${k}: ${v}`) };
    }
    const h = Math.min(Math.max(Number(a.history) || 8, 1), 60);
    const from = Math.max(0, s.quarters.length - h);
    return {
      dataSource: DS,
      release: target.quarter,
      xlsxUrl: target.xlsxUrl,
      table: s.table,
      title: s.title,
      quarters: s.quarters.slice(from),
      rows: s.rows.map((r) => ({ category: r.label, values: r.values.slice(from) })),
      note: "Values as published (units in the title: $ billions, counts, or percent). history = number of trailing quarters (max 60).",
    };
  }

  const funds = headline(readTable(wb, "Tab.1.1", titles), "count");
  const advisers = headline(readTable(wb, "Tab.1.3", titles), "count");
  const gav = headline(readTable(wb, "Tab.2.1", titles), "$ billions");
  const nav = headline(readTable(wb, "Tab.2.3", titles), "$ billions");
  const borrow = headline(readTable(wb, "Tab.2.9", titles), "percent of GAV");
  const parsedNothing = !funds && !gav && !nav;
  return {
    dataSource: DS,
    machineReadable: true,
    release: target.quarter,
    dataThrough: funds?.latestQuarter ?? gav?.latestQuarter ?? null,
    xlsxUrl: target.xlsxUrl,
    pdfUrl: target.pdfUrl,
    numberOfFunds: funds,
    grossAssetValue: gav,
    netAssetValue: nav,
    advisersByFundType: advisers ? advisers.rows.map((r) => ({ category: r.category, latest: r.latest, yoyPct: r.yoyPct })) : null,
    borrowingsPctOfGav: borrow ? borrow.rows.map((r) => ({ category: r.category, latest: r.latest, yearAgo: r.yearAgo })) : null,
    reports: reportList.slice(0, 4),
    ...(parsedNothing ? { sampleRaw: (wb.sheet("Tab.1.1") ?? []).slice(0, 3), sheets: wb.sheetNames.slice(0, 20) } : {}),
    note:
      "Aggregated from confidential Form PF filings by SEC-registered advisers with ≥$150M private fund AUM; published ~2 quarters after period end. GAV/NAV in $ billions; qoqPct/yoyPct are % changes. Category totals can include fund-type overlap (e.g. 'Qualifying Hedge Fund' is a subset of 'Hedge Fund'). For any other tab (strategy NAV, leverage, liquidity, beneficial ownership, PE portfolio-company stats) pass table, e.g. 'Tab.8.10' (QHF NAV by strategy), 'Tab.4.2' (beneficial ownership %), 'Tab.3.2' (adviser location).",
  };
}
