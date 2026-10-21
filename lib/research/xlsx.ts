/**
 * Read one worksheet of an .xlsx into a raw grid (row-major, cells as
 * string | number | null). Unlike lib/prospects/tabular.ts this keeps the
 * absolute row/column layout, because the research spreadsheets (AQR,
 * Damodaran) carry title blocks, multi-row headers and footnotes around the
 * data and the caller needs to locate the header row itself.
 *
 * Uses a regex scanner over sheet XML rather than a full XML parse: AQR's
 * monthly sheets are 2–5 MB of XML and the scanner is several times faster
 * and allocation-light.
 */
import AdmZip from "adm-zip";

export type Cell = string | number | null;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function textOf(fragment: string): string {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += m[1];
  return decodeXml(out);
}

export interface XlsxSheetList {
  names: string[];
}

export function xlsxSheetNames(buf: Buffer): string[] {
  const zip = new AdmZip(buf);
  const wb = zip.getEntry("xl/workbook.xml")?.getData().toString("utf8") ?? "";
  return Array.from(wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)).map((m) => decodeXml(m[1]!));
}

/**
 * Parse a sheet (by name, case-insensitive; default first sheet) to a grid.
 * `maxRows` stops scanning early (header sniffing).
 */
export function readXlsxGrid(buf: Buffer, sheetName?: string, maxRows?: number): { sheet: string; grid: Cell[][] } {
  const zip = new AdmZip(buf);
  const read = (p: string) => zip.getEntry(p)?.getData().toString("utf8") ?? null;
  const wb = read("xl/workbook.xml");
  if (!wb) throw new Error("xlsx: missing xl/workbook.xml (not an xlsx file?)");
  const sheets = Array.from(wb.matchAll(/<sheet\b([^>]*)\/?>/g)).map((m) => {
    const attrs = m[1]!;
    return {
      name: decodeXml(attrs.match(/\bname="([^"]*)"/)?.[1] ?? ""),
      rid: attrs.match(/\br:id="([^"]*)"/)?.[1] ?? "",
    };
  });
  if (!sheets.length) throw new Error("xlsx: workbook has no sheets");
  const chosen =
    (sheetName && sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase())) || sheets[0]!;
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  let target = "worksheets/sheet1.xml";
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = m[1]!;
    if (a.match(/\bId="([^"]*)"/)?.[1] === chosen.rid) target = a.match(/\bTarget="([^"]*)"/)?.[1] ?? target;
  }
  target = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;

  const sstXml = read("xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sstXml) {
    for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]!));
  }

  const ws = read(target);
  if (!ws) throw new Error(`xlsx: sheet part ${target} missing`);
  const grid: Cell[][] = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;
  let implicitRow = 0;
  while ((rm = rowRe.exec(ws))) {
    const rAttr = rm[1]!.match(/\br="(\d+)"/);
    const rowIdx = rAttr ? Number(rAttr[1]) - 1 : implicitRow;
    implicitRow = rowIdx + 1;
    if (maxRows != null && rowIdx >= maxRows) break;
    const body = rm[2];
    if (!body) continue;
    const line: Cell[] = [];
    let cm: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    let implicitCol = 0;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1]!;
      const inner = cm[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const ci = ref ? colIndex(ref) : implicitCol;
      implicitCol = ci + 1;
      const t = attrs.match(/\bt="([^"]*)"/)?.[1];
      const vRaw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val: Cell = null;
      if (t === "s") val = vRaw != null ? shared[Number(vRaw)] ?? "" : null;
      else if (t === "inlineStr") val = textOf(inner);
      else if (t === "str") val = vRaw != null ? decodeXml(vRaw) : null;
      else if (t === "b") val = vRaw === "1" ? "TRUE" : "FALSE";
      else if (t === "e") val = null;
      else if (vRaw != null) {
        const n = Number(vRaw);
        val = Number.isFinite(n) ? n : decodeXml(vRaw);
      }
      if (val === "") val = null;
      if (val == null) continue;
      while (line.length < ci) line.push(null);
      line[ci] = val;
    }
    while (grid.length < rowIdx) grid.push([]);
    grid[rowIdx] = line;
  }
  return { sheet: chosen.name, grid };
}
