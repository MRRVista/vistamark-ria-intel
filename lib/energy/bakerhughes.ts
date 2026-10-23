/**
 * Baker Hughes North America rotary rig count — weekly US / Canada rigs by
 * Oil / Gas / Misc, from the public workbook on rigcount.bakerhughes.com.
 * KEYLESS, but see the sandbox caveat below.
 *
 * Site layout (read 2026-10-22 through a web-reader; the sandbox's own egress
 * is blocked by Akamai with HTTP 403 "Access Denied" on every path, including
 * the static-files downloads and the gcs-web mirror):
 *   https://rigcount.bakerhughes.com/na-rig-count  lists the downloads:
 *     "North America Rig Count Report - New Report" (.xlsx, ~7.3 MB, re-posted
 *       every Friday ~noon CT; 10/16/26 vintage was
 *       /static-files/358a48a1-54c1-4d36-80c6-e61563abadf9)
 *     "North America Rig Count New Report (2013-Aug 2025)" (.xlsx, 11.7 MB, archive)
 *     "North America Rotary Rig Count (Jan 2000 - Mar 2024)" (.xlsb — the file the
 *       brief called "Jan 2000 - Current"; it was frozen in Mar 2024 and is .xlsb,
 *       which the in-repo reader cannot decode)
 *   Per the Baker Hughes FAQ the new report carries NAM Summary / NAM Breakdown /
 *   NAM Yearly / Quarterly / Monthly / Weekly views with fields Country, County,
 *   Basin, GOM, Drill For, Location, State/Province, Trajectory,
 *   Year/Quarter/Month/US_PublishDate and Rig Count Value.
 *
 * Because the workbook could not be opened from here, this module sniffs the
 * layout at runtime instead of hard-coding cell positions:
 *   - LONG layout: a header row with a date column (PublishDate / US_PublishDate /
 *     Week / Date), a Country column, a "Drill For"/"DrillFor" column and a
 *     count column (Rig Count / RigCount / Count / Value) → aggregated per week.
 *   - WIDE layout: a header row with a date column and numeric columns whose
 *     headers mention Oil / Gas / Misc / Total (optionally prefixed U.S./Canada,
 *     or under a group header row) → read directly.
 * The result carries `layoutDetected` and `unverified: true` until a live run
 * confirms the parse; README.md records what was and was not verified.
 *
 * Override the workbook URL with BAKER_HUGHES_RIG_XLSX_URL if Baker Hughes
 * rotates the static-files id and page discovery fails.
 */
import { politeFetch, redactUrl } from "../data/http";
import { cached, clampInt, excelSerialToIso, HOUR, normDate, round } from "../research/common";
import { readXlsxGrid, xlsxSheetNames, type Cell } from "../research/xlsx";

const PAGE = "https://rigcount.bakerhughes.com/na-rig-count";
const FALLBACK_XLSX = "https://rigcount.bakerhughes.com/static-files/358a48a1-54c1-4d36-80c6-e61563abadf9";

export interface RigWeek {
  date: string;
  us: { oil: number | null; gas: number | null; misc: number | null; total: number | null };
  canada: { oil: number | null; gas: number | null; misc: number | null; total: number | null };
}

function blockedError(status: number, url: string): Error {
  return new Error(
    `Baker Hughes returned HTTP ${status} for ${redactUrl(url)} — the site (Akamai) blocks non-browser clients from some networks. Set BAKER_HUGHES_RIG_XLSX_URL to a reachable copy of the "North America Rig Count Report" workbook, or use eia_series route 'petroleum/crd/drill' (EIA's monthly US rotary rig counts, derived from Baker Hughes; needs EIA_API_KEY).`
  );
}

async function get(url: string, accept: string, timeoutMs: number): Promise<Response> {
  const res = await politeFetch(url, { timeoutMs, retries: 1, headers: { Accept: accept } });
  if (res.status === 403 || res.status === 401) throw blockedError(res.status, url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  return res;
}

/** Find the current "North America Rig Count Report" xlsx link on the NA rig-count page. */
async function discoverWorkbookUrl(): Promise<{ url: string; via: string }> {
  const override = process.env.BAKER_HUGHES_RIG_XLSX_URL?.trim();
  if (override) return { url: override, via: "env BAKER_HUGHES_RIG_XLSX_URL" };
  try {
    const html = await (await get(PAGE, "text/html", 15000)).text();
    // anchors with href to static-files; pick the one whose nearby text says "Rig Count Report" (new report), else the first xlsx-ish link.
    const anchors = Array.from(html.matchAll(/<a\b[^>]*href="([^"]*static-files\/[0-9a-f-]{20,})"[^>]*>([\s\S]*?)<\/a>/gi)).map((m) => ({
      href: m[1]!,
      text: m[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    }));
    const pick =
      anchors.find((a) => /north america rig count report/i.test(a.text) && !/\d{4}\s*-\s*(aug|mar|\w+ )?\d{4}/i.test(a.text)) ??
      anchors.find((a) => /rig count report/i.test(a.text)) ??
      anchors.find((a) => /north america rig count/i.test(a.text));
    if (pick) {
      const url = pick.href.startsWith("http") ? pick.href : `https://rigcount.bakerhughes.com${pick.href.startsWith("/") ? "" : "/"}${pick.href}`;
      return { url, via: `page link "${pick.text}"` };
    }
  } catch (e) {
    if (/HTTP 40[13]/.test(String((e as Error).message))) throw e;
  }
  return { url: FALLBACK_XLSX, via: "built-in fallback id (10/16/2026 vintage)" };
}

// ---------------------------------------------------------------------------
// Layout sniffing
// ---------------------------------------------------------------------------

const norm = (c: Cell) => (c == null ? "" : String(c).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());

function toDate(c: Cell): string | null {
  if (typeof c === "number") return c > 30000 && c < 80000 ? excelSerialToIso(c) : null;
  const s = normDate(c);
  if (s) return s;
  if (typeof c === "string") {
    const t = Date.parse(c);
    if (Number.isFinite(t) && t > Date.UTC(1985, 0, 1)) return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

interface LongCols {
  date: number;
  country: number;
  drillFor: number;
  count: number;
  header: number;
}

function findLongHeader(grid: Cell[][], scan = 60): LongCols | null {
  for (let r = 0; r < Math.min(scan, grid.length); r++) {
    const row = grid[r] ?? [];
    const h = row.map(norm);
    const date = h.findIndex((x) => /^(us )?publish ?date$|^publishdate$|^date$|^week$|^week ending$|^us publishdate$/.test(x) || /publish ?date/.test(x));
    const country = h.findIndex((x) => x === "country");
    const drillFor = h.findIndex((x) => /^drill ?for( type)?$/.test(x));
    const count = h.findIndex((x) => /^(rig ?count( value)?|rigcount|count|value|rigs)$/.test(x));
    if (date >= 0 && country >= 0 && drillFor >= 0 && count >= 0) return { date, country, drillFor, count, header: r };
  }
  return null;
}

interface WideCols {
  header: number;
  date: number;
  map: Partial<Record<"us.oil" | "us.gas" | "us.misc" | "us.total" | "ca.oil" | "ca.gas" | "ca.misc" | "ca.total", number>>;
}

function findWideHeader(grid: Cell[][], scan = 60): WideCols | null {
  for (let r = 0; r < Math.min(scan, grid.length); r++) {
    const row = grid[r] ?? [];
    const h = row.map(norm);
    const date = h.findIndex((x) => /^(date|week|week ending|publish ?date|us publishdate|publishdate|us publish date)$/.test(x));
    if (date < 0) continue;
    const above = (grid[r - 1] ?? []).map(norm);
    const above2 = (grid[r - 2] ?? []).map(norm);
    const map: WideCols["map"] = {};
    let lastGroup = "";
    for (let c = 0; c < h.length; c++) {
      const g = above[c] || above2[c];
      if (g && /(u s|us|united states|canada)/.test(g)) lastGroup = g;
      const label = h[c]!;
      if (!label || c === date) continue;
      const ctx = `${label} ${/(u s|us|united states|canada)/.test(label) ? "" : lastGroup}`;
      const region = /canada/.test(ctx) ? "ca" : /(u s|us|united states)/.test(ctx) ? "us" : null;
      if (!region) continue;
      const kind = /oil/.test(label) ? "oil" : /gas/.test(label) ? "gas" : /misc/.test(label) ? "misc" : /total/.test(label) ? "total" : null;
      if (!kind) continue;
      const key = `${region}.${kind}` as keyof WideCols["map"];
      if (map[key] == null) map[key] = c;
    }
    const hasUs = map["us.total"] != null || (map["us.oil"] != null && map["us.gas"] != null);
    if (hasUs) return { header: r, date, map };
  }
  return null;
}

function emptyBlock() {
  return { oil: null as number | null, gas: null as number | null, misc: null as number | null, total: null as number | null };
}

function parseLong(grid: Cell[][], cols: LongCols): RigWeek[] {
  const acc = new Map<string, RigWeek>();
  for (let r = cols.header + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const d = toDate(row[cols.date] ?? null);
    if (!d) continue;
    const country = norm(row[cols.country] ?? null);
    const region = /canada/.test(country) ? "canada" : /(^u s$|^us$|united states|^usa$)/.test(country) ? "us" : null;
    if (!region) continue;
    const df = norm(row[cols.drillFor] ?? null);
    const kind = /oil/.test(df) ? "oil" : /gas/.test(df) ? "gas" : "misc";
    const n = Number(row[cols.count]);
    if (!Number.isFinite(n)) continue;
    const wk = acc.get(d) ?? { date: d, us: emptyBlock(), canada: emptyBlock() };
    const blk = wk[region];
    blk[kind] = (blk[kind] ?? 0) + n;
    blk.total = (blk.total ?? 0) + n;
    acc.set(d, wk);
  }
  return Array.from(acc.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

function parseWide(grid: Cell[][], cols: WideCols): RigWeek[] {
  const out: RigWeek[] = [];
  const pick = (row: Cell[], k: keyof WideCols["map"]) => {
    const c = cols.map[k];
    if (c == null) return null;
    const n = Number(row[c]);
    return Number.isFinite(n) ? n : null;
  };
  for (let r = cols.header + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    const d = toDate(row[cols.date] ?? null);
    if (!d) continue;
    const us = { oil: pick(row, "us.oil"), gas: pick(row, "us.gas"), misc: pick(row, "us.misc"), total: pick(row, "us.total") };
    const canada = { oil: pick(row, "ca.oil"), gas: pick(row, "ca.gas"), misc: pick(row, "ca.misc"), total: pick(row, "ca.total") };
    if (us.total == null && us.oil != null && us.gas != null) us.total = us.oil + us.gas + (us.misc ?? 0);
    if (canada.total == null && canada.oil != null && canada.gas != null) canada.total = canada.oil + canada.gas + (canada.misc ?? 0);
    if (us.total == null && canada.total == null) continue;
    out.push({ date: d, us, canada });
  }
  // de-duplicate dates (keep last)
  const m = new Map(out.map((w) => [w.date, w]));
  return Array.from(m.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

interface Loaded {
  weeks: RigWeek[];
  workbookUrl: string;
  discoveredVia: string;
  sheet: string;
  layoutDetected: string;
  sheets: string[];
}

function loadWorkbook(): Promise<Loaded> {
  return cached("bakerhughes:na", 6 * HOUR, async () => {
    const { url, via } = await discoverWorkbookUrl();
    const res = await get(url, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*", 45000);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error(`Baker Hughes workbook at ${redactUrl(url)} is not an .xlsx (got ${res.headers.get("content-type") ?? "unknown type"}, ${buf.length} bytes). Set BAKER_HUGHES_RIG_XLSX_URL to the current "North America Rig Count Report" xlsx.`);
    }
    const sheets = xlsxSheetNames(buf);
    // Prefer a weekly sheet, then summary/breakdown, then everything else.
    const order = [
      ...sheets.filter((s) => /week/i.test(s)),
      ...sheets.filter((s) => /summary|breakdown|data|rig/i.test(s) && !/week/i.test(s)),
      ...sheets.filter((s) => !/week|summary|breakdown|data|rig/i.test(s)),
    ];
    const tried: string[] = [];
    for (const name of order) {
      const head = readXlsxGrid(buf, name, 60).grid;
      const long = findLongHeader(head);
      const wide = long ? null : findWideHeader(head);
      if (!long && !wide) {
        tried.push(name);
        continue;
      }
      const { grid } = readXlsxGrid(buf, name);
      const weeks = long ? parseLong(grid, long) : parseWide(grid, wide!);
      if (weeks.length >= 10) {
        return { weeks, workbookUrl: url, discoveredVia: via, sheet: name, layoutDetected: long ? `long (date col ${long.date}, Country ${long.country}, DrillFor ${long.drillFor}, count ${long.count}, header row ${long.header + 1})` : `wide (header row ${wide!.header + 1}, cols ${JSON.stringify(wide!.map)})`, sheets };
      }
      tried.push(`${name} (${weeks.length} rows)`);
    }
    throw new Error(`Baker Hughes workbook parsed but no weekly US rig table was recognised. Sheets: ${sheets.join(", ")}; tried: ${tried.join(", ")}. The layout may have changed — see lib/energy/bakerhughes.ts sniffers.`);
  });
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface RigCountArgs {
  weeks?: number;
  region?: "us" | "canada" | "both";
}

function chg(cur: number | null, prior: number | null) {
  return cur != null && prior != null ? cur - prior : null;
}

function nearest(weeks: RigWeek[], targetIso: string): RigWeek | null {
  // latest week on or before target
  for (let i = weeks.length - 1; i >= 0; i--) if (weeks[i]!.date <= targetIso) return weeks[i]!;
  return null;
}

function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86400000).toISOString().slice(0, 10);
}

export async function bakerHughesRigCount(args: RigCountArgs) {
  const n = clampInt(args.weeks, 12, 1, 104);
  const region = args.region === "us" || args.region === "canada" ? args.region : "both";
  const { weeks, workbookUrl, discoveredVia, sheet, layoutDetected, sheets } = await loadWorkbook();
  const latest = weeks[weeks.length - 1]!;
  const w1 = weeks.length > 1 ? weeks[weeks.length - 2]! : null;
  const w4 = nearest(weeks, shiftDays(latest.date, 28)) ?? null;
  const w52 = nearest(weeks, shiftDays(latest.date, 364)) ?? null;
  const yrs = weeks.filter((w) => w.date > shiftDays(latest.date, 365));

  const summarize = (key: "us" | "canada") => {
    const cur = latest[key];
    const blk = (w: RigWeek | null) => (w ? w[key] : null);
    const totals = yrs.map((w) => w[key].total).filter((v): v is number => v != null);
    return {
      asOf: latest.date,
      oil: cur.oil,
      gas: cur.gas,
      misc: cur.misc,
      total: cur.total,
      change1w: { oil: chg(cur.oil, blk(w1)?.oil ?? null), gas: chg(cur.gas, blk(w1)?.gas ?? null), total: chg(cur.total, blk(w1)?.total ?? null), vs: w1?.date ?? null },
      change4w: { oil: chg(cur.oil, blk(w4)?.oil ?? null), gas: chg(cur.gas, blk(w4)?.gas ?? null), total: chg(cur.total, blk(w4)?.total ?? null), vs: w4?.date ?? null },
      change52w: { oil: chg(cur.oil, blk(w52)?.oil ?? null), gas: chg(cur.gas, blk(w52)?.gas ?? null), total: chg(cur.total, blk(w52)?.total ?? null), vs: w52?.date ?? null },
      oneYearRangeTotal: totals.length ? { min: Math.min(...totals), max: Math.max(...totals), avg: round(totals.reduce((a, b) => a + b, 0) / totals.length, 1) } : null,
      oilShareOfTotal: cur.oil != null && cur.total ? round((cur.oil / cur.total) * 100, 1) : null,
    };
  };

  const recent = weeks
    .slice(-n)
    .reverse()
    .map((w) => ({
      date: w.date,
      ...(region !== "canada" ? { usOil: w.us.oil, usGas: w.us.gas, usMisc: w.us.misc, usTotal: w.us.total } : {}),
      ...(region !== "us" ? { caOil: w.canada.oil, caGas: w.canada.gas, caTotal: w.canada.total } : {}),
    }));

  return {
    source: "Baker Hughes North America Rotary Rig Count — weekly workbook from rigcount.bakerhughes.com (published Fridays ~noon CT)",
    fetchedAt: new Date().toISOString(),
    asOf: latest.date,
    history: { from: weeks[0]!.date, to: latest.date, weeks: weeks.length },
    ...(region !== "canada" ? { us: summarize("us") } : {}),
    ...(region !== "us" ? { canada: summarize("canada") } : {}),
    recent,
    provenance: { workbookUrl: redactUrl(workbookUrl), discoveredVia, sheet, layoutDetected, sheetsInWorkbook: sheets.slice(0, 12) },
    unverified: true,
    note:
      "Counts are active rotary rigs (Baker Hughes definition; operator-declared oil vs gas). 'misc' = rigs drilling for neither (e.g. geothermal) when the layout exposes it. Changes are vs the prior week, the week ≥28 days earlier and the week ≥364 days earlier. `unverified` flags that the workbook parser was built from Baker Hughes' documented layout without a live run from the build sandbox (Akamai 403) — check `provenance.layoutDetected` the first time this returns, and compare `us.total` to the headline number on rigcount.bakerhughes.com. For EIA's monthly rig series use eia_series route 'petroleum/crd/drill' (keyed).",
  };
}
