/**
 * Minimal OOXML (.xlsx) grid reader for the Fed Regional family.
 *
 * Unlike lib/prospects/tabular.ts (header-row tables, first sheet), the
 * GDPNow / SPF / Wage Tracker workbooks are report-style layouts, so this
 * returns a raw positional grid per sheet: numbers stay numbers, date-styled
 * numeric cells become 'YYYY-MM-DD' strings, everything else is a string.
 * The zip is opened once and sheets are parsed lazily by name.
 */
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

export type Cell = string | number | null;
export type Grid = Cell[][];

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function colIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function text(node: any): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node["#text"] != null) return String(node["#text"]);
  if (node.t != null) return text(node.t);
  if (node.r != null) return asArray(node.r).map(text).join("");
  return "";
}

export function excelSerialToIso(n: number): string {
  return new Date(Math.round((n - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
}

export interface XlsxBook {
  sheetNames: string[];
  sheet(name: string): Grid;
}

export function openXlsx(buf: Buffer): XlsxBook {
  if (!(buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw new Error("xlsx: payload is not a zip container (upstream may have returned HTML or a legacy .xls)");
  }
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

  const wb = read("xl/workbook.xml");
  const rels = read("xl/_rels/workbook.xml.rels");
  const sheets = asArray<any>(wb?.workbook?.sheets?.sheet);
  const relList = asArray<any>(rels?.Relationships?.Relationship);
  const targetByName = new Map<string, string>();
  for (const s of sheets) {
    const rel = relList.find((r) => r["@_Id"] === s["@_r:id"]);
    let target: string = rel?.["@_Target"] ?? "";
    if (!target) continue;
    target = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    targetByName.set(String(s["@_name"]), target);
  }

  let shared: string[] | null = null;
  let isDateStyle: ((s: number) => boolean) | null = null;
  const init = () => {
    if (shared) return;
    const sst = read("xl/sharedStrings.xml");
    shared = asArray<any>(sst?.sst?.si).map(text);
    const styles = read("xl/styles.xml");
    const numFmts = new Map<string, string>();
    for (const f of asArray<any>(styles?.styleSheet?.numFmts?.numFmt)) numFmts.set(String(f["@_numFmtId"]), String(f["@_formatCode"]));
    const builtin = new Set(["14", "15", "16", "17", "22", "27", "30", "36", "45", "46", "47", "50", "57"]);
    const xfs = asArray<any>(styles?.styleSheet?.cellXfs?.xf);
    const memo = new Map<number, boolean>();
    isDateStyle = (idx: number) => {
      if (memo.has(idx)) return memo.get(idx)!;
      const xf = xfs[idx];
      let r = false;
      if (xf) {
        const id = String(xf["@_numFmtId"] ?? "0");
        if (builtin.has(id)) r = true;
        else {
          const code = (numFmts.get(id) ?? "").replace(/\[[^\]]*]/g, "").replace(/"[^"]*"/g, "");
          r = !!code && /[ymd]/i.test(code) && !/[#0?]/.test(code);
        }
      }
      memo.set(idx, r);
      return r;
    };
  };

  const gridCache = new Map<string, Grid>();
  return {
    sheetNames: sheets.map((s) => String(s["@_name"])),
    sheet(name: string): Grid {
      const hit = gridCache.get(name);
      if (hit) return hit;
      const target =
        targetByName.get(name) ??
        [...targetByName.entries()].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
      if (!target) throw new Error(`xlsx: sheet '${name}' not found (have: ${[...targetByName.keys()].slice(0, 40).join(", ")})`);
      init();
      const ws = read(target);
      const grid: Grid = [];
      for (const r of asArray<any>(ws?.worksheet?.sheetData?.row)) {
        const ri = r["@_r"] != null ? Number(r["@_r"]) - 1 : grid.length;
        const line: Cell[] = [];
        for (const c of asArray<any>(r.c)) {
          const ref: string = c["@_r"] ?? "";
          const ci = ref ? colIndex(ref) : line.length;
          const t = c["@_t"];
          let v: Cell = null;
          const raw = c.v == null ? null : typeof c.v === "object" ? String(c.v["#text"] ?? "") : String(c.v);
          if (t === "s") v = raw == null ? null : shared![Number(raw)] ?? null;
          else if (t === "inlineStr") v = text(c.is);
          else if (t === "str" || t === "e") v = raw;
          else if (t === "b") v = raw === "1" ? "TRUE" : "FALSE";
          else if (raw != null && raw !== "") {
            const n = Number(raw);
            if (Number.isFinite(n)) {
              const sIdx = Number(c["@_s"] ?? -1);
              v = sIdx >= 0 && isDateStyle!(sIdx) ? excelSerialToIso(n) : n;
            } else v = raw;
          }
          while (line.length < ci) line.push(null);
          line[ci] = v;
        }
        while (grid.length < ri) grid.push([]);
        grid[ri] = line;
      }
      gridCache.set(name, grid);
      return grid;
    },
  };
}
