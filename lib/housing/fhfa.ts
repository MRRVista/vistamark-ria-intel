/**
 * FHFA House Price Index (keyless; verified live 2026-10-22).
 *
 * 1) Master file (all published HPI series in one long CSV, 17 MB, ~186k rows,
 *    refreshed with each monthly/quarterly release, ~2 months after period end):
 *      https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv
 *    Columns: hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,
 *             index_nsa,index_sa,rstderr,note
 *    Series present (hpi_type / hpi_flavor / frequency / level):
 *      traditional  purchase-only    monthly    USA or Census Division   (SA + NSA)
 *      traditional  purchase-only    quarterly  USA/Division, State, MSA
 *      traditional  all-transactions quarterly  USA/Division, State, MSA (NSA only)
 *      traditional  expanded-data    quarterly  USA/Division, State, MSA
 *      distress-free purchase-only   quarterly  MSA
 *      non-metro    all-transactions quarterly  State
 *      manufactured / developmental  quarterly  USA/Division, Puerto Rico
 *    There is NO /quarterly/hpi_master.csv (404) — the one file holds both.
 *    Metro rows are named "Chicago-Naperville-Schaumburg, IL (MSAD)" with the
 *    CBSA/MSAD code in place_id (16984). ZIP-level data is not in the master.
 *
 * 2) ZIP-level annual indexes (experimental, all-transactions, NSA, updated each
 *    March with the prior year):
 *      https://www.fhfa.gov/hpi/download/annual/hpi_at_zip3.xlsx   (1.9 MB)
 *      https://www.fhfa.gov/hpi/download/annual/hpi_at_zip5.xlsx   (40 MB; sheet XML 240 MB)
 *    Rows: ZIP, Year, Annual Change (%), HPI (base 100 at first year),
 *          HPI with 1990 base, HPI with 2000 base.
 *    The zip5 workbook is too big for the grid reader (840 MB RSS), so the
 *    sheet entry is inflated as a stream straight from the zip container and
 *    scanned row by row, keeping only the requested ZIP (see readZipXlsxRows).
 */
import { createInflateRaw } from "zlib";
import { politeFetch, redactUrl } from "../data/http";
import { cached, clampInt, HOUR, norm, round, shapeSeries, splitCsv, streamCsvLines, type SeriesPoint } from "./common";

const MASTER_URL = "https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv";
const ZIP3_URL = "https://www.fhfa.gov/hpi/download/annual/hpi_at_zip3.xlsx";
const ZIP5_URL = "https://www.fhfa.gov/hpi/download/annual/hpi_at_zip5.xlsx";

interface Series {
  type: string;
  flavor: string;
  freq: "monthly" | "quarterly";
  level: string;
  place: string;
  placeId: string;
  periods: string[]; // YYYY-MM or YYYYQn
  nsa: number[];
  sa: number[]; // NaN when not published
}

interface Master {
  series: Series[];
  fetchedAt: string;
}

function loadMaster(): Promise<Master> {
  return cached("fhfa:master", 12 * HOUR, async () => {
    const map = new Map<string, Series>();
    let cols: Record<string, number> = {};
    await streamCsvLines(MASTER_URL, (line, i) => {
      if (i === 0) {
        splitCsv(line).forEach((h, j) => (cols[h.trim()] = j));
        return;
      }
      if (!line) return;
      const c = splitCsv(line);
      const type = c[cols.hpi_type!]!;
      const flavor = c[cols.hpi_flavor!]!;
      const freq = c[cols.frequency!] as Series["freq"];
      const level = c[cols.level!]!;
      const place = c[cols.place_name!]!;
      const placeId = c[cols.place_id!]!;
      const key = `${type}|${flavor}|${freq}|${level}|${placeId}`;
      let s = map.get(key);
      if (!s) {
        s = { type, flavor, freq, level, place, placeId, periods: [], nsa: [], sa: [] };
        map.set(key, s);
      }
      const yr = c[cols.yr!]!;
      const per = Number(c[cols.period!]);
      s.periods.push(freq === "monthly" ? `${yr}-${String(per).padStart(2, "0")}` : `${yr}Q${per}`);
      s.nsa.push(Number(c[cols.index_nsa!]));
      const sa = c[cols.index_sa!];
      s.sa.push(sa == null || sa === "" ? NaN : Number(sa));
    });
    if (!map.size) throw new Error("FHFA master CSV parsed to zero rows");
    return { series: [...map.values()], fetchedAt: new Date().toISOString() };
  });
}

const LEVEL_ALIASES: Record<string, string> = {
  usa: "USA or Census Division",
  us: "USA or Census Division",
  national: "USA or Census Division",
  division: "USA or Census Division",
  "census division": "USA or Census Division",
  state: "State",
  msa: "MSA",
  metro: "MSA",
  cbsa: "MSA",
  "puerto rico": "Puerto Rico",
  pr: "Puerto Rico",
};

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

export interface FhfaArgs {
  level?: string;
  place?: string;
  flavor?: string;
  frequency?: string;
  seasonallyAdjusted?: boolean;
  periods?: number;
  limit?: number;
  listPlaces?: boolean;
}

function scorePlace(s: Series, q: string): number {
  if (!q) return s.level === "USA or Census Division" && /^united states$/i.test(s.place) ? 100 : 0;
  const n = norm(s.place);
  const qq = norm(q);
  if (s.placeId.toLowerCase() === qq || s.placeId.toLowerCase() === qq.replace(/\s/g, "")) return 100;
  if (n === qq) return 100;
  if (s.level === "State" && STATE_NAMES[q.toUpperCase().trim()] && norm(STATE_NAMES[q.toUpperCase().trim()]!) === n) return 100;
  if (s.level === "MSA") {
    const city = n.split(" ")[0];
    const stripped = n.replace(/\(msad?\)/g, "").trim();
    if (stripped === qq) return 95;
    if (n.startsWith(qq)) return 90;
    if (qq.split(" ").length === 1 && city === qq) return 80;
    if (n.includes(qq)) return 60;
    return 0;
  }
  if (n.startsWith(qq)) return 80;
  if (n.includes(qq)) return 50;
  return 0;
}

export async function fhfaHpi(args: FhfaArgs) {
  const levelIn = String(args.level ?? "").toLowerCase().trim();
  const placeIn = String(args.place ?? "").trim();
  if (/^zip/.test(levelIn) || (!levelIn && /^\d{5}$/.test(placeIn))) return fhfaZip(args);

  const master = await loadMaster();
  const level = levelIn ? LEVEL_ALIASES[levelIn] ?? (levelIn === "all" ? "" : null) : placeIn ? "" : "USA or Census Division";
  if (level === null) throw new Error(`Unknown level '${args.level}'. Use USA | division | state | msa | zip5 | zip3.`);
  const flavorIn = String(args.flavor ?? "").toLowerCase().trim();
  const freqIn = String(args.frequency ?? "").toLowerCase().trim();

  if (args.listPlaces) {
    const places = new Map<string, { place: string; placeId: string; level: string; series: Set<string> }>();
    for (const s of master.series) {
      if (level && s.level !== level) continue;
      if (placeIn && scorePlace(s, placeIn) === 0) continue;
      const k = `${s.level}|${s.placeId}`;
      const e = places.get(k) ?? { place: s.place, placeId: s.placeId, level: s.level, series: new Set<string>() };
      e.series.add(`${s.flavor}/${s.freq}`);
      places.set(k, e);
    }
    const rows = [...places.values()].slice(0, clampInt(args.limit, 50, 1, 500));
    return { source: "FHFA HPI master file", fetchedAt: master.fetchedAt, count: places.size, places: rows.map((r) => ({ ...r, series: [...r.series].sort() })) };
  }

  // Candidate series for the place
  let cands = master.series.filter((s) => (!level || s.level === level) && s.type === "traditional");
  const scored = cands.map((s) => ({ s, score: scorePlace(s, placeIn) })).filter((x) => x.score > 0);
  if (!scored.length) {
    throw new Error(`No FHFA series matched place '${placeIn}' at level '${level || "any"}'. Try listPlaces:true with a shorter name, a state code (IL), or a CBSA code (16984 = Chicago-Naperville-Schaumburg MSAD).`);
  }
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best).map((x) => x.s);
  const placeIds = [...new Set(top.map((s) => `${s.level}|${s.placeId}`))].slice(0, clampInt(args.limit, 3, 1, 10));

  const nPer = clampInt(args.periods, 24, 0, 240);
  const sa = args.seasonallyAdjusted !== false;
  const results = placeIds.map((pid) => {
    const [lvl, id] = pid.split("|");
    const mine = top.filter((s) => s.level === lvl && s.placeId === id);
    // choose flavor/frequency: explicit > purchase-only monthly (national) > purchase-only quarterly > all-transactions > expanded
    const prefFlavor = flavorIn || (mine.some((s) => s.flavor === "purchase-only") ? "purchase-only" : mine.some((s) => s.flavor === "all-transactions") ? "all-transactions" : "expanded-data");
    const withFlavor = mine.filter((s) => s.flavor.startsWith(prefFlavor.replace(/_/g, "-")));
    const pool = withFlavor.length ? withFlavor : mine;
    const prefFreq = freqIn || (pool.some((s) => s.freq === "monthly") ? "monthly" : "quarterly");
    const chosen = pool.find((s) => s.freq === prefFreq) ?? pool[0]!;
    const useSa = sa && chosen.sa.some((v) => !Number.isNaN(v));
    const pts: SeriesPoint[] = chosen.periods.map((p, i) => ({ date: p, value: useSa ? chosen.sa[i]! : chosen.nsa[i]! })).filter((p) => Number.isFinite(p.value));
    const ppy = chosen.freq === "monthly" ? 12 : 4;
    const shape = shapeSeries(pts, { periodsPerYear: ppy, recent: nPer, dp: 2 });
    return {
      place: chosen.place,
      placeId: chosen.placeId,
      level: chosen.level,
      flavor: chosen.flavor,
      frequency: chosen.freq,
      adjustment: useSa ? "SA" : "NSA",
      available: mine.map((s) => `${s.flavor}/${s.freq}${s.sa.some((v) => !Number.isNaN(v)) ? " (SA+NSA)" : " (NSA)"}`).filter((v, i, a) => a.indexOf(v) === i),
      latest: shape.latest,
      yoy: shape.change[ppy === 12 ? "12m" : "1y"] ?? null,
      change: shape.change,
      cagr: shape.cagr,
      peak: shape.peak,
      firstPeriod: shape.firstDate,
      recent: shape.recent,
    };
  });
  return {
    source: "FHFA House Price Index master file (fhfa.gov/hpi/download/monthly/hpi_master.csv), keyless",
    fetchedAt: master.fetchedAt,
    units: "index (purchase-only: Jan-1991=100; all-transactions: 1980Q1=100; expanded-data: 1991Q1=100); change/cagr in percent",
    note: "Purchase-only = repeat-sales on Fannie/Freddie purchase mortgages; all-transactions adds refinance appraisals; expanded-data adds FHA + county-recorder data. Monthly series exist only for USA and the nine Census divisions.",
    results,
  };
}

/* ------------------------------------------------------------------ ZIP ----- */

interface ZipRow {
  zip: string;
  year: number;
  annualChangePct: number | null;
  hpi: number | null;
  hpi1990: number | null;
  hpi2000: number | null;
}

/**
 * Stream rows of a one-sheet .xlsx straight out of the zip container: find the
 * local header for xl/worksheets/sheet1.xml, pipe its deflate payload through
 * zlib.inflateRaw, and regex-scan <row> elements as they arrive. Shared strings
 * (zip codes with leading zeros are stored as strings) come from the small
 * sharedStrings.xml entry, which is read the same way. Peak memory = the
 * compressed workbook + a few KB of XML.
 */
async function readZipXlsxRows(url: string, keep: (zip: string) => boolean, onRow: (r: ZipRow) => void): Promise<void> {
  const res = await politeFetch(url, { timeoutMs: 45000, retries: 1, headers: { Accept: "*/*" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redactUrl(url)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const entries = zipLocalEntries(buf);
  const sst = entries.get("xl/sharedStrings.xml");
  const sheet = entries.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error(`xlsx at ${redactUrl(url)} has no xl/worksheets/sheet1.xml`);
  const strings: string[] = [];
  if (sst) {
    const xml = (await inflateEntry(buf, sst)).toString("utf8");
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      let t = "";
      const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tre.exec(m[1]!))) t += tm[1];
      strings.push(t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    }
  }
  await streamInflate(buf, sheet, (xmlChunk, carry) => {
    // process complete <row>...</row> blocks; return the unconsumed tail
    let text = carry + xmlChunk;
    let pos = 0;
    for (;;) {
      const start = text.indexOf("<row ", pos);
      if (start < 0) break;
      const end = text.indexOf("</row>", start);
      if (end < 0) break;
      const rowXml = text.slice(start, end + 6);
      pos = end + 6;
      const cells: Array<string | number | null> = [];
      const cre = /<c r="([A-Z]+)\d+"(?:[^>]*?t="(\w+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm: RegExpExecArray | null;
      while ((cm = cre.exec(rowXml))) {
        const col = cm[1]!.charCodeAt(0) - 65;
        if (col > 5 || cm[1]!.length > 1) continue;
        const inner = cm[3] ?? "";
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        let val: string | number | null = null;
        if (vm) {
          if (cm[2] === "s") val = strings[Number(vm[1])] ?? null;
          else if (cm[2] === "str" || cm[2] === "inlineStr") val = vm[1]!;
          else val = Number(vm[1]);
        }
        cells[col] = val;
      }
      const zipCell = cells[0];
      const year = cells[1];
      if (zipCell == null || typeof year !== "number" || !(year > 1900)) continue;
      const zip = typeof zipCell === "number" ? String(zipCell).padStart(url === ZIP3_URL ? 3 : 5, "0") : String(zipCell).trim();
      if (!keep(zip)) continue;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      onRow({ zip, year, annualChangePct: num(cells[2]), hpi: num(cells[3]), hpi1990: num(cells[4]), hpi2000: num(cells[5]) });
    }
    return text.slice(pos);
  });
}

interface LocalEntry {
  dataStart: number;
  compSize: number;
  method: number;
}

/** Parse the central directory for entry offsets/sizes, then resolve local header data offsets. */
function zipLocalEntries(buf: Buffer): Map<string, LocalEntry> {
  const out = new Map<string, LocalEntry>();
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("xlsx: EOCD not found");
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < cdCount; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    out.set(name, { dataStart: localOff + 30 + lNameLen + lExtraLen, compSize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function inflateEntry(buf: Buffer, e: LocalEntry): Promise<Buffer> {
  const slice = buf.subarray(e.dataStart, e.dataStart + e.compSize);
  if (e.method === 0) return Promise.resolve(Buffer.from(slice));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const z = createInflateRaw();
    z.on("data", (c: Buffer) => chunks.push(c));
    z.on("end", () => resolve(Buffer.concat(chunks)));
    z.on("error", reject);
    z.end(slice);
  });
}

function streamInflate(buf: Buffer, e: LocalEntry, onText: (chunk: string, carry: string) => string): Promise<void> {
  const slice = buf.subarray(e.dataStart, e.dataStart + e.compSize);
  if (e.method === 0) {
    onText(slice.toString("utf8"), "");
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const z = createInflateRaw();
    const dec = new TextDecoder("utf-8");
    let carry = "";
    z.on("data", (c: Buffer) => {
      carry = onText(dec.decode(c, { stream: true }), carry);
      if (carry.length > 4_000_000) carry = carry.slice(-2_000_000); // safety: never grow unbounded
    });
    z.on("end", () => {
      onText(dec.decode(), carry);
      resolve();
    });
    z.on("error", reject);
    // feed in pieces so the event loop can breathe
    const STEP = 1 << 20;
    let off = 0;
    const pump = () => {
      while (off < slice.length) {
        const end = Math.min(off + STEP, slice.length);
        const ok = z.write(slice.subarray(off, end));
        off = end;
        if (!ok) {
          z.once("drain", pump);
          return;
        }
      }
      z.end();
    };
    pump();
  });
}

function loadZip3(): Promise<{ rows: Map<string, ZipRow[]>; fetchedAt: string }> {
  return cached("fhfa:zip3", 24 * HOUR, async () => {
    const rows = new Map<string, ZipRow[]>();
    await readZipXlsxRows(ZIP3_URL, () => true, (r) => {
      const a = rows.get(r.zip) ?? [];
      a.push(r);
      rows.set(r.zip, a);
    });
    if (!rows.size) throw new Error("FHFA zip3 workbook parsed to zero rows");
    return { rows, fetchedAt: new Date().toISOString() };
  });
}

function loadZip5(zip: string): Promise<{ rows: ZipRow[]; fetchedAt: string; ms: number }> {
  return cached(`fhfa:zip5:${zip}`, 24 * HOUR, async () => {
    const t0 = Date.now();
    const rows: ZipRow[] = [];
    await readZipXlsxRows(ZIP5_URL, (z) => z === zip, (r) => rows.push(r));
    return { rows, fetchedAt: new Date().toISOString(), ms: Date.now() - t0 };
  });
}

async function fhfaZip(args: FhfaArgs) {
  const place = String(args.place ?? "").replace(/\D/g, "");
  const want3 = /zip3|3/.test(String(args.level ?? "")) && place.length !== 5;
  const zip = want3 ? place.slice(0, 3) : place.slice(0, 5);
  if (!(zip.length === 3 || zip.length === 5)) throw new Error("For level zip5/zip3 pass place as a 5-digit ZIP (60521) or 3-digit prefix (605).");
  const nPer = clampInt(args.periods, 24, 0, 60);
  let rows: ZipRow[];
  let fetchedAt: string;
  let timing: number | undefined;
  if (zip.length === 3) {
    const z3 = await loadZip3();
    rows = z3.rows.get(zip) ?? [];
    fetchedAt = z3.fetchedAt;
  } else {
    const z5 = await loadZip5(zip);
    rows = z5.rows;
    fetchedAt = z5.fetchedAt;
    timing = z5.ms;
  }
  if (!rows.length) throw new Error(`FHFA publishes no ${zip.length === 3 ? "ZIP3" : "ZIP5"} index for ${zip} (thin GSE-mortgage sample areas are omitted). Try level zip3 with the 3-digit prefix, or the county's MSA.`);
  rows.sort((a, b) => a.year - b.year);
  const pts: SeriesPoint[] = rows.filter((r) => r.hpi != null).map((r) => ({ date: String(r.year), value: r.hpi! }));
  const shape = shapeSeries(pts, { periodsPerYear: 1, recent: nPer, dp: 2 });
  const last = rows[rows.length - 1]!;
  return {
    source: `FHFA experimental annual HPI by ${zip.length === 3 ? "three" : "five"}-digit ZIP (all-transactions, NSA; fhfa.gov/hpi/download/annual/hpi_at_zip${zip.length}.xlsx), keyless`,
    fetchedAt,
    zip,
    level: zip.length === 3 ? "zip3" : "zip5",
    units: "index, base 100 at first year recorded; rebased 1990=100 and 2000=100 where available; changes in percent",
    latest: { year: last.year, hpi: round(last.hpi, 2), hpi1990base: round(last.hpi1990, 2), hpi2000base: round(last.hpi2000, 2), annualChangePct: round(last.annualChangePct, 2) },
    yoy: shape.change["1y"] ?? null,
    change: shape.change,
    cagr: shape.cagr,
    peak: shape.peak,
    firstYear: shape.firstDate,
    recent: rows.slice(-nPer).map((r) => [r.year, round(r.hpi, 2), round(r.annualChangePct, 2)]),
    recentColumns: ["year", "hpi", "annualChangePct"],
    ...(timing != null ? { streamed: { fileMB: 40, ms: timing } } : {}),
    note: "Annual, released each March for the prior year. Developmental series calibrated on Fannie/Freddie appraisals + sales; small-sample years are blank.",
  };
}
