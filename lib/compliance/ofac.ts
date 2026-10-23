/**
 * OFAC SDN + Consolidated (non-SDN) list screening.
 *
 * Source: OFAC Sanctions List Service (SLS) legacy CSV exports — the same
 * files treasury.gov/ofac/downloads/*.csv serves, but ~1.4 s instead of ~10 s
 * from this network because the SLS 302s to a presigned S3 object:
 *   https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV      (~5.7 MB, ~19.5k rows)
 *   .../ADD.CSV (addresses, ~1.7 MB)   .../ALT.CSV (aliases, ~1.1 MB)
 *   .../CONS_PRIM.CSV  .../CONS_ADD.CSV  .../CONS_ALT.CSV   (Consolidated = SSI, NS-MBS, CMIC, CAPTA, FSE, NS-PLC; ~0.4 MB total)
 * No header rows; "-0- " means null. SDN.CSV columns:
 *   ent_num, name, type(individual|entity|vessel|aircraft|-0-), programs ("A] [B" separated), title, call_sign,
 *   vess_type, tonnage, grt, vess_flag, vess_owner, remarks
 * ADD.CSV: ent_num, add_num, address, city_state_zip, country, remarks
 * ALT.CSV: ent_num, alt_num, alt_type(aka|fka|nka), alt_name, remarks
 * Publication metadata: https://sanctionslistservice.ofac.treas.gov/changes/history/{YYYY}/{M} (JSON).
 *
 * Verified 2026-10-22: sanctionssearch.ofac.treas.gov (the web "Sanctions List
 * Search") is an ASP.NET WebForms app with __VIEWSTATE and no JSON API; the
 * SLS /entities endpoint is XML-only and returns the whole list (~110 MB) with
 * no name filter, so screening is done locally against the cached CSVs.
 */
import { cached, clampInt, fetchTextMeta, HOUR, nameScore, parseCsv, prepareName, str, type Prepared } from "./common";
import { jsonFetch } from "../data/http";

const SLS = "https://sanctionslistservice.ofac.treas.gov";
const EXPORTS = `${SLS}/api/PublicationPreview/exports`;
const TTL = 12 * HOUR;

export type OfacList = "SDN" | "CONSOLIDATED" | "SDN+CONSOLIDATED";

export interface OfacEntity {
  uid: number;
  list: OfacList;
  name: string;
  type: string; // individual | entity | vessel | aircraft
  programs: string[];
  title: string | null;
  remarks: string | null;
  vessel: { callSign?: string; type?: string; tonnage?: string; grt?: string; flag?: string; owner?: string } | null;
  aliases: Array<{ type: string; name: string }>;
  addresses: Array<{ address: string | null; cityStateZip: string | null; country: string | null }>;
  /** prepared names for matching (primary + aliases) */
  _names: Prepared[];
  _namesLoose: Prepared[];
}

export interface OfacDataset {
  entities: OfacEntity[];
  byUid: Map<number, OfacEntity>;
  fetchedAt: string;
  lastModified: { sdn: string | null; consolidated: string | null };
}

const nul = (v: string | undefined): string | null => {
  const s = str(v);
  return !s || s === "-0-" ? null : s;
};

function parsePrimary(text: string, list: OfacList): OfacEntity[] {
  const out: OfacEntity[] = [];
  for (const r of parseCsv(text)) {
    if (r.length < 4) continue;
    const uid = Number(r[0]);
    if (!Number.isFinite(uid)) continue;
    const name = nul(r[1]) ?? "";
    const type = nul(r[2]) ?? "entity"; // blank type = entity in OFAC's legacy CSV
    const programs = (nul(r[3]) ?? "")
      .split(/\]\s*\[/)
      .map((p) => p.replace(/[\[\]]/g, "").trim())
      .filter(Boolean);
    const vessel =
      type === "vessel" || type === "aircraft"
        ? {
            callSign: nul(r[5]) ?? undefined,
            type: nul(r[6]) ?? undefined,
            tonnage: nul(r[7]) ?? undefined,
            grt: nul(r[8]) ?? undefined,
            flag: nul(r[9]) ?? undefined,
            owner: nul(r[10]) ?? undefined,
          }
        : null;
    out.push({
      uid,
      list,
      name,
      type,
      programs,
      title: nul(r[4]),
      remarks: nul(r[11]),
      vessel,
      aliases: [],
      addresses: [],
      _names: [],
      _namesLoose: [],
    });
  }
  return out;
}

function attachAliases(text: string, byUid: Map<number, OfacEntity>): void {
  for (const r of parseCsv(text)) {
    const e = byUid.get(Number(r[0]));
    const name = nul(r[3]);
    if (!e || !name) continue;
    e.aliases.push({ type: nul(r[2]) ?? "aka", name });
  }
}

function attachAddresses(text: string, byUid: Map<number, OfacEntity>): void {
  for (const r of parseCsv(text)) {
    const e = byUid.get(Number(r[0]));
    if (!e) continue;
    e.addresses.push({ address: nul(r[2]), cityStateZip: nul(r[3]), country: nul(r[4]) });
  }
}

export function loadOfac(): Promise<OfacDataset> {
  return cached("ofac:dataset", TTL, async () => {
    const files = ["SDN.CSV", "ADD.CSV", "ALT.CSV", "CONS_PRIM.CSV", "CONS_ADD.CSV", "CONS_ALT.CSV"];
    const [sdn, add, alt, cPrim, cAdd, cAlt] = await Promise.all(files.map((f) => fetchTextMeta(`${EXPORTS}/${f}`, { timeoutMs: 40000 })));
    const sdnEntities = parsePrimary(sdn!.text, "SDN");
    const consEntities = parsePrimary(cPrim!.text, "CONSOLIDATED");
    if (sdnEntities.length < 1000) throw new Error(`OFAC SDN.CSV parsed only ${sdnEntities.length} rows — upstream format may have changed`);
    const sdnByUid = new Map<number, OfacEntity>();
    for (const e of sdnEntities) sdnByUid.set(e.uid, e);
    const consByUid = new Map<number, OfacEntity>();
    for (const e of consEntities) consByUid.set(e.uid, e);
    attachAliases(alt!.text, sdnByUid);
    attachAddresses(add!.text, sdnByUid);
    attachAliases(cAlt!.text, consByUid);
    attachAddresses(cAdd!.text, consByUid);
    // The same ent_num can sit on both lists (e.g. Rosneft: SSI Directive 2 + SDN under EO 14024) — merge into one record.
    const entities: OfacEntity[] = [...sdnEntities];
    const byUid = new Map<number, OfacEntity>(sdnByUid);
    for (const c of consEntities) {
      const s = byUid.get(c.uid);
      if (!s) {
        entities.push(c);
        byUid.set(c.uid, c);
        continue;
      }
      s.list = "SDN+CONSOLIDATED";
      for (const p of c.programs) if (!s.programs.includes(p)) s.programs.push(p);
      const seenAlias = new Set(s.aliases.map((a) => a.name.toLowerCase()));
      for (const a of c.aliases) if (!seenAlias.has(a.name.toLowerCase())) s.aliases.push(a);
      const seenAddr = new Set(s.addresses.map((a) => `${a.address}|${a.cityStateZip}|${a.country}`));
      for (const a of c.addresses) if (!seenAddr.has(`${a.address}|${a.cityStateZip}|${a.country}`)) s.addresses.push(a);
      if (c.remarks && c.remarks !== s.remarks) s.remarks = s.remarks ? `${s.remarks} | Consolidated: ${c.remarks}` : c.remarks;
    }
    for (const e of entities) {
      const names = [e.name, ...e.aliases.map((a) => a.name)];
      e._names = names.map((n) => prepareName(n, true));
      e._namesLoose = names.map((n) => prepareName(n, false));
    }
    return {
      entities,
      byUid,
      fetchedAt: new Date().toISOString(),
      lastModified: { sdn: sdn!.lastModified, consolidated: cPrim!.lastModified },
    };
  });
}

interface Publication {
  publicationID: number;
  datePublished: string;
}

/** Latest SLS publication (this month, else previous month). Cheap JSON; failures are swallowed. */
export function latestPublication(): Promise<Publication | null> {
  return cached("ofac:publication", 6 * HOUR, async () => {
    const now = new Date();
    for (let back = 0; back < 3; back++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      try {
        const rows = await jsonFetch<Publication[]>(`${SLS}/changes/history/${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`, { timeoutMs: 10000, retries: 1 });
        if (Array.isArray(rows) && rows.length) {
          return rows.slice().sort((a, b) => (a.datePublished < b.datePublished ? 1 : -1))[0]!;
        }
      } catch {
        /* fall through */
      }
    }
    return null;
  });
}

function compact(e: OfacEntity, full: boolean) {
  const base: Record<string, unknown> = {
    uid: e.uid,
    list: e.list,
    name: e.name,
    type: e.type,
    programs: e.programs,
  };
  if (e.title) base.title = e.title;
  if (e.type === "individual") {
    const dob = e.remarks?.match(/DOB ([^;]+)/i)?.[1]?.trim();
    const pob = e.remarks?.match(/POB ([^;]+)/i)?.[1]?.trim();
    const nat = e.remarks?.match(/nationality ([^;]+)/i)?.[1]?.trim();
    if (dob) base.dob = dob;
    if (pob) base.pob = pob;
    if (nat) base.nationality = nat;
  }
  if (e.vessel) base.vessel = e.vessel;
  const aliases = e.aliases.map((a) => (a.type === "aka" ? a.name : `${a.name} (${a.type})`));
  base.aliases = full ? aliases : aliases.slice(0, 6);
  if (!full && e.aliases.length > 6) base.aliasCount = e.aliases.length;
  const addrs = e.addresses.map((a) => [a.address, a.cityStateZip, a.country].filter(Boolean).join(", "));
  base.addresses = full ? addrs : addrs.slice(0, 3);
  if (!full && e.addresses.length > 3) base.addressCount = e.addresses.length;
  if (e.remarks) base.remarks = full ? e.remarks : e.remarks.length > 220 ? e.remarks.slice(0, 220) + "…" : e.remarks;
  return base;
}

export async function ofacSdnSearch(args: any) {
  const name = str(args?.name);
  const uid = Number(args?.uid);
  if (!name && !Number.isFinite(uid)) throw new Error("ofac_sdn_search: pass `name` (person/entity/vessel) or `uid` (OFAC ent_num)");
  const ds = await loadOfac();
  const pub = await latestPublication();
  const meta = {
    source: "OFAC Sanctions List Service CSV exports (SDN + Consolidated non-SDN)",
    listPublished: pub?.datePublished ?? null,
    fileLastModified: ds.lastModified,
    fetchedAt: ds.fetchedAt,
  };

  if (Number.isFinite(uid) && uid > 0) {
    const e = ds.byUid.get(uid);
    if (!e) throw new Error(`OFAC uid ${uid} not found on the SDN or Consolidated lists`);
    return { ...meta, entity: compact(e, true) };
  }

  const type = str(args?.type).toLowerCase();
  const program = str(args?.program).toUpperCase();
  const list = str(args?.list).toUpperCase();
  const minScore = clampInt(args?.minScore, 80, 1, 100);
  const limit = clampInt(args?.limit, 10, 1, 25);
  const country = str(args?.country).toLowerCase();

  const q = prepareName(name, true);
  const qLoose = prepareName(name, false);
  const scored: Array<{ e: OfacEntity; score: number; matchedName: string }> = [];
  for (const e of ds.entities) {
    if (type && e.type !== type) continue;
    if (list && !e.list.includes(list === "CONS" || list === "NON-SDN" ? "CONSOLIDATED" : list)) continue;
    if (program && !e.programs.some((p) => p.toUpperCase().includes(program))) continue;
    if (country && !e.addresses.some((a) => (a.country ?? "").toLowerCase().includes(country))) continue;
    let best = 0;
    let bestIdx = 0;
    for (let i = 0; i < e._names.length; i++) {
      const s = Math.max(nameScore(q, e._names[i]!), nameScore(qLoose, e._namesLoose[i]!));
      if (s > best) {
        best = s;
        bestIdx = i;
      }
      if (best >= 100) break;
    }
    if (best >= minScore) {
      scored.push({ e, score: best, matchedName: bestIdx === 0 ? e.name : e.aliases[bestIdx - 1]!.name });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  const top = scored.slice(0, limit);
  return {
    ...meta,
    query: { name, type: type || null, program: program || null, list: list || "SDN+CONSOLIDATED", minScore },
    screened: ds.entities.length,
    matchCount: scored.length,
    verdict: scored.length ? (scored[0]!.score >= 95 ? "POTENTIAL_MATCH" : "POSSIBLE_MATCH_REVIEW") : "NO_MATCH",
    matches: top.map((m) => ({ score: m.score, matchedName: m.matchedName === m.e.name ? undefined : m.matchedName, ...compact(m.e, false) })),
    note: "Name screening only — confirm with DOB/nationality/address before escalating. Fetch a full record with `uid`.",
  };
}

export async function ofacSdnStatus(args: any) {
  const ds = await loadOfac();
  const pub = await latestPublication();
  const topPrograms = clampInt(args?.topPrograms, 25, 1, 200);
  const count = (pred: (e: OfacEntity) => boolean) => ds.entities.reduce((n, e) => n + (pred(e) ? 1 : 0), 0);
  const byProgram = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const e of ds.entities) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    for (const p of e.programs) byProgram.set(p, (byProgram.get(p) ?? 0) + 1);
  }
  const progs = [...byProgram.entries()].sort((a, b) => b[1] - a[1]);
  return {
    source: "OFAC Sanctions List Service CSV exports",
    listPublished: pub?.datePublished ?? null,
    publicationId: pub?.publicationID ?? null,
    fileLastModified: ds.lastModified,
    fetchedAt: ds.fetchedAt,
    cacheTtlHours: TTL / HOUR,
    totals: {
      entries: ds.entities.length,
      sdn: count((e) => e.list.includes("SDN")),
      consolidated: count((e) => e.list.includes("CONSOLIDATED")),
      onBothLists: count((e) => e.list === "SDN+CONSOLIDATED"),
      aliases: ds.entities.reduce((n, e) => n + e.aliases.length, 0),
      addresses: ds.entities.reduce((n, e) => n + e.addresses.length, 0),
    },
    byType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
    programCount: progs.length,
    byProgram: Object.fromEntries(progs.slice(0, topPrograms)),
  };
}
