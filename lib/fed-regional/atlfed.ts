/**
 * Atlanta Fed: GDPNow and the Wage Growth Tracker (public xlsx, no key).
 *
 * Verified live 2026-10-21 (atlantafed.org moved CQER pages under /research-and-data/data/):
 *   GDPNow   /-/media/Project/Atlanta/FRBA/Documents/research-and-data/data/gdpnow/GDPTrackingModelDataAndForecasts.xlsx (~11MB)
 *            Sheets used: TrackingHistory (component growth, last ~month of updates, dates across row 1),
 *            ContribHistory (contributions to growth, same layout), CurrentQtrEvolution (every nowcast
 *            this quarter, in 3 side-by-side Date/Major Releases/GDP* column blocks), Table (latest BEA
 *            estimates of previous quarters + nowcast by release).
 *   WGT      /-/media/Project/Atlanta/FRBA/Documents/datafiles/chcs/wage-growth-tracker/wage-growth-data.xlsx (~340KB)
 *            Sheet data_overall: row 2 headers (Overall, Job Stayer, Job Switcher, ...), 3mma of median wage growth.
 */
import { HOUR, cached, clampInt, fetchBuffer, num, round } from "./common";
import { openXlsx, type Cell, type Grid, type XlsxBook } from "./xlsx";

const ATL = "https://www.atlantafed.org/-/media/Project/Atlanta/FRBA/Documents";
const GDPNOW_URL = `${ATL}/research-and-data/data/gdpnow/GDPTrackingModelDataAndForecasts.xlsx`;
const WGT_URL = `${ATL}/datafiles/chcs/wage-growth-tracker/wage-growth-data.xlsx`;

const isDate = (c: Cell): c is string => typeof c === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c);

async function gdpnowBook(): Promise<XlsxBook> {
  return cached("atl:gdpnow", 6 * HOUR, async () => openXlsx(await fetchBuffer(GDPNOW_URL, 60000)));
}

/** Parse a TrackingHistory/ContribHistory-style sheet: dates across row 1, labels in col B. */
function parseHistorySheet(g: Grid) {
  const dateRow = g[0] ?? [];
  const cols: { col: number; date: string }[] = [];
  dateRow.forEach((c, i) => { if (i >= 2 && isDate(c)) cols.push({ col: i, date: c }); });
  const title = String((g[1] ?? [])[0] ?? "");
  const quarter = title.match(/(\d{4}q\d)/i)?.[1] ?? null;
  const lines: { label: string; short: string | null; values: (number | null)[] }[] = [];
  for (let r = 2; r < g.length; r++) {
    const row = g[r] ?? [];
    const label = typeof row[1] === "string" ? row[1].replace(/\*+$/, "").replace(/^\s*\d+-\s*/, "").replace(/\s+/g, " ").trim() : "";
    if (!label || /^note:/i.test(label)) continue;
    if (/number of dates|last date/i.test(String(row[0] ?? ""))) break;
    const values = cols.map((c) => (typeof row[c.col] === "number" ? (row[c.col] as number) : null));
    if (values.every((v) => v == null)) continue;
    lines.push({ label, short: typeof row[0] === "string" ? row[0].replace(/\s+/g, " ").trim() : null, values });
  }
  return { quarter, cols, lines };
}

const KEY_LINES = [
  "GDP Nowcast", "Final Sales", "Final Sales to Private Domestic Purchasers", "Personal consumption expenditures (PCE)", "PCE Goods", "PCE Services",
  "Gross Private Domestic Investment (GPDI)", "Equipment", "Intellectual Property Products", "Structures", "Residential",
  "Government expenditures", "Federal", "State and Local", "Exports", "Imports",
];

export async function atlfedGdpnow(args: { recent?: number; includeComponents?: boolean }) {
  const recent = clampInt(args.recent, 10, 1, 120);
  const includeComponents = args.includeComponents !== false;
  const book = await gdpnowBook();

  // Full current-quarter evolution: 3 side-by-side (Date, Major Releases, GDP*) blocks.
  const evoGrid = book.sheet("CurrentQtrEvolution");
  const evo: { date: string; releases: string; gdp: number }[] = [];
  const hdr = evoGrid[0] ?? [];
  const blocks: number[] = [];
  hdr.forEach((h, i) => { if (typeof h === "string" && h.trim().toLowerCase() === "date") blocks.push(i); });
  for (let r = 1; r < evoGrid.length; r++) {
    const row = evoGrid[r] ?? [];
    for (const b of blocks) {
      const d = row[b], g = row[b + 2];
      if (isDate(d) && typeof g === "number") evo.push({ date: d, releases: String(row[b + 1] ?? "").trim(), gdp: g });
    }
  }
  evo.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const track = parseHistorySheet(book.sheet("TrackingHistory"));
  const contrib = includeComponents ? parseHistorySheet(book.sheet("ContribHistory")) : null;
  const gdpLine = track.lines.find((l) => /^gdp nowcast/i.test(l.label));
  const lastCol = track.cols.length - 1;

  const latest = evo[evo.length - 1] ?? (gdpLine && lastCol >= 0 ? { date: track.cols[lastCol].date, releases: "", gdp: gdpLine.values[lastCol]! } : null);
  if (!latest) {
    return { dataSource: "Atlanta Fed GDPNow", note: "Could not locate the nowcast in the workbook (layout drift).", sheets: book.sheetNames.slice(0, 60) };
  }
  const first = evo[0];
  const prev = evo.length > 1 ? evo[evo.length - 2] : null;

  // Previous quarters' BEA estimates from 'Table'.
  const tbl = book.sheet("Table");
  const bea: { label: string; gdp: number | null }[] = [];
  for (const row of tbl.slice(1, 6)) {
    if (typeof row?.[1] === "string" && /latest bea estimate/i.test(row[1])) bea.push({ label: row[1].replace(/^Latest BEA estimate for\s*/i, ""), gdp: round(num(row[2]), 2) });
  }

  let components: any[] | undefined;
  if (includeComponents && lastCol >= 0) {
    const cLast = contrib ? contrib.cols.length - 1 : -1;
    components = KEY_LINES.map((name) => {
      const t = track.lines.find((l) => l.label.toLowerCase() === name.toLowerCase());
      const c = contrib?.lines.find((l) => l.label.toLowerCase() === name.toLowerCase());
      if (!t && !c) return null;
      return {
        component: name,
        growthSaar: t ? round(t.values[lastCol], 2) : null,
        contributionPp: c && cLast >= 0 ? round(c.values[cLast], 2) : null,
      };
    }).filter(Boolean);
    const nx = contrib?.lines.find((l) => /change in net exports/i.test(l.label));
    const inv = contrib?.lines.find((l) => /change in inventory investment/i.test(l.label));
    if (nx && cLast >= 0) components.push({ component: "Net exports (contribution)", growthSaar: null, contributionPp: round(nx.values[cLast], 2) });
    if (inv && cLast >= 0) components.push({ component: "Change in private inventories (contribution)", growthSaar: null, contributionPp: round(inv.values[cLast], 2) });
  }

  return {
    dataSource: "Federal Reserve Bank of Atlanta — GDPNow (GDPTrackingModelDataAndForecasts.xlsx)",
    quarter: track.quarter,
    latest: { date: latest.date, nowcastPct: round(latest.gdp, 2), triggeredBy: latest.releases || undefined },
    previous: prev ? { date: prev.date, nowcastPct: round(prev.gdp, 2), changePp: round(latest.gdp - prev.gdp, 2) } : null,
    initialForQuarter: first ? { date: first.date, nowcastPct: round(first.gdp, 2) } : null,
    rangeThisQuarter: evo.length ? { min: round(Math.min(...evo.map((e) => e.gdp)), 2), max: round(Math.max(...evo.map((e) => e.gdp)), 2), updates: evo.length } : null,
    latestBeaEstimates: bea.length ? bea : undefined,
    components,
    evolution: evo.slice(-recent).reverse().map((e) => ({ date: e.date, nowcastPct: round(e.gdp, 2), releases: e.releases })),
    note: "Real GDP growth, seasonally adjusted annualized rate (%), for the quarter being nowcast. Model-based running estimate updated after major data releases (typically 6–8 times a month) — NOT an official forecast; it has no judgmental adjustment. components: growthSaar = subcomponent real growth SAAR %, contributionPp = percentage-point contribution to headline GDP. evolution is newest-first. Workbook cached 6h. Complements FRED (which does not carry GDPNow's real-time track).",
  };
}

// ---------------------------------------------------------------------------
// Wage Growth Tracker
// ---------------------------------------------------------------------------

async function wgtBook(): Promise<XlsxBook> {
  return cached("atl:wgt", 24 * HOUR, async () => openXlsx(await fetchBuffer(WGT_URL, 45000)));
}

export async function atlfedWageTracker(args: { series?: string[]; recent?: number }) {
  const recent = clampInt(args.recent, 12, 1, 360);
  const book = await wgtBook();
  const g = book.sheet("data_overall");
  const hRowIdx = g.findIndex((r) => (r ?? []).some((c) => c === "Overall"));
  if (hRowIdx < 0) return { dataSource: "Atlanta Fed Wage Growth Tracker", note: "Header row not found (layout drift).", sampleRaw: g.slice(0, 3) };
  const headers = (g[hRowIdx] ?? []).map((c) => (typeof c === "string" ? c.trim() : null));
  const rows = g.slice(hRowIdx + 1).filter((r) => isDate(r?.[0] ?? null));
  const available = headers.filter((h): h is string => !!h);
  const defaultSeries = ["Overall", "Job Stayer", "Job Switcher", "Overall: Weighted", "Paid Hourly", "Lower 1/2 of wage distn", "Upper 1/2 of wage distn"];
  const wanted = (args.series?.length ? args.series : defaultSeries)
    .map((s) => available.find((h) => h.toLowerCase() === String(s).toLowerCase()))
    .filter((h): h is string => !!h);
  const colOf = (h: string) => headers.indexOf(h);
  const last = rows[rows.length - 1];
  const at = (r: Cell[] | undefined, h: string) => (r ? num(r[colOf(h)]) : null);
  const ago12 = rows[rows.length - 13];

  return {
    dataSource: "Federal Reserve Bank of Atlanta — Wage Growth Tracker (CPS microdata)",
    asOf: last ? String(last[0]).slice(0, 7) : null,
    latest: Object.fromEntries(wanted.map((h) => [h, at(last, h)])),
    yearAgo: ago12 ? Object.fromEntries(wanted.map((h) => [h, at(ago12, h)])) : undefined,
    switcherPremiumPp: last && colOf("Job Switcher") >= 0 && colOf("Job Stayer") >= 0 ? round((at(last, "Job Switcher") ?? NaN) - (at(last, "Job Stayer") ?? NaN), 1) : undefined,
    series: rows.slice(-recent).reverse().map((r) => ({ month: String(r[0]).slice(0, 7), ...Object.fromEntries(wanted.map((h) => [h, at(r, h)])) })),
    availableSeries: available,
    note: "Median 12-month growth in individuals' hourly wages (%, 3-month moving average), from matched Current Population Survey records — composition-robust, unlike average hourly earnings. Job Switcher minus Job Stayer gap is a labor-market tightness gauge (wide = workers rewarded for moving). Monthly, ~2-week lag after the CPS. series newest-first; pick any of availableSeries via `series`. Cached 24h.",
  };
}
