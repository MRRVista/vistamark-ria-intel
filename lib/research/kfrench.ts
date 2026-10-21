/**
 * Kenneth R. French Data Library (Tuck/Dartmouth), keyless.
 *
 * Endpoint (verified live 2026-10-21):
 *   https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/<Name>_CSV.zip
 *   Each zip holds one CSV. The CSV is a sequence of SECTIONS: free-text
 *   preamble, then a header line beginning with "," (",Mkt-RF,SMB,HML,RF"),
 *   then rows "<date>,<v1>,<v2>…" until a blank line. Section titles are the
 *   text lines just above the header ("Average Value Weighted Returns -- Monthly",
 *   " Annual Factors: January-December "). Dates are YYYYMM (monthly),
 *   YYYYMMDD (daily/weekly) or YYYY (annual). Values are PERCENT returns.
 *   Missing data = -99.99 or -999. US files are CRSP-based and update
 *   monthly with a ~1-month lag; international files are Bloomberg-based.
 *   The dataset catalog is scraped from data_library.html (≈300 CSV zips).
 */
import AdmZip from "adm-zip";
import { cached, fetchBuffer, fetchText, HOUR, clampInt, returnStats, round, windowFilter } from "./common";

const BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french";
const FTP = `${BASE}/ftp`;
const LIBRARY = `${BASE}/data_library.html`;

export interface KfRow {
  /** sortable ISO-ish key used for window filtering */
  date: string;
  /** upstream period label normalized: YYYY-MM, YYYY-MM-DD or YYYY */
  period: string;
  values: (number | null)[];
}

export interface KfSection {
  name: string;
  frequency: "daily" | "weekly" | "monthly" | "annual" | "unknown";
  columns: string[];
  rows: KfRow[];
}

export interface KfFile {
  dataset: string;
  url: string;
  preamble: string;
  sections: KfSection[];
}

function periodOf(raw: string): { date: string; period: string; freq: KfSection["frequency"] } | null {
  const s = raw.trim();
  if (/^\d{8}$/.test(s)) {
    const p = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
    return { date: p, period: p, freq: "daily" };
  }
  if (/^\d{6}$/.test(s)) {
    const p = `${s.slice(0, 4)}-${s.slice(4)}`;
    return { date: `${p}-28`, period: p, freq: "monthly" };
  }
  if (/^\d{4}$/.test(s)) return { date: `${s}-12-31`, period: s, freq: "annual" };
  return null;
}

export function parseKfCsv(text: string, dataset: string, url: string): KfFile {
  const lines = text.replace(/\r/g, "").split("\n");
  const sections: KfSection[] = [];
  let preamble = "";
  let i = 0;
  let lastEnd = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*,/.test(line) && i + 1 < lines.length && periodOf((lines[i + 1] ?? "").split(",")[0] ?? "")) {
      // Title: contiguous non-blank text lines directly above the header (max 3).
      const titleLines: string[] = [];
      for (let k = i - 1; k >= lastEnd && titleLines.length < 3; k--) {
        const t = lines[k]!.trim();
        if (!t) break;
        titleLines.unshift(t);
      }
      if (!sections.length) preamble = lines.slice(0, i).map((l) => l.trim()).filter(Boolean).join(" ").slice(0, 600);
      const columns = line.split(",").slice(1).map((c) => c.trim());
      const rows: KfRow[] = [];
      let freq: KfSection["frequency"] = "unknown";
      let j = i + 1;
      for (; j < lines.length; j++) {
        const parts = lines[j]!.split(",");
        const per = periodOf(parts[0] ?? "");
        if (!per) break;
        freq = per.freq;
        const values = parts.slice(1, columns.length + 1).map((v) => {
          const n = Number(v.trim());
          return !Number.isFinite(n) || v.trim() === "" || n === -99.99 || n === -999 ? null : n;
        });
        rows.push({ date: per.date, period: per.period, values });
      }
      let name = titleLines.join(" ").replace(/\s+/g, " ").trim();
      if (!name || (sections.length === 0 && name.length > 120)) name = "";
      if (!name) name = freq === "annual" ? "Annual" : freq === "monthly" ? "Monthly" : freq === "daily" ? "Daily" : `Section ${sections.length + 1}`;
      sections.push({ name, frequency: freq, columns, rows });
      lastEnd = j;
      i = j;
      continue;
    }
    i++;
  }
  return { dataset, url, preamble, sections };
}

export function normalizeDatasetName(name: string): string {
  return name.trim().replace(/\.zip$/i, "").replace(/_CSV$/i, "").replace(/\.csv$/i, "");
}

export function loadKfDataset(name: string): Promise<KfFile> {
  const ds = normalizeDatasetName(name);
  const ttl = /daily|weekly/i.test(ds) ? 12 * HOUR : 24 * HOUR;
  return cached(`kf:${ds}`, ttl, async () => {
    const url = `${FTP}/${encodeURIComponent(ds)}_CSV.zip`;
    let buf: Buffer;
    try {
      buf = await fetchBuffer(url, 45000);
    } catch (e: any) {
      if (/HTTP 404/.test(String(e?.message))) {
        throw new Error(`Ken French dataset "${ds}" not found (404). Call kfrench_dataset with search:"<keyword>" to list valid names.`);
      }
      throw e;
    }
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => /\.csv$/i.test(e.entryName));
    if (!entry) throw new Error(`Ken French zip ${ds} contained no CSV`);
    const text = entry.getData().toString("latin1");
    const file = parseKfCsv(text, ds, url);
    if (!file.sections.length) {
      const err = new Error(`Ken French ${ds}: no data sections recognized`) as Error & { sampleRaw?: string };
      err.sampleRaw = text.slice(0, 800);
      throw err;
    }
    return file;
  });
}

const FALLBACK_CATALOG = [
  "F-F_Research_Data_Factors", "F-F_Research_Data_Factors_weekly", "F-F_Research_Data_Factors_daily",
  "F-F_Research_Data_5_Factors_2x3", "F-F_Research_Data_5_Factors_2x3_daily",
  "F-F_Momentum_Factor", "F-F_Momentum_Factor_daily", "F-F_ST_Reversal_Factor", "F-F_LT_Reversal_Factor",
  "6_Portfolios_2x3", "25_Portfolios_5x5", "100_Portfolios_10x10",
  "5_Industry_Portfolios", "10_Industry_Portfolios", "12_Industry_Portfolios", "17_Industry_Portfolios",
  "30_Industry_Portfolios", "38_Industry_Portfolios", "48_Industry_Portfolios", "49_Industry_Portfolios",
  "Portfolios_Formed_on_ME", "Portfolios_Formed_on_BE-ME", "Portfolios_Formed_on_OP", "Portfolios_Formed_on_INV",
  "10_Portfolios_Prior_12_2", "Developed_3_Factors", "Developed_5_Factors", "Developed_Mom_Factor",
  "Developed_ex_US_3_Factors", "Developed_ex_US_5_Factors", "Europe_5_Factors", "Japan_5_Factors",
  "Asia_Pacific_ex_Japan_5_Factors", "North_America_5_Factors", "Emerging_5_Factors", "Emerging_MOM_Factor",
];

export function loadKfCatalog(): Promise<{ names: string[]; live: boolean }> {
  return cached("kf:catalog", 24 * HOUR, async () => {
    try {
      const html = await fetchText(LIBRARY, 20000);
      const names = Array.from(new Set(Array.from(html.matchAll(/ftp\/([^"'\s>]+?)_CSV\.zip/gi)).map((m) => decodeURIComponent(m[1]!)))).sort();
      if (names.length > 20) return { names, live: true };
    } catch {
      /* fall through */
    }
    return { names: FALLBACK_CATALOG, live: false };
  });
}

// ---------------------------------------------------------------------------
// kfrench_factors
// ---------------------------------------------------------------------------

type Model = "ff3" | "ff5" | "mom" | "ff3+mom" | "ff5+mom";
type Freq = "daily" | "weekly" | "monthly" | "annual";

const REGIONS: Record<string, string> = {
  us: "US",
  developed: "Developed",
  developed_ex_us: "Developed_ex_US",
  europe: "Europe",
  japan: "Japan",
  asia_pacific_ex_japan: "Asia_Pacific_ex_Japan",
  north_america: "North_America",
  emerging: "Emerging",
};

function fileFor(kind: "ff3" | "ff5" | "mom", region: string, freq: Freq): string {
  const daily = freq === "daily";
  if (region === "US") {
    if (freq === "weekly") {
      if (kind !== "ff3") throw new Error("Weekly frequency exists only for the US 3-factor file (F-F_Research_Data_Factors_weekly).");
      return "F-F_Research_Data_Factors_weekly";
    }
    if (kind === "ff3") return daily ? "F-F_Research_Data_Factors_daily" : "F-F_Research_Data_Factors";
    if (kind === "ff5") return daily ? "F-F_Research_Data_5_Factors_2x3_daily" : "F-F_Research_Data_5_Factors_2x3";
    return daily ? "F-F_Momentum_Factor_daily" : "F-F_Momentum_Factor";
  }
  if (freq === "weekly") throw new Error("Weekly frequency exists only for US 3 factors.");
  if (region === "Emerging") {
    if (daily) throw new Error("Emerging-markets factors are monthly/annual only.");
    if (kind === "ff3") throw new Error("Emerging markets publish 5 factors (use model ff5 / ff5+mom), not a 3-factor file.");
    return kind === "ff5" ? "Emerging_5_Factors" : "Emerging_MOM_Factor";
  }
  const sfx = daily ? "_Daily" : "";
  if (kind === "ff3") return `${region}_3_Factors${sfx}`;
  if (kind === "ff5") return `${region}_5_Factors${sfx}`;
  const mom = region === "Asia_Pacific_ex_Japan" ? "MOM" : "Mom";
  return `${region}_${mom}_Factor${sfx}`;
}

function pickSection(file: KfFile, freq: Freq): KfSection {
  if (freq === "annual") {
    const s = file.sections.find((x) => x.frequency === "annual");
    if (!s) throw new Error(`${file.dataset} has no annual section`);
    return s;
  }
  return file.sections[0]!;
}

function statsPct(rets: number[], ppy: number) {
  const s = returnStats(rets.map((r) => r / 100), ppy);
  const pct = (v: number | null) => (v == null ? null : round(v * 100, 2));
  return {
    periods: s.periods,
    cumulativeReturnPct: pct(s.cumulativeReturn),
    annualizedReturnPct: pct(s.annualizedReturn),
    annualizedVolPct: pct(s.annualizedVol),
    meanPerPeriodPct: s.arithmeticMeanPerPeriod == null ? null : round(s.arithmeticMeanPerPeriod * 100, 3),
    sharpeLike: s.sharpeLike,
    bestPct: pct(s.best),
    worstPct: pct(s.worst),
    pctPositive: s.pctPositive,
  };
}

const PPY: Record<Freq, number> = { daily: 252, weekly: 52, monthly: 12, annual: 1 };

export interface KfFactorsArgs {
  model?: Model;
  frequency?: Freq;
  region?: string;
  recent?: number;
  start?: string;
  end?: string;
  years?: number;
}

export async function kfrenchFactors(args: KfFactorsArgs) {
  const model = (args.model ?? "ff3") as Model;
  const freq = (args.frequency ?? "monthly") as Freq;
  if (!["ff3", "ff5", "mom", "ff3+mom", "ff5+mom"].includes(model)) throw new Error(`model must be ff3 | ff5 | mom | ff3+mom | ff5+mom`);
  if (!["daily", "weekly", "monthly", "annual"].includes(freq)) throw new Error("frequency must be daily | weekly | monthly | annual");
  const regionKey = String(args.region ?? "US").toLowerCase().replace(/[\s-]+/g, "_");
  const region = REGIONS[regionKey];
  if (!region) throw new Error(`region must be one of ${Object.values(REGIONS).join(", ")}`);

  const kinds: ("ff3" | "ff5" | "mom")[] =
    model === "ff3+mom" ? ["ff3", "mom"] : model === "ff5+mom" ? ["ff5", "mom"] : [model];
  const files = await Promise.all(kinds.map((k) => loadKfDataset(fileFor(k, region, freq))));
  const secs = files.map((f) => pickSection(f, freq));

  // Merge on period: base = first section's dates; extra columns joined by period.
  const base = secs[0]!;
  const columns = [...base.columns];
  const extraMaps: Map<string, (number | null)[]>[] = [];
  for (const s of secs.slice(1)) {
    columns.push(...s.columns.map((c) => (c === "WML" ? "Mom" : c)));
    extraMaps.push(new Map(s.rows.map((r) => [r.period, r.values])));
  }
  for (let i = 0; i < columns.length; i++) if (columns[i] === "WML") columns[i] = "Mom";
  const merged: KfRow[] = base.rows.map((r) => {
    const vals = [...r.values];
    secs.slice(1).forEach((s, k) => {
      const ex = extraMaps[k]!.get(r.period);
      vals.push(...(ex ?? s.columns.map(() => null)));
    });
    return { ...r, values: vals };
  });

  const years = args.start || args.end ? args.years : args.years ?? 10;
  const win = windowFilter(merged, { start: args.start, end: args.end, years });
  if (!win.length) throw new Error("No observations in the requested window.");

  const stats: Record<string, ReturnType<typeof statsPct>> = {};
  columns.forEach((c, idx) => {
    const vals = win.map((r) => r.values[idx]).filter((v): v is number => v != null);
    stats[c] = statsPct(vals, PPY[freq]);
  });
  const iMkt = columns.indexOf("Mkt-RF");
  const iRf = columns.indexOf("RF");
  if (iMkt >= 0 && iRf >= 0) {
    const mkt = win
      .map((r) => (r.values[iMkt] != null && r.values[iRf] != null ? r.values[iMkt]! + r.values[iRf]! : null))
      .filter((v): v is number => v != null);
    stats["Mkt (total = Mkt-RF + RF)"] = statsPct(mkt, PPY[freq]);
  }

  const recentN = clampInt(args.recent, freq === "daily" ? 10 : freq === "annual" ? 10 : 12, 1, 120);
  const recent = merged.slice(-recentN).map((r) => {
    const o: Record<string, number | string | null> = { period: r.period };
    columns.forEach((c, idx) => (o[c] = r.values[idx] ?? null));
    return o;
  });
  const latest = recent[recent.length - 1];

  return {
    dataSource: `Kenneth R. French Data Library — ${files.map((f) => f.dataset).join(" + ")} (${region}, ${freq})`,
    model,
    region,
    frequency: freq,
    columns,
    latest,
    window: { from: win[0]!.period, to: win[win.length - 1]!.period, periods: win.length },
    windowStats: stats,
    recent,
    sourceFiles: files.map((f) => f.url),
    vintage: files[0]!.preamble.match(/created (?:using|by using) the (\d{6})/)?.[1] ?? null,
    note:
      "All returns are in PERCENT per period (1.23 = 1.23%). Mkt-RF = market excess return; SMB size; HML value; RMW profitability; CMA investment; Mom/WML momentum (12-2); RF = 1-month T-bill. Factors are long/short excess returns, so sharpeLike is a true Sharpe for them. Window stats default to the last 10 years (override with years/start/end); annualizedReturnPct is geometric and null for windows under 1 year. US data are CRSP-based and lag ~1 month (vintage = CRSP month). For industry/size/value portfolios or any other library file use kfrench_dataset.",
  };
}

// ---------------------------------------------------------------------------
// kfrench_dataset
// ---------------------------------------------------------------------------

export interface KfDatasetArgs {
  name?: string;
  search?: string;
  section?: string | number;
  columns?: string[];
  recent?: number;
  start?: string;
  end?: string;
  years?: number;
  stats?: boolean;
}

function findSection(file: KfFile, sel: string | number | undefined): KfSection {
  if (sel == null || sel === "") return file.sections[0]!;
  if (typeof sel === "number" || /^\d+$/.test(String(sel))) {
    const idx = Number(sel);
    const s = file.sections[idx];
    if (!s) throw new Error(`section index ${idx} out of range (0..${file.sections.length - 1})`);
    return s;
  }
  const q = String(sel).toLowerCase();
  const exact = file.sections.find((s) => s.name.toLowerCase() === q);
  if (exact) return exact;
  const words = q.split(/[\s\-–—_]+/).filter((w) => w && w !== "returns" && w !== "average");
  const scored = file.sections
    .map((s, i) => ({ s, i, score: words.filter((w) => s.name.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  if (!scored.length) throw new Error(`No section matching "${sel}". Sections: ${file.sections.map((s) => s.name).join(" | ")}`);
  return scored[0]!.s;
}

export async function kfrenchDataset(args: KfDatasetArgs) {
  if (!args.name) {
    const { names, live } = await loadKfCatalog();
    const words = String(args.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hits = names.filter((n) => words.every((w) => n.toLowerCase().includes(w)));
    return {
      dataSource: `Kenneth R. French Data Library catalog (${live ? "live from data_library.html" : "built-in fallback list"})`,
      total: hits.length,
      datasets: hits.slice(0, 80),
      note:
        "Pass one of these as `name` (no _CSV.zip suffix). Naming: *_daily/_Daily = daily; *_Wout_Div = returns without dividends; ME = size, BE-ME = book-to-market, OP = profitability, INV = investment, Prior_12_2 = momentum sorts. Regional files: Developed, Developed_ex_US, Europe, Japan, Asia_Pacific_ex_Japan, North_America, Emerging.",
    };
  }

  const file = await loadKfDataset(args.name);
  const sec = findSection(file, args.section);
  let colIdx = sec.columns.map((_, i) => i);
  let truncatedColumns = false;
  if (args.columns?.length) {
    const want = args.columns.map((c) => c.toLowerCase());
    colIdx = colIdx.filter((i) => want.includes(sec.columns[i]!.toLowerCase()));
    if (!colIdx.length) throw new Error(`None of ${args.columns.join(", ")} in section columns: ${sec.columns.join(", ")}`);
  } else if (colIdx.length > 25) {
    colIdx = colIdx.slice(0, 25);
    truncatedColumns = true;
  }
  const cols = colIdx.map((i) => sec.columns[i]!);

  const recentN = clampInt(args.recent, 12, 1, 120);
  const recent = sec.rows.slice(-recentN).map((r) => {
    const o: Record<string, number | string | null> = { period: r.period };
    colIdx.forEach((i) => (o[sec.columns[i]!] = r.values[i] ?? null));
    return o;
  });

  const looksLikeReturns = !/firms|size|be\s*\/\s*me|sum of|breakpoint|number|average (?:firm|be|op|inv)/i.test(sec.name);
  const wantStats = args.stats ?? (looksLikeReturns && cols.length <= 12);
  let windowStats: Record<string, ReturnType<typeof statsPct>> | undefined;
  let window: { from: string; to: string; periods: number } | undefined;
  if (wantStats && sec.frequency !== "unknown") {
    const years = args.start || args.end ? args.years : args.years ?? 10;
    const win = windowFilter(sec.rows, { start: args.start, end: args.end, years });
    if (win.length) {
      window = { from: win[0]!.period, to: win[win.length - 1]!.period, periods: win.length };
      windowStats = {};
      const ppy = sec.frequency === "daily" ? 252 : sec.frequency === "weekly" ? 52 : sec.frequency === "annual" ? 1 : 12;
      for (const i of colIdx) {
        const vals = win.map((r) => r.values[i]).filter((v): v is number => v != null);
        windowStats[sec.columns[i]!] = statsPct(vals, ppy);
      }
    }
  }

  return {
    dataSource: `Kenneth R. French Data Library — ${file.dataset}`,
    dataset: file.dataset,
    sections: file.sections.map((s, i) => ({
      index: i,
      name: s.name,
      frequency: s.frequency,
      rows: s.rows.length,
      first: s.rows[0]?.period ?? null,
      last: s.rows[s.rows.length - 1]?.period ?? null,
    })),
    section: { name: sec.name, frequency: sec.frequency, columns: sec.columns.length > 40 ? `${sec.columns.length} columns (first 25 shown)` : sec.columns },
    shownColumns: cols,
    truncatedColumns,
    recent,
    window,
    windowStats,
    description: file.preamble.slice(0, 300),
    sourceUrl: file.url,
    note:
      "Multi-table files (e.g. industry portfolios) contain value-weighted and equal-weighted monthly + annual return sections, plus firm counts / average size / BE-ME — pick one with `section` (index or name words like 'equal annual'). Return values are PERCENT; -99.99/-999 missing values are returned as null. windowStats (default last 10 years) are computed only for return sections with ≤12 shown columns unless stats:true. Use `columns` to choose portfolios when a section has many. For standard factor models prefer kfrench_factors.",
  };
}
