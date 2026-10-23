/**
 * TIC — Major Foreign Holders of Treasury Securities (MFH), keyless.
 *
 * Verified live 2026-10-22:
 *   https://ticdata.treasury.gov/Publish/slt_table5.txt
 *     "Table 5: Major Foreign Holders of Treasury Securities", tab-separated, $bn, 13 most recent months
 *     (columns "2026-08" … "2025-08"), ~20 named countries + All Other + Grand Total + "Of Which: Foreign
 *     Official" (total / T-bills / bonds & notes). Updated with the monthly TIC release (~6-7 weeks after
 *     month-end; last-modified 2026-10-16 for August data).
 *   https://ticdata.treasury.gov/Publish/mfhhis01.txt
 *     Long history (one 12-month block per calendar year back to 2000, ~98 KB, tab-separated) — used for
 *     the `country` series option. Updated on the same cadence (contains the completed prior year + current
 *     year-to-date block; as of Oct 2026 its newest block is calendar 2025, so Table 5 is the fresh source).
 *   QUIRK: ticdata.treasury.gov's edge delays responses ~10 s when the User-Agent contains an '@' or a URL
 *     (0.3 s with a plain token), so these two fetches send a plain "Vistamark Intel" UA.
 *   NOTE: the oft-cited .../tic/Documents/mfh.txt (and /Publish/mfh.txt) is a STALE fixed-width snapshot
 *     (Jan 2023, last-modified Feb 2026) — do not use.
 */
import { cached, fetchText, HOUR, round, clampInt, MONTH_INDEX, pad2 } from "./common";

const TABLE5_URL = "https://ticdata.treasury.gov/Publish/slt_table5.txt";
const HIST_URL = "https://ticdata.treasury.gov/Publish/mfhhis01.txt";
const TIC_UA = "Vistamark Intel (vistamark-ria-intel)";

export interface MfhTable {
  months: string[];                     // ISO YYYY-MM, newest first
  rows: Array<{ name: string; values: Array<number | null>; kind: "country" | "aggregate" | "memo" }>;
}

function cleanName(s: string): string {
  return s.replace(/^"|"$/g, "").replace(/\s+\d+\/$/, "").trim();
}

export function parseTable5(text: string): MfhTable {
  const lines = text.replace(/\r/g, "").split("\n");
  const hdrIdx = lines.findIndex((l) => /^Country\t\d{4}-\d{2}/.test(l));
  if (hdrIdx < 0) throw new Error("TIC Table 5 header not found — layout may have changed");
  const months = lines[hdrIdx]!.split("\t").slice(1).map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}$/.test(s));
  const rows: MfhTable["rows"] = [];
  for (const line of lines.slice(hdrIdx + 1)) {
    if (!line.trim()) {
      if (rows.length) break;
      continue;
    }
    const cells = line.split("\t");
    const name = cleanName(cells[0] ?? "");
    if (!name || /^Notes?:/i.test(name)) break;
    const values = months.map((_, i) => {
      const v = (cells[i + 1] ?? "").trim();
      const n = Number(v);
      return v && Number.isFinite(n) ? n : null;
    });
    if (values.every((v) => v == null)) continue;
    const kind: MfhTable["rows"][number]["kind"] = /^Of Which/i.test(name) ? "memo" : /^(All Other|Grand Total)$/i.test(name) ? "aggregate" : "country";
    rows.push({ name, values, kind });
  }
  if (!rows.length) throw new Error("TIC Table 5 parsed no rows");
  return { months, rows };
}

/** Parse mfhhis01.txt into {country -> {YYYY-MM -> $bn}} across all yearly blocks. */
export function parseHistory(text: string): Map<string, Map<string, number>> {
  const lines = text.replace(/\r/g, "").split("\n");
  const out = new Map<string, Map<string, number>>();
  let months: string[] | null = null;
  let monthNames: string[] | null = null;
  for (const raw of lines) {
    const cells = raw.split("\t").map((c) => c.trim());
    const first = cells[0] ?? "";
    if (!first && cells.slice(1).some((c) => MONTH_INDEX[c.toLowerCase()] != null)) {
      monthNames = cells.slice(1);
      months = null;
      continue;
    }
    if (/^Country$/i.test(first) && monthNames) {
      months = monthNames.map((mn, i) => {
        const y = cells[i + 1];
        const mi = MONTH_INDEX[mn.toLowerCase()];
        return y && /^\d{4}$/.test(y) && mi != null ? `${y}-${pad2(mi + 1)}` : "";
      });
      continue;
    }
    if (!months) continue;
    if (!first || /^-+$/.test(cells[1] ?? "")) continue;
    if (/^\d+\/|^Department|^Notes?/i.test(first)) {
      months = null;
      monthNames = null;
      continue;
    }
    const name = cleanName(first);
    const series = out.get(name) ?? new Map<string, number>();
    months.forEach((m, i) => {
      if (!m) return;
      const n = Number(cells[i + 1]);
      if (cells[i + 1] && Number.isFinite(n) && !series.has(m)) series.set(m, n);
    });
    if (series.size) out.set(name, series);
  }
  return out;
}

export function loadTable5(): Promise<MfhTable> {
  return cached("fedboard:tic:table5", 12 * HOUR, async () => parseTable5(await fetchText(TABLE5_URL, 25000, 2, "text/plain,*/*", TIC_UA)));
}
export function loadHistory(): Promise<Map<string, Map<string, number>>> {
  return cached("fedboard:tic:hist", 24 * HOUR, async () => parseHistory(await fetchText(HIST_URL, 30000, 2, "text/plain,*/*", TIC_UA)));
}

const ALIASES: Record<string, string> = {
  china: "China, Mainland", prc: "China, Mainland", uk: "United Kingdom", britain: "United Kingdom", korea: "Korea, South",
  "south korea": "Korea, South", uae: "United Arab Emirates", cayman: "Cayman Islands", caymans: "Cayman Islands",
  hk: "Hong Kong", "hong kong": "Hong Kong", total: "Grand Total", "grand total": "Grand Total", official: "Of Which: Foreign Official",
};

export async function treasuryTicHolders(args: { top?: number; country?: string; sortBy?: string; months?: number }) {
  const top = clampInt(args.top, 15, 1, 25);
  const sortBy = String(args.sortBy ?? "holdings").toLowerCase();
  if (!["holdings", "change12m", "change1m"].includes(sortBy)) throw new Error("sortBy must be holdings | change12m | change1m");
  const t5 = await loadTable5();
  const latest = t5.months[0]!;
  const prior = t5.months[1] ?? null;
  const yearAgo = t5.months[12] ?? t5.months[t5.months.length - 1]!;
  const yearAgoIdx = t5.months.indexOf(yearAgo);
  const total = t5.rows.find((r) => r.name === "Grand Total");
  const totalLatest = total?.values[0] ?? null;

  const shape = (r: MfhTable["rows"][number]) => {
    const v0 = r.values[0];
    const v1 = prior ? r.values[1] : null;
    const v12 = r.values[yearAgoIdx];
    return {
      name: r.name,
      holdingsBn: v0,
      shareOfForeignPct: v0 != null && totalLatest ? round((v0 / totalLatest) * 100, 1) : null,
      change1mBn: v0 != null && v1 != null ? round(v0 - v1, 1) : null,
      change12mBn: v0 != null && v12 != null ? round(v0 - v12, 1) : null,
      change12mPct: v0 != null && v12 ? round(((v0 - v12) / v12) * 100, 1) : null,
    };
  };

  if (args.country) {
    const q = String(args.country).trim().toLowerCase();
    const target = ALIASES[q] ?? null;
    const row = t5.rows.find((r) => (target ? r.name === target : r.name.toLowerCase() === q || r.name.toLowerCase().includes(q)));
    const name = row?.name ?? target ?? args.country;
    const monthsN = clampInt(args.months, 24, 1, 120);
    const hist = await loadHistory().catch(() => null);
    const hs = hist?.get(name) ?? hist?.get(name.replace(/^"|"$/g, "")) ?? null;
    const series = new Map<string, number>();
    if (hs) for (const [m, v] of hs) series.set(m, v);
    if (row) t5.months.forEach((m, i) => { const v = row.values[i]; if (v != null) series.set(m, v); });
    if (!series.size) {
      const known = t5.rows.filter((r) => r.kind === "country").map((r) => r.name);
      throw new Error(`Country '${args.country}' not in the MFH table. Named holders: ${known.join("; ")}. Smaller holders are aggregated in 'All Other'.`);
    }
    const pts = Array.from(series.entries()).sort((a, b) => b[0].localeCompare(a[0])).slice(0, monthsN);
    return {
      source: "U.S. Treasury TIC — Major Foreign Holders of Treasury Securities (slt_table5.txt + mfhhis01.txt)",
      fetchedAt: new Date().toISOString(),
      asOf: latest,
      country: name,
      ...(row ? shape(row) : {}),
      rankAmongNamed: row && row.kind === "country" ? t5.rows.filter((r) => r.kind === "country" && (r.values[0] ?? -1) > (row.values[0] ?? -1)).length + 1 : undefined,
      series: pts.map(([m, v]) => ({ month: m, holdingsBn: v })),
      units: "$ billions, end of month; marketable + non-marketable Treasury bills, notes and bonds",
      note: "Custodial data: holdings in custodial centres (Belgium/Euroclear, Luxembourg, Cayman, UK, Switzerland) may belong to residents of other countries (TIC FAQ #7).",
    };
  }

  const countries = t5.rows.filter((r) => r.kind === "country").map(shape);
  const key = sortBy === "holdings" ? "holdingsBn" : sortBy === "change12m" ? "change12mBn" : "change1mBn";
  const sorted = [...countries].sort((a, b) => ((b as any)[key] ?? -Infinity) - ((a as any)[key] ?? -Infinity));
  const aggregates = t5.rows.filter((r) => r.kind !== "country").map(shape);
  const officialRow = t5.rows.find((r) => /^Of Which: Foreign Official$/i.test(r.name));
  const risers = [...countries].sort((a, b) => (b.change12mBn ?? -Infinity) - (a.change12mBn ?? -Infinity)).slice(0, 3);
  const fallers = [...countries].sort((a, b) => (a.change12mBn ?? Infinity) - (b.change12mBn ?? Infinity)).slice(0, 3);
  return {
    source: "U.S. Treasury TIC — Major Foreign Holders of Treasury Securities (Table 5, slt_table5.txt)",
    fetchedAt: new Date().toISOString(),
    asOf: latest,
    comparedTo: { oneMonth: prior, twelveMonths: yearAgo },
    totalForeignBn: totalLatest,
    totalChange12mBn: total ? round((total.values[0] ?? 0) - (total.values[yearAgoIdx] ?? 0), 1) : null,
    foreignOfficialBn: officialRow?.values[0] ?? null,
    foreignOfficialSharePct: officialRow?.values[0] != null && totalLatest ? round((officialRow.values[0] / totalLatest) * 100, 1) : null,
    sortBy,
    holders: sorted.slice(0, top),
    biggestRisers12m: risers.map((r) => `${r.name} ${r.change12mBn! >= 0 ? "+" : ""}${r.change12mBn}`),
    biggestFallers12m: fallers.map((r) => `${r.name} ${r.change12mBn}`),
    aggregates,
    units: "$ billions, end of month",
    note: "Published ~6–7 weeks after month-end with the monthly TIC release. Custodial-centre caveat (TIC FAQ #7) applies. Pass `country` for a multi-year monthly series.",
  };
}
