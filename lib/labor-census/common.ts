/**
 * Shared helpers for the Labor & Demographics family (BLS, QCEW, Census).
 * Re-exports the research-family cache/number utilities and adds a tiny
 * RFC-4180 CSV splitter plus FIPS helpers used by several modules.
 */
import { politeFetch, redactUrl } from "../data/http";

export { cached, HOUR, round, clampInt, toNum, percentileRank } from "../research/common";

export const DAY = 24 * 60 * 60 * 1000;

/** GET text with a status guard. Short retry budget: tool calls have ~60 s total. */
export async function getText(url: string, timeoutMs = 20000, retries = 1): Promise<string> {
  const res = await politeFetch(url, { timeoutMs, retries, headers: { Accept: "text/csv, application/json, */*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  return await res.text();
}

/** Split one CSV line honoring double quotes. */
export function splitCsvLine(line: string): string[] {
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

/** Parse CSV text into objects keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]!).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c]!] = cells[c] ?? "";
    rows.push(row);
  }
  return rows;
}

export function pctChange(curr: number | null, prev: number | null, dp = 2): number | null {
  if (curr == null || prev == null || prev === 0) return null;
  const f = Math.pow(10, dp);
  return Math.round(((curr - prev) / Math.abs(prev)) * 100 * f) / f;
}

export const STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09", DE: "10", DC: "11", FL: "12", GA: "13",
  HI: "15", ID: "16", IL: "17", IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25",
  MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36",
  NC: "37", ND: "38", OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47", TX: "48",
  UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55", WY: "56", PR: "72",
};

/** Accept "17", "IL", "il" → "17". */
export function stateFips(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (/^\d{1,2}$/.test(s)) return s.padStart(2, "0");
  return STATE_FIPS[s] ?? null;
}

/** Normalize a county FIPS: "17043" | 17043 | {state:"IL", county:"043"} → { state:"17", county:"043" }. */
export function countyFips(v: unknown, stateHint?: unknown): { state: string; county: string } | null {
  if (v == null) return null;
  const s = String(v).replace(/\D/g, "");
  if (s.length === 5) return { state: s.slice(0, 2), county: s.slice(2) };
  if (s.length <= 3 && stateHint != null) {
    const st = stateFips(stateHint);
    if (st) return { state: st, county: s.padStart(3, "0") };
  }
  return null;
}
