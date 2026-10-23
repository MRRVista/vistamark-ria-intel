/**
 * SEC fails-to-deliver (FTD) data — semi-monthly zips of pipe-delimited text.
 *
 * Verified live 2026-10-21:
 *   Index page: https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data
 *     links /files/data/fails-deliver-data/cnsfails<YYYYMM><a|b>.zip
 *     (a = 1st-15th, b = 16th-end of month; posted ~2 weeks after period end).
 *   Each zip (~1.5 MB) holds one txt (~4 MB, ~65K rows):
 *     SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE
 *   followed by "Trailer record count" / "Trailer total quantity" lines.
 *   sec.gov requires a descriptive User-Agent (politeFetch sets it).
 */
import AdmZip from "adm-zip";
import { politeFetch } from "../data/http";
import { normSymbols } from "./finra";

const SEC = "https://www.sec.gov";
const INDEX_URL = `${SEC}/data-research/sec-markets-data/fails-deliver-data`;
const TTL = 24 * 3600_000;

interface FtdRow {
  settlementDate: string;
  cusip: string;
  quantity: number;
  price: number | null;
  description: string;
}
interface FtdFile {
  name: string; // cnsfails202609b
  rows: Map<string, FtdRow[]>;
  recordCount: number;
}

let indexCache: { at: number; files: string[] } | null = null;
const fileCache = new Map<string, { at: number; file: FtdFile }>();

async function listFiles(): Promise<string[]> {
  if (indexCache && Date.now() - indexCache.at < TTL) return indexCache.files;
  const res = await politeFetch(INDEX_URL, { retries: 2, timeoutMs: 15000, headers: { Accept: "text/html" } });
  if (!res.ok) throw new Error(`SEC FTD index HTTP ${res.status}`);
  const html = await res.text();
  const files = Array.from(new Set(Array.from(html.matchAll(/\/files\/data\/fails-deliver-data\/(cnsfails\d{6}[ab])\.zip/g)).map((m) => m[1])))
    .sort()
    .reverse();
  if (!files.length) throw new Error("SEC FTD index page parsed but no cnsfails*.zip links found (page layout may have changed)");
  indexCache = { at: Date.now(), files };
  return files;
}

async function loadFile(name: string): Promise<FtdFile> {
  const hit = fileCache.get(name);
  if (hit && Date.now() - hit.at < TTL) return hit.file;
  const url = `${SEC}/files/data/fails-deliver-data/${name}.zip`;
  const res = await politeFetch(url, { retries: 2, timeoutMs: 30000, headers: { Accept: "application/zip, */*" } });
  if (!res.ok) throw new Error(`SEC FTD HTTP ${res.status} for ${name}.zip`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => !e.isDirectory);
  if (!entry) throw new Error(`${name}.zip contained no file`);
  const text = entry.getData().toString("latin1");
  const rows = new Map<string, FtdRow[]>();
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const p = line.split("|");
    if (p.length < 6 || !/^\d{8}$/.test(p[0])) continue;
    const sym = p[2].trim().toUpperCase();
    if (!sym) continue;
    const row: FtdRow = {
      settlementDate: `${p[0].slice(0, 4)}-${p[0].slice(4, 6)}-${p[0].slice(6, 8)}`,
      cusip: p[1].trim(),
      quantity: Number(p[3]) || 0,
      price: p[5].trim() && Number.isFinite(Number(p[5])) ? Number(p[5]) : null,
      description: p[4].trim(),
    };
    const list = rows.get(sym);
    if (list) list.push(row);
    else rows.set(sym, [row]);
    n++;
  }
  if (!n) throw new Error(`${name}.zip parsed 0 rows — sample: ${JSON.stringify(text.slice(0, 200))}`);
  const file = { name, rows, recordCount: n };
  fileCache.set(name, { at: Date.now(), file });
  while (fileCache.size > 8) fileCache.delete(fileCache.keys().next().value as string);
  return file;
}

const periodLabel = (name: string) => {
  const m = name.match(/(\d{4})(\d{2})([ab])$/);
  return m ? `${m[1]}-${m[2]} ${m[3] === "a" ? "1st-15th" : "16th-EOM"}` : name;
};

async function secFailsToDeliver(args: any) {
  const all = await listFiles();
  const periods = Math.max(1, Math.min(6, Math.floor(Number(args?.periods ?? 2)) || 2));
  const names = all.slice(0, periods);
  const files: FtdFile[] = [];
  for (const nm of names) files.push(await loadFile(nm)); // sequential: polite to sec.gov, bounded to 6
  const symbols = normSymbols(args?.symbols ?? args?.symbol, 10);
  const dataSource = `SEC fails-to-deliver data (${INDEX_URL})`;
  const caveat =
    "FTD quantity = aggregate net balance of shares that failed to deliver as of that settlement date in NSCC's CNS system (a running balance, not new fails that day; do not sum across days). " +
    "PRICE = prior-day closing price as reported by SEC. Days with no outstanding fail balance are simply absent. Files lag ~2-4 weeks. Persistent large FTDs can indicate hard-to-borrow / settlement stress.";

  if (!symbols.length) {
    const top = Math.max(1, Math.min(50, Math.floor(Number(args?.top ?? 20)) || 20));
    const f = files[0];
    const ranked = [...f.rows.entries()].map(([sym, rs]) => {
      const peak = rs.reduce((a, r) => (r.quantity > a.quantity ? r : a), rs[0]);
      return {
        symbol: sym,
        description: peak.description,
        daysListed: rs.length,
        peakQuantity: peak.quantity,
        peakDate: peak.settlementDate,
        peakValueUsd: peak.price != null ? Math.round(peak.quantity * peak.price) : null,
      };
    }).sort((a, b) => (b.peakValueUsd ?? 0) - (a.peakValueUsd ?? 0));
    return {
      dataSource,
      mode: "rank",
      period: periodLabel(f.name),
      file: `${f.name}.zip`,
      top: ranked.slice(0, top),
      note: `Top ${top} securities by peak FTD dollar value (peak balance × price) in the latest period. ${caveat}`,
    };
  }

  const results = symbols.map((sym) => {
    const rows = files.flatMap((f) => f.rows.get(sym) ?? [])
      .sort((a, b) => b.settlementDate.localeCompare(a.settlementDate));
    const peak = rows.reduce<FtdRow | null>((a, r) => (!a || r.quantity > a.quantity ? r : a), null);
    return {
      symbol: sym,
      description: rows[0]?.description ?? null,
      cusip: rows[0]?.cusip ?? null,
      daysListed: rows.length,
      peak: peak ? { date: peak.settlementDate, quantity: peak.quantity, price: peak.price, valueUsd: peak.price != null ? Math.round(peak.quantity * peak.price) : null } : null,
      series: rows.slice(0, 40).map((r) => ({
        date: r.settlementDate,
        quantity: r.quantity,
        price: r.price,
        valueUsd: r.price != null ? Math.round(r.quantity * r.price) : null,
      })),
    };
  });
  return {
    dataSource,
    mode: "symbols",
    periods: names.map(periodLabel),
    files: names.map((n) => `${n}.zip`),
    results,
    note: `Newest first (series capped at 40 rows). daysListed=0 means no reportable FTD balance in these periods (a good sign), or a ticker mismatch. ${caveat}`,
  };
}

export const SEC_FTD_TOOL_DEFS = [
  {
    name: "sec_fails_to_deliver",
    description:
      "SEC FAILS-TO-DELIVER (no key): NSCC CNS fail-to-deliver balances by settlement date from the SEC's semi-monthly files. " +
      "symbols mode — pass `symbols` (1-10): per symbol, FTD quantity (shares), price, $ value by settlement date over the last `periods` half-month files (default 2 ≈ one month, max 6 ≈ three months), plus the peak. " +
      "rank mode — omit `symbols`: top `top` (default 20) securities by peak FTD $ value in the latest half-month file. " +
      "Quantities are running balances (do not sum across dates); data lags ~2-4 weeks (latest file shown in response). " +
      "Use alongside finra_short_interest and finra_short_volume to assess short crowding / settlement stress (e.g. meme-stock or hard-to-borrow situations), or to spot ETF creation/redemption fails.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Tickers. Omit for rank mode." },
        periods: { type: "integer", minimum: 1, maximum: 6, description: "Number of most recent half-month files (default 2)." },
        top: { type: "integer", minimum: 1, maximum: 50, description: "Rank mode: number of names (default 20)." },
      },
    },
    handler: secFailsToDeliver,
  },
];
