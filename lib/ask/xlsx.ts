/**
 * Minimal .xlsx writer for Ask Randall's export_excel tool.
 *
 * Built on adm-zip, which the repo already carries for the prospects XLSX
 * reader (lib/prospects/tabular.ts), so no new dependency enters a Vercel
 * bundle for the sake of a spreadsheet. Writes a real OOXML package — bold
 * frozen header row with autofilter, column widths fitted to content, typed
 * numeric cells with number formats — rather than a CSV with an .xlsx name,
 * because the file is going to be opened in Excel by a human and sorted.
 *
 * Strings are written inline (t="inlineStr"); a shared-strings table buys
 * nothing at the row counts a chat answer produces and doubles the code.
 */

import AdmZip from "adm-zip";

export type CellFormat = "text" | "number" | "integer" | "currency" | "percent" | "date";

export interface SheetSpec {
  name: string;
  columns: { name: string; format?: CellFormat }[];
  rows: unknown[][];
}

export interface WorkbookSpec {
  sheets: SheetSpec[];
}

export const MAX_ROWS_TOTAL = 20000;
export const MAX_COLS = 60;
export const MAX_SHEETS = 12;

const STYLE_INDEX: Record<CellFormat, number> = {
  text: 0,
  number: 2,
  integer: 3,
  currency: 4,
  percent: 5,
  date: 6,
};
const HEADER_STYLE = 1;

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Excel rejects control characters other than tab/newline/CR
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function colLetter(i: number): string {
  let n = i + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function sheetName(raw: string, used: Set<string>): string {
  let s = (raw || "Sheet").replace(/[\\/*?:\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
  let base = s, k = 2;
  while (used.has(s.toLowerCase())) s = `${base.slice(0, 28)} ${k++}`;
  used.add(s.toLowerCase());
  return s;
}

/** Excel serial date for an ISO date / datetime string, or null when not parseable. */
function excelSerial(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const ms = Date.parse(v.length === 10 ? v + "T00:00:00Z" : v);
  if (!Number.isFinite(ms)) return null;
  return ms / 86400000 + 25569;
}

function cellXml(ref: string, v: unknown, fmt: CellFormat | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const styleAttr = fmt && fmt !== "text" ? ` s="${STYLE_INDEX[fmt]}"` : "";
  if (typeof v === "boolean") return `<c r="${ref}" t="b"${styleAttr}><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(String(v))}</t></is></c>`;
    return `<c r="${ref}"${styleAttr}><v>${v}</v></c>`;
  }
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (fmt === "date") {
    const serial = excelSerial(s);
    if (serial !== null) return `<c r="${ref}" s="${STYLE_INDEX.date}"><v>${serial}</v></c>`;
  }
  if (fmt && fmt !== "text" && fmt !== "date") {
    // A numeric column handed a numeric-looking string ("$1,234", "12.5%") still gets a number cell.
    const cleaned = s.replace(/[$,%\s]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) {
      const n = Number(cleaned) / (fmt === "percent" && s.trim().endsWith("%") ? 100 : 1);
      return `<c r="${ref}"${styleAttr}><v>${n}</v></c>`;
    }
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(s)}</t></is></c>`;
}

function displayLen(v: unknown, fmt?: CellFormat): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return fmt === "currency" ? String(Math.round(v)).length + 4 : String(v).length + 1;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return Math.min(s.length, 80);
}

function sheetXml(spec: SheetSpec): string {
  const cols = spec.columns.slice(0, MAX_COLS);
  const widths = cols.map((c) => Math.max(8, displayLen(c.name) + 2));
  const rowsXml: string[] = [];
  // header
  rowsXml.push(
    `<row r="1">` +
      cols.map((c, i) => `<c r="${colLetter(i)}1" t="inlineStr" s="${HEADER_STYLE}"><is><t xml:space="preserve">${xmlEsc(c.name)}</t></is></c>`).join("") +
      `</row>`
  );
  spec.rows.forEach((row, r) => {
    const cells: string[] = [];
    for (let i = 0; i < cols.length; i++) {
      const v = Array.isArray(row) ? row[i] : (row as any)?.[cols[i].name];
      const x = cellXml(`${colLetter(i)}${r + 2}`, v, cols[i].format);
      if (x) cells.push(x);
      widths[i] = Math.max(widths[i], Math.min(60, displayLen(v, cols[i].format) + 2));
    }
    rowsXml.push(`<row r="${r + 2}">${cells.join("")}</row>`);
  });
  const lastRef = `${colLetter(Math.max(0, cols.length - 1))}${spec.rows.length + 1}`;
  const colsXml = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastRef}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    colsXml +
    `<sheetData>${rowsXml.join("")}</sheetData>` +
    (cols.length ? `<autoFilter ref="A1:${lastRef}"/>` : "") +
    `</worksheet>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="3">` +
  `<numFmt numFmtId="164" formatCode="#,##0.00"/>` +
  `<numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0;[Red]\\-&quot;$&quot;#,##0"/>` +
  `<numFmt numFmtId="166" formatCode="0.00%"/>` +
  `</numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFEDE4CF"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="7">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` + // 0 text
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` + // 1 header
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 2 number
  `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 3 integer #,##0
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 4 currency
  `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 5 percent
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` + // 6 date
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** Validates and normalises a model-supplied spec; throws a readable message on bad input. */
export function normaliseWorkbook(input: any): WorkbookSpec {
  const sheetsIn: any[] = Array.isArray(input?.sheets) ? input.sheets : [];
  if (!sheetsIn.length) throw new Error("`sheets` must be a non-empty array of {name, columns, rows}");
  if (sheetsIn.length > MAX_SHEETS) throw new Error(`at most ${MAX_SHEETS} sheets`);
  let total = 0;
  const sheets: SheetSpec[] = sheetsIn.map((s, idx) => {
    const cols: any[] = Array.isArray(s?.columns) ? s.columns : [];
    if (!cols.length) throw new Error(`sheet ${idx + 1}: \`columns\` is required`);
    if (cols.length > MAX_COLS) throw new Error(`sheet ${idx + 1}: at most ${MAX_COLS} columns`);
    const columns = cols.map((c) =>
      typeof c === "string"
        ? { name: c }
        : { name: String(c?.name ?? ""), ...(c?.format && c.format in STYLE_INDEX ? { format: c.format as CellFormat } : {}) }
    );
    const rows: unknown[][] = Array.isArray(s?.rows) ? s.rows : [];
    total += rows.length;
    if (total > MAX_ROWS_TOTAL) throw new Error(`workbook exceeds ${MAX_ROWS_TOTAL} rows; narrow the data`);
    return { name: typeof s?.name === "string" ? s.name : `Sheet${idx + 1}`, columns, rows };
  });
  return { sheets };
}

export function buildXlsx(spec: WorkbookSpec): Buffer {
  const zip = new AdmZip();
  const used = new Set<string>();
  const names = spec.sheets.map((s) => sheetName(s.name, used));

  zip.addFile(
    "[Content_Types].xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        spec.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        `</Types>`
    )
  );
  zip.addFile(
    "_rels/.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`
    )
  );
  zip.addFile(
    "xl/workbook.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets>` +
        names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`
    )
  );
  zip.addFile(
    "xl/_rels/workbook.xml.rels",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`
    )
  );
  zip.addFile("xl/styles.xml", Buffer.from(STYLES_XML));
  spec.sheets.forEach((s, i) => zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(s))));
  return zip.toBuffer();
}

export function safeFilename(raw: unknown, fallback = "vistaintel-export"): string {
  let s = typeof raw === "string" ? raw.trim() : "";
  s = s.replace(/\.xlsx$/i, "").replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-. ]+|[-. ]+$/g, "");
  if (!s) s = fallback;
  return s.slice(0, 80) + ".xlsx";
}
