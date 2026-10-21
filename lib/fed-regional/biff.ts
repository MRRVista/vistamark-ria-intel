/**
 * Minimal legacy Excel (.xls, BIFF8 in an OLE2/CFB container) cell reader.
 *
 * Why: the NY Fed publishes the ACM term-premium dataset (and the
 * yield-curve recession-probability file) ONLY as legacy .xls, and the repo
 * has no BIFF parser dependency. This reads just what those files need:
 *   CFB container → "Workbook" stream → BOUNDSHEET list + SST (with CONTINUE)
 *   → per-sheet NUMBER / RK / MULRK / LABELSST / LABEL / FORMULA(numeric) cells.
 * No formatting, no dates-from-styles (the NY Fed files store dates as text).
 * Throws on anything unexpected; callers fall back to a CSV variant.
 */

export type BiffCell = string | number | null;
export type BiffGrid = BiffCell[][];

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function readCfbStream(buf: Buffer, wanted: string[]): Buffer {
  const sig = buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1;
  if (!sig) throw new Error("xls: not an OLE2 compound file");
  const sectorShift = buf.readUInt16LE(0x1e);
  const sectorSize = 1 << sectorShift;
  const numFatSectors = buf.readUInt32LE(0x2c);
  const firstDirSector = buf.readUInt32LE(0x30);
  const firstDifat = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);
  const sectorOffset = (sid: number) => (sid + 1) * sectorSize;

  // DIFAT → list of FAT sector ids.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const sid = buf.readUInt32LE(0x4c + i * 4);
    if (sid !== FREESECT) fatSectors.push(sid);
  }
  let difat = firstDifat;
  for (let n = 0; n < numDifat && difat !== ENDOFCHAIN && difat !== FREESECT; n++) {
    const off = sectorOffset(difat);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFatSectors; i++) {
      const sid = buf.readUInt32LE(off + i * 4);
      if (sid !== FREESECT) fatSectors.push(sid);
    }
    difat = buf.readUInt32LE(off + per * 4);
  }
  const perFat = sectorSize / 4;
  const fat = new Uint32Array(fatSectors.length * perFat);
  fatSectors.forEach((sid, k) => {
    const off = sectorOffset(sid);
    for (let i = 0; i < perFat; i++) fat[k * perFat + i] = buf.readUInt32LE(off + i * 4);
  });

  const readChain = (start: number, size?: number): Buffer => {
    const parts: Buffer[] = [];
    let sid = start;
    let guard = 0;
    while (sid !== ENDOFCHAIN && sid < fat.length && guard++ < fat.length) {
      const off = sectorOffset(sid);
      parts.push(buf.subarray(off, Math.min(off + sectorSize, buf.length)));
      sid = fat[sid];
    }
    const all = Buffer.concat(parts);
    return size != null ? all.subarray(0, size) : all;
  };

  const dir = readChain(firstDirSector);
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    if (nameLen < 2) continue;
    const name = dir.toString("utf16le", off, off + nameLen - 2);
    const type = dir.readUInt8(off + 66);
    if (type !== 2) continue; // stream
    if (!wanted.includes(name)) continue;
    const start = dir.readUInt32LE(off + 116);
    const size = dir.readUInt32LE(off + 120);
    if (size < 4096) throw new Error("xls: workbook stream in mini-stream (unsupported; file too small)");
    return readChain(start, size);
  }
  throw new Error(`xls: no ${wanted.join("/")} stream`);
}

/** Cursor over a record + its CONTINUE segments (needed for the SST). */
class SegCursor {
  seg = 0;
  pos = 0;
  constructor(private segs: Buffer[]) {}
  private ensure() {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg].length) {
      this.seg++;
      this.pos = 0;
    }
    if (this.seg >= this.segs.length) throw new Error("xls: SST overrun");
  }
  u8(): number { this.ensure(); return this.segs[this.seg][this.pos++]; }
  u16(): number { return this.u8() | (this.u8() << 8); }
  u32(): number { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n: number) {
    while (n > 0) {
      this.ensure();
      const take = Math.min(n, this.segs[this.seg].length - this.pos);
      this.pos += take;
      n -= take;
    }
  }
  chars(cch: number, high: boolean): string {
    let out = "";
    let remaining = cch;
    while (remaining > 0) {
      if (this.pos >= (this.segs[this.seg]?.length ?? 0)) {
        // String continues in a CONTINUE record, which starts with a fresh option-flags byte.
        this.seg++;
        this.pos = 0;
        if (this.seg >= this.segs.length) throw new Error("xls: SST string overrun");
        high = (this.segs[this.seg][this.pos++] & 0x01) === 1;
      }
      const b = this.segs[this.seg];
      const width = high ? 2 : 1;
      const n = Math.min(remaining, Math.floor((b.length - this.pos) / width));
      if (n <= 0) { this.pos = b.length; continue; }
      out += high ? b.toString("utf16le", this.pos, this.pos + n * 2) : b.toString("latin1", this.pos, this.pos + n);
      this.pos += n * width;
      remaining -= n;
    }
    return out;
  }
}

function parseSst(segs: Buffer[]): string[] {
  const c = new SegCursor(segs);
  c.u32(); // total
  const unique = c.u32();
  const out: string[] = [];
  for (let i = 0; i < unique; i++) {
    const cch = c.u16();
    const flags = c.u8();
    const high = (flags & 0x01) === 1;
    const rich = (flags & 0x08) !== 0;
    const ext = (flags & 0x04) !== 0;
    const cRun = rich ? c.u16() : 0;
    const cbExt = ext ? c.u32() : 0;
    out.push(c.chars(cch, high));
    if (cRun) c.skip(cRun * 4);
    if (cbExt) c.skip(cbExt);
  }
  return out;
}

function decodeRk(rk: number): number {
  let v: number;
  if (rk & 0x02) {
    v = rk >> 2; // signed 30-bit int
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 0x01 ? v / 100 : v;
}

export interface XlsBook {
  sheetNames: string[];
  sheet(name: string, maxRows?: number): BiffGrid;
}

export function openXls(buf: Buffer): XlsBook {
  const wb = readCfbStream(buf, ["Workbook", "Book"]);
  const sheets: { name: string; offset: number }[] = [];
  let sst: string[] = [];

  // Globals substream.
  let p = 0;
  let sstSegs: Buffer[] | null = null;
  while (p + 4 <= wb.length) {
    const type = wb.readUInt16LE(p);
    const len = wb.readUInt16LE(p + 2);
    const data = wb.subarray(p + 4, p + 4 + len);
    p += 4 + len;
    if (sstSegs && type !== 0x003c) {
      sst = parseSst(sstSegs);
      sstSegs = null;
    }
    if (type === 0x0085) {
      const offset = data.readUInt32LE(0);
      const cch = data.readUInt8(6);
      const high = (data.readUInt8(7) & 1) === 1;
      const name = high ? data.toString("utf16le", 8, 8 + cch * 2) : data.toString("latin1", 8, 8 + cch);
      sheets.push({ name, offset });
    } else if (type === 0x00fc) {
      sstSegs = [data];
    } else if (type === 0x003c && sstSegs) {
      sstSegs.push(data);
    } else if (type === 0x000a) {
      break; // EOF of globals
    }
  }
  if (sstSegs) sst = parseSst(sstSegs);

  return {
    sheetNames: sheets.map((s) => s.name),
    sheet(name: string, maxRows = Infinity): BiffGrid {
      const sh = sheets.find((s) => s.name === name) ?? sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (!sh) throw new Error(`xls: sheet '${name}' not found (have: ${sheets.map((s) => s.name).join(", ")})`);
      const grid: BiffGrid = [];
      const set = (r: number, c: number, v: BiffCell) => {
        if (r >= maxRows) return;
        while (grid.length <= r) grid.push([]);
        const row = grid[r];
        while (row.length < c) row.push(null);
        row[c] = v;
      };
      let q = sh.offset;
      let depth = 0;
      while (q + 4 <= wb.length) {
        const type = wb.readUInt16LE(q);
        const len = wb.readUInt16LE(q + 2);
        const d = wb.subarray(q + 4, q + 4 + len);
        q += 4 + len;
        switch (type) {
          case 0x0809: depth++; break; // BOF (nested for embedded charts)
          case 0x000a: depth--; break;
          case 0x0203: set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6)); break; // NUMBER
          case 0x027e: set(d.readUInt16LE(0), d.readUInt16LE(2), decodeRk(d.readUInt32LE(6))); break; // RK
          case 0x00bd: { // MULRK
            const r = d.readUInt16LE(0);
            const c0 = d.readUInt16LE(2);
            const n = (len - 6) / 6;
            for (let i = 0; i < n; i++) set(r, c0 + i, decodeRk(d.readUInt32LE(4 + i * 6 + 2)));
            break;
          }
          case 0x00fd: set(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? null); break; // LABELSST
          case 0x0204: { // LABEL
            const cch = d.readUInt16LE(6);
            const high = (d.readUInt8(8) & 1) === 1;
            set(d.readUInt16LE(0), d.readUInt16LE(2), high ? d.toString("utf16le", 9, 9 + cch * 2) : d.toString("latin1", 9, 9 + cch));
            break;
          }
          case 0x0006: { // FORMULA — numeric results only
            if (d.readUInt16LE(12) !== 0xffff) set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
            break;
          }
        }
        if (depth <= 0) break;
      }
      return grid;
    },
  };
}
