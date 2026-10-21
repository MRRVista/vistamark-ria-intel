/**
 * Minimal read-only parser for legacy Excel 97-2003 .xls (BIFF8 inside an
 * OLE2 compound file). No dependency available in the repo reads BIFF, and two
 * upstreams publish ONLY .xls: Shiller's ie_data.xls (CAPE) and Damodaran's
 * per-industry datasets (wacc.xls, betas.xls, ...). This decodes cell VALUES
 * only — numbers (NUMBER/RK/MULRK), strings (SST/LABELSST/LABEL), and the
 * cached results of formulas (FORMULA + STRING) — which is all those files need.
 * Formatting, merged cells, and formulas themselves are ignored.
 *
 * Returns sheet name -> dense grid (row-major, sparse cells = null).
 */

export type XlsCell = string | number | boolean | null;
export type XlsWorkbook = Map<string, XlsCell[][]>;

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

// ---------------------------------------------------------------------------
// OLE2 / Compound File Binary
// ---------------------------------------------------------------------------

function readCfbStream(buf: Buffer, wanted: string[]): Buffer {
  const sig = buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1;
  if (!sig) throw new Error("xls: not an OLE2 compound file (may be HTML or xlsx)");
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buf.readUInt16LE(0x20);
  const numFatSectors = buf.readUInt32LE(0x2c);
  const firstDirSector = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  const firstDifat = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);

  const sectorOffset = (s: number) => (s + 1) * sectorSize;

  // DIFAT: 109 entries in header + chained DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s !== FREESECT) fatSectors.push(s);
  }
  let dif = firstDifat;
  for (let k = 0; k < numDifat && dif !== ENDOFCHAIN && dif !== FREESECT; k++) {
    const off = sectorOffset(dif);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFatSectors; i++) {
      const s = buf.readUInt32LE(off + i * 4);
      if (s !== FREESECT) fatSectors.push(s);
    }
    dif = buf.readUInt32LE(off + per * 4);
  }

  const fat: number[] = [];
  for (const s of fatSectors) {
    const off = sectorOffset(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(buf.readUInt32LE(off + i * 4));
  }

  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    let s = start;
    const guard = table.length + 1;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < table.length && out.length < guard) {
      out.push(s);
      s = table[s]!;
    }
    return out;
  };

  const readChain = (start: number, size?: number): Buffer => {
    const parts = chain(start, fat).map((s) => buf.subarray(sectorOffset(s), sectorOffset(s) + sectorSize));
    const all = Buffer.concat(parts);
    return size != null ? all.subarray(0, size) : all;
  };

  // Directory
  const dir = readChain(firstDirSector);
  interface Entry { name: string; type: number; start: number; size: number }
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 0x40);
    const name = nameLen > 2 ? dir.toString("utf16le", off, off + nameLen - 2) : "";
    entries.push({
      name,
      type: dir[off + 0x42]!,
      start: dir.readUInt32LE(off + 0x74),
      size: dir.readUInt32LE(off + 0x78),
    });
  }
  const root = entries.find((e) => e.type === 5);
  const target = entries.find((e) => e.type === 2 && wanted.includes(e.name));
  if (!target) throw new Error(`xls: no ${wanted.join("/")} stream in compound file`);

  if (target.size >= miniCutoff || !root) return readChain(target.start, target.size);

  // Small stream lives in the mini stream.
  const miniStream = readChain(root.start, root.size);
  const miniFatBuf = readChain(firstMiniFat);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) miniFat.push(miniFatBuf.readUInt32LE(i));
  const parts = chain(target.start, miniFat).map((s) =>
    miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize)
  );
  return Buffer.concat(parts).subarray(0, target.size);
}

// ---------------------------------------------------------------------------
// BIFF8 records
// ---------------------------------------------------------------------------

interface Rec { type: number; off: number; data: Buffer }

function* records(wb: Buffer): Generator<Rec> {
  let p = 0;
  while (p + 4 <= wb.length) {
    const type = wb.readUInt16LE(p);
    const len = wb.readUInt16LE(p + 2);
    yield { type, off: p, data: wb.subarray(p + 4, p + 4 + len) };
    p += 4 + len;
  }
}

/** Reads across SST + CONTINUE segments; char runs re-read the compression flag at each boundary. */
class SegReader {
  private seg = 0;
  private pos = 0;
  constructor(private segs: Buffer[]) {}
  private ensure() {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg]!.length) {
      this.seg++;
      this.pos = 0;
    }
  }
  atEnd(): boolean {
    this.ensure();
    return this.seg >= this.segs.length;
  }
  u8(): number {
    this.ensure();
    const s = this.segs[this.seg];
    if (!s) throw new Error("xls: SST overrun");
    return s[this.pos++]!;
  }
  u16(): number {
    const a = this.u8();
    return a | (this.u8() << 8);
  }
  u32(): number {
    const a = this.u16();
    return (a | (this.u16() << 16)) >>> 0;
  }
  skip(n: number) {
    for (let i = 0; i < n; i++) this.u8();
  }
  chars(cch: number, highByte: boolean): string {
    let out = "";
    let hb = highByte;
    let remaining = cch;
    while (remaining > 0) {
      this.ensure();
      const s = this.segs[this.seg];
      if (!s) break;
      const avail = s.length - this.pos;
      if (avail <= 0) continue;
      const width = hb ? 2 : 1;
      const take = Math.min(remaining, Math.floor(avail / width));
      if (take > 0) {
        out += hb
          ? s.toString("utf16le", this.pos, this.pos + take * 2)
          : s.toString("latin1", this.pos, this.pos + take);
        this.pos += take * width;
        remaining -= take;
      }
      if (remaining > 0) {
        // Crossed into a CONTINUE record: it starts with a fresh grbit byte.
        this.seg++;
        this.pos = 0;
        if (this.seg >= this.segs.length) break;
        hb = (this.segs[this.seg]![this.pos++]! & 0x01) === 1;
      }
    }
    return out;
  }
}

function readUnicodeString(r: SegReader): string {
  const cch = r.u16();
  const flags = r.u8();
  const high = (flags & 0x01) !== 0;
  const ext = (flags & 0x04) !== 0;
  const rich = (flags & 0x08) !== 0;
  const runs = rich ? r.u16() : 0;
  const extLen = ext ? r.u32() : 0;
  const s = r.chars(cch, high);
  if (runs) r.skip(runs * 4);
  if (extLen) r.skip(extLen);
  return s;
}

/** XLUnicodeString inside a single record buffer (LABEL / STRING / BOUNDSHEET). */
function shortUnicode(b: Buffer, off: number, cchBytes: 1 | 2): string {
  const cch = cchBytes === 2 ? b.readUInt16LE(off) : b[off]!;
  const flags = b[off + cchBytes]!;
  const start = off + cchBytes + 1;
  return flags & 0x01
    ? b.toString("utf16le", start, start + cch * 2)
    : b.toString("latin1", start, start + cch);
}

function rkValue(rk: number): number {
  let v: number;
  if (rk & 0x02) {
    v = rk >> 2;
  } else {
    const tmp = Buffer.alloc(8);
    tmp.writeUInt32LE(0, 0);
    tmp.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = tmp.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

/**
 * Parse an .xls buffer. `onlySheets` (case-insensitive names) skips cell decode
 * for other sheets to save time on large workbooks.
 */
export function parseXls(buf: Buffer, onlySheets?: string[]): XlsWorkbook {
  const wb = readCfbStream(buf, ["Workbook", "Book"]);
  const sst: string[] = [];
  const sheetByOffset = new Map<number, string>();
  const want = onlySheets?.map((s) => s.toLowerCase());
  const out: XlsWorkbook = new Map();

  // Pass 1: globals (BOUNDSHEET + SST with CONTINUE)
  const recs = Array.from(records(wb));
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    if (r.type === 0x002f) throw new Error("xls: workbook is encrypted (FILEPASS)");
    if (r.type === 0x0085) {
      const pos = r.data.readUInt32LE(0);
      const name = shortUnicode(r.data, 6, 1);
      sheetByOffset.set(pos, name);
    } else if (r.type === 0x00fc) {
      const segs = [r.data.subarray(8)];
      const total = r.data.readUInt32LE(4);
      let j = i + 1;
      while (j < recs.length && recs[j]!.type === 0x003c) segs.push(recs[j++]!.data);
      const reader = new SegReader(segs);
      for (let k = 0; k < total && !reader.atEnd(); k++) sst.push(readUnicodeString(reader));
    }
  }

  // Pass 2: sheet substreams
  let current: XlsCell[][] | null = null;
  let depth = 0;
  let pendingString: { row: number; col: number } | null = null;
  const set = (row: number, col: number, v: XlsCell) => {
    if (!current) return;
    while (current.length <= row) current.push([]);
    const line = current[row]!;
    while (line.length < col) line.push(null);
    line[col] = v;
  };

  for (const r of recs) {
    const d = r.data;
    switch (r.type) {
      case 0x0809: {
        // BOF
        depth++;
        if (depth === 1) {
          const name = sheetByOffset.get(r.off);
          if (name != null && (!want || want.includes(name.toLowerCase()))) {
            current = [];
            out.set(name, current);
          } else {
            current = null;
          }
        }
        break;
      }
      case 0x000a: // EOF
        depth = Math.max(0, depth - 1);
        if (depth === 0) current = null;
        break;
      default:
        if (!current || depth !== 1) break;
        switch (r.type) {
          case 0x00fd: // LABELSST
            set(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? "");
            break;
          case 0x0203: // NUMBER
            set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
            break;
          case 0x027e: // RK
            set(d.readUInt16LE(0), d.readUInt16LE(2), rkValue(d.readUInt32LE(6)));
            break;
          case 0x00bd: {
            // MULRK
            const row = d.readUInt16LE(0);
            const first = d.readUInt16LE(2);
            const n = (d.length - 6) / 6;
            for (let k = 0; k < n; k++) set(row, first + k, rkValue(d.readUInt32LE(4 + k * 6 + 2)));
            break;
          }
          case 0x0204: // LABEL
            set(d.readUInt16LE(0), d.readUInt16LE(2), shortUnicode(d, 6, 2));
            break;
          case 0x0205: {
            // BOOLERR
            const isErr = d[7] === 1;
            set(d.readUInt16LE(0), d.readUInt16LE(2), isErr ? null : d[6] === 1);
            break;
          }
          case 0x0006: {
            // FORMULA — cached result
            const row = d.readUInt16LE(0);
            const col = d.readUInt16LE(2);
            if (d.readUInt16LE(12) === 0xffff) {
              const kind = d[6];
              if (kind === 0) pendingString = { row, col };
              else if (kind === 1) set(row, col, d[8] === 1);
              else set(row, col, kind === 3 ? "" : null);
            } else {
              set(row, col, d.readDoubleLE(6));
            }
            break;
          }
          case 0x0207: // STRING (result of preceding string FORMULA)
            if (pendingString) {
              set(pendingString.row, pendingString.col, shortUnicode(d, 0, 2));
              pendingString = null;
            }
            break;
        }
    }
  }
  return out;
}
