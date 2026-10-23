/**
 * Shared helpers for the housing-markets family: a line-streaming CSV reader
 * over politeFetch (never buffers the whole file), a quoted-CSV splitter, and
 * the series shaping (latest, trailing changes, CAGR, peak/drawdown, recent
 * history) that every price/rent/inventory index gets.
 */
import { politeFetch, redactUrl } from "../data/http";
import { round } from "../research/common";

export { cached, clampInt, round, toNum, HOUR } from "../research/common";

/** Split one CSV line honouring double-quoted fields (Zillow quotes "Chicago, IL"). */
export function splitCsv(line: string): string[] {
  if (line.indexOf('"') < 0) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export interface StreamStats {
  bytes: number;
  lines: number;
  ms: number;
  cancelled: boolean;
}

/**
 * Stream a CSV from `url`, calling `onLine(line, index)` for every line (index
 * 0 = header). Return `false` from onLine to cancel the download early (used
 * when a file is sorted so the rest cannot match). Only one line is ever held
 * in memory; the 125 MB Zillow zip file runs in ~3.5 s / <100 MB RSS.
 */
export async function streamCsvLines(
  url: string,
  onLine: (line: string, index: number) => boolean | void,
  opts: { timeoutMs?: number; deadlineMs?: number; retries?: number } = {}
): Promise<StreamStats> {
  const t0 = Date.now();
  const deadline = opts.deadlineMs ?? 50000;
  const res = await politeFetch(url, {
    timeoutMs: opts.timeoutMs ?? 30000,
    retries: opts.retries ?? 1,
    headers: { Accept: "text/csv, */*" },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  }
  if (!res.body) throw new Error(`Empty body from ${redactUrl(url)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let lines = 0;
  let bytes = 0;
  let cancelled = false;
  const feed = (text: string): boolean => {
    buf += text;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (lines === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      const r = onLine(line, lines++);
      if (r === false) return false;
    }
    return true;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (!feed(dec.decode(value, { stream: true }))) {
        cancelled = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (Date.now() - t0 > deadline) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Timed out streaming ${redactUrl(url)} after ${Math.round((Date.now() - t0) / 1000)}s (${Math.round(bytes / 1e6)} MB read)`);
      }
    }
    if (!cancelled) {
      buf += dec.decode();
      if (buf.length) onLine(buf.replace(/\r$/, ""), lines++);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { bytes, lines, ms: Date.now() - t0, cancelled };
}

export interface SeriesPoint {
  date: string; // YYYY-MM-DD (period end) or YYYY-MM / YYYYQn / YYYY
  value: number;
}

export interface SeriesShape {
  latest: { date: string; value: number } | null;
  firstDate: string | null;
  periods: number;
  change: Record<string, number | null>;
  cagr: Record<string, number | null>;
  peak: { date: string; value: number; drawdownPct: number | null } | null;
  trough: { date: string; value: number } | null;
  recent: Array<[string, number]>;
}

export interface ShapeOptions {
  /** periods per year (12 monthly, 4 quarterly, 1 annual) */
  periodsPerYear: number;
  /** how many trailing rows to return */
  recent: number;
  /** decimals for values (0 = whole dollars) */
  dp?: number;
  /** horizon labels in periods: default monthly {1m,3m,12m,3y,5y,10y} */
  horizons?: Record<string, number>;
}

/**
 * Compute latest/changes/CAGR/peak/drawdown/recent for an ascending series.
 * Changes are PERCENT (12.3 = +12.3%). CAGR is only given for horizons >= 1y.
 */
export function shapeSeries(points: SeriesPoint[], opts: ShapeOptions): SeriesShape {
  const pts = points.filter((p) => Number.isFinite(p.value));
  const dp = opts.dp ?? 0;
  const ppy = opts.periodsPerYear;
  const n = pts.length;
  if (!n) {
    return { latest: null, firstDate: null, periods: 0, change: {}, cagr: {}, peak: null, trough: null, recent: [] };
  }
  const last = pts[n - 1]!;
  const horizons =
    opts.horizons ??
    (ppy === 12
      ? { "1m": 1, "3m": 3, "12m": 12, "3y": 36, "5y": 60, "10y": 120 }
      : ppy === 4
        ? { "1q": 1, "1y": 4, "3y": 12, "5y": 20, "10y": 40 }
        : { "1y": 1, "3y": 3, "5y": 5, "10y": 10, "20y": 20 });
  const change: Record<string, number | null> = {};
  const cagr: Record<string, number | null> = {};
  for (const [label, k] of Object.entries(horizons)) {
    const base = n - 1 - k >= 0 ? pts[n - 1 - k]!.value : null;
    change[label] = base && base > 0 ? round(((last.value - base) / base) * 100, 1) : null;
    if (k >= ppy) {
      cagr[label] = base && base > 0 ? round((Math.pow(last.value / base, ppy / k) - 1) * 100, 2) : null;
    }
  }
  // since inception
  const first = pts[0]!;
  const years = (n - 1) / ppy;
  change.sinceStart = first.value > 0 ? round(((last.value - first.value) / first.value) * 100, 1) : null;
  cagr.sinceStart = first.value > 0 && years >= 1 ? round((Math.pow(last.value / first.value, 1 / years) - 1) * 100, 2) : null;

  let peak = pts[0]!;
  let trough = pts[0]!;
  for (const p of pts) {
    if (p.value > peak.value) peak = p;
    if (p.value < trough.value) trough = p;
  }
  const recent = pts.slice(-Math.max(0, opts.recent)).map((p) => [p.date, round(p.value, dp) as number] as [string, number]);
  return {
    latest: { date: last.date, value: round(last.value, dp) as number },
    firstDate: first.date,
    periods: n,
    change,
    cagr,
    peak: {
      date: peak.date,
      value: round(peak.value, dp) as number,
      drawdownPct: peak.value > 0 ? round(((last.value - peak.value) / peak.value) * 100, 1) : null,
    },
    trough: { date: trough.date, value: round(trough.value, dp) as number },
    recent,
  };
}

/** Turn a Zillow-style wide row (date columns) into an ascending point series. */
export function wideRowToSeries(header: string[], cells: string[], firstDateCol: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (let i = firstDateCol; i < header.length; i++) {
    const raw = cells[i];
    if (raw == null || raw === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v)) out.push({ date: header[i]!, value: v });
  }
  return out;
}

export function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function pctOrNull(v: unknown, dp = 1): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? round(n * 100, dp) : null;
}
