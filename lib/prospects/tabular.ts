/**
 * Tabular readers for prospect imports: CSV / TSV (RFC 4180-ish, handles
 * quoted commas, doubled quotes, CRLF, BOM) and .xlsx (first sheet — or a
 * named one — via the adm-zip + fast-xml-parser dependencies the repo already
 * carries, so no SheetJS).
 *
 * Both return the same shape: `{ headers, rows }` where each row is an object
 * keyed by the ORIGINAL header text. Column mapping is normalize.ts's job.
 */
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

export interface Table {
  headers: string[];
  rows: Array<Record<string, string>>;
  sheet?: string;
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const counts: Array<[string, number]> = [",", "\t", ";", "|"].map((d) => [
    d,
    (firstLine.match(new RegExp(d === "|" ? "\\|" : d, "g")) ?? []).length,
  ]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export function parseDelimited(text: string, delimiter?: string): string[][] {
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const d = delimiter ?? detectDelimiter(s);
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === d) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      out.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    out.push(row);
  }
  // Drop fully blank rows.
  return out.filter((r) => r.some((c) => c.trim() !== ""));
}

export function tableFromGrid(grid: string[][], sheet?: string): Table {
  if (!grid.length) return { headers: [], rows: [], sheet };
  const rawHeaders = grid[0].map((h) => h.trim());
  // De-duplicate blank/duplicate headers so object keys don't collide.
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h, i) => {
    let name = h || `column_${i + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n > 0) name = `${name}_${n + 1}`;
    return name;
  });
  const rows = grid.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (cells[i] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows, sheet };
}

export function parseCsv(text: string, delimiter?: string): Table {
  return tableFromGrid(parseDelimited(text, delimiter));
}

// ---------------------------------------------------------------------------
// XLSX (minimal OOXML reader)
// ---------------------------------------------------------------------------

function colIndex(ref: string): number {
  // "AB12" -> 27
  const letters = ref.replace(/[^A-Z]/gi, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function richText(node: any): string {
  // <si><t>..</t></si>  or  <si><r><t>..</t></r><r><t>..</t></r></si>
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node.t != null) return typeof node.t === "object" ? String(node.t["#text"] ?? "") : String(node.t);
  if (node.r != null) return asArray(node.r).map(richText).join("");
  return "";
}

/** Excel serial date -> YYYY-MM-DD (1900 date system). */
export function excelSerialToIso(n: number): string {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseXlsx(buf: Buffer, sheetName?: string): Table {
  const zip = new AdmZip(buf);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseTagValue: false,
    trimValues: false,
  });
  const read = (name: string) => {
    const e = zip.getEntry(name);
    return e ? parser.parse(e.getData().toString("utf8")) : null;
  };

  // Workbook → sheet list → rels → target part.
  const wb = read("xl/workbook.xml");
  const rels = read("xl/_rels/workbook.xml.rels");
  const sheets = asArray(wb?.workbook?.sheets?.sheet);
  if (!sheets.length) throw new Error("xlsx: workbook has no sheets");
  const chosen =
    (sheetName && sheets.find((s: any) => String(s["@_name"]).toLowerCase() === sheetName.toLowerCase())) ||
    sheets[0];
  const rid = chosen["@_r:id"];
  const rel = asArray(rels?.Relationships?.Relationship).find((r: any) => r["@_Id"] === rid);
  let target: string = rel?.["@_Target"] ?? "worksheets/sheet1.xml";
  target = target.startsWith("/") ? target.slice(1) : `xl/${target}`;

  // Shared strings + which cell styles are date formats.
  const sst = read("xl/sharedStrings.xml");
  const shared: string[] = asArray(sst?.sst?.si).map(richText);
  const styles = read("xl/styles.xml");
  const numFmts = new Map<string, string>();
  for (const f of asArray(styles?.styleSheet?.numFmts?.numFmt) as any[]) numFmts.set(String(f["@_numFmtId"]), String(f["@_formatCode"]));
  const builtinDate = new Set(["14", "15", "16", "17", "22", "27", "30", "36", "45", "46", "47"]);
  const xfs = asArray(styles?.styleSheet?.cellXfs?.xf) as any[];
  const isDateStyle = (styleIdx: number): boolean => {
    const xf = xfs[styleIdx];
    if (!xf) return false;
    const id = String(xf["@_numFmtId"] ?? "0");
    if (builtinDate.has(id)) return true;
    const code = numFmts.get(id);
    return !!code && /[ymd]/i.test(code.replace(/\[[^\]]*]/g, "")) && !/[#0]/.test(code);
  };

  const ws = read(target);
  const rowsXml = asArray(ws?.worksheet?.sheetData?.row) as any[];
  const grid: string[][] = [];
  for (const r of rowsXml) {
    const cells = asArray(r.c) as any[];
    const line: string[] = [];
    for (const c of cells) {
      const ref: string = c["@_r"] ?? "";
      const idx = ref ? colIndex(ref) : line.length;
      const t = c["@_t"];
      let v = "";
      if (t === "s") v = shared[Number(c.v)] ?? "";
      else if (t === "inlineStr") v = richText(c.is);
      else if (t === "b") v = c.v === "1" ? "TRUE" : "FALSE";
      else if (c.v != null) {
        v = typeof c.v === "object" ? String(c.v["#text"] ?? "") : String(c.v);
        const sIdx = Number(c["@_s"] ?? -1);
        if (t !== "str" && sIdx >= 0 && isDateStyle(sIdx) && /^-?\d+(\.\d+)?$/.test(v)) v = excelSerialToIso(Number(v));
      }
      while (line.length < idx) line.push("");
      line[idx] = v;
    }
    grid.push(line);
  }
  const filtered = grid.filter((r) => r.some((c) => c.trim() !== ""));
  return tableFromGrid(filtered, String(chosen["@_name"]));
}

/** Sniff bytes and dispatch. */
export function parseTabular(
  data: Buffer | string,
  hint?: { filename?: string; contentType?: string; sheet?: string; delimiter?: string }
): Table {
  const buf = typeof data === "string" ? null : data;
  const isZip = buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const nameXlsx = hint?.filename?.toLowerCase().endsWith(".xlsx");
  const ctXlsx = hint?.contentType?.includes("spreadsheetml") || hint?.contentType?.includes("openxmlformats");
  if (buf && (isZip || nameXlsx || ctXlsx)) {
    if (!isZip) throw new Error("xlsx: file is not a zip container (legacy .xls is not supported — save as .xlsx or .csv)");
    return parseXlsx(buf, hint?.sheet);
  }
  const text = buf ? buf.toString("utf8") : (data as string);
  return parseCsv(text, hint?.delimiter);
}
