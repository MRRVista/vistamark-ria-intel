/**
 * Tracerfy input-format export (v0.25.2).
 *
 * One row per household in Tracerfy's intake layout (A-F), with every other
 * field VistaIntel holds appended from column G onward so the download doubles
 * as a full data dump. Read-only. The traced / emailed skips exist because a
 * trace costs credits: a household already run through Tracerfy (tagged by
 * enrich-upload when its results were loaded) or already holding an email is
 * left out by default.
 */

import { asc, eq } from "drizzle-orm";
import { db, isDbReady, schema } from "../db";

const { prospects, prospectHouseholds } = schema;

export const TRACERFY_INPUT_HEADER = ["Address", "City", "State", "Zip", "First Name", "Last Name"] as const;

const EXTRA_HEADER = [
  "Home Value", "VistaIntel ID", "Household ID", "Owner Name On Record", "Household Name",
  "Co-Owner 1 First", "Co-Owner 1 Last", "Co-Owner 2 First", "Co-Owner 2 Last",
  "Mail Address", "Mail City", "Mail State", "Mail Zip",
  "Email", "Phone", "Mobile", "Lead Status", "Tags", "Source", "County",
  "Home Value Source", "Owner Occupied", "Traced", "Co-Owner Records",
] as const;

export interface ExportArgs {
  zips?: string[];
  minHomeValue?: number;
  skipTraced?: boolean;
  skipEmailed?: boolean;
  limit?: number;
}

export interface CoOwner { first: string; last: string }

/** Pull the other adults out of a household display name built by parcels.ts. */
export function coOwnersFromHouseholdName(householdName: string | null | undefined, primaryFirst: string | null, primaryLast: string | null): CoOwner[] {
  if (!householdName || !householdName.includes("&")) return [];
  const parts = householdName.split("&").map((p) => p.trim()).filter(Boolean);
  const out: CoOwner[] = [];
  const pf = (primaryFirst ?? "").toLowerCase();
  for (const p of parts) {
    const toks = p.split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    let first = toks[0];
    let last = toks.length >= 2 ? toks[toks.length - 1] : (primaryLast ?? "");
    // "Richard & Maria Loeber": the first part is the primary with no surname.
    if (toks.length === 1 && first.toLowerCase() === pf) continue;
    // "Richard Loeber & Maria": the surname-less part is the spouse.
    if (toks.length >= 2 && toks[0].toLowerCase() === pf && toks[toks.length - 1].toLowerCase() === (primaryLast ?? "").toLowerCase()) continue;
    if (first.toLowerCase() === pf && last.toLowerCase() === (primaryLast ?? "").toLowerCase()) continue;
    out.push({ first, last });
  }
  return out.slice(0, 2);
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function isTraced(tags: string[] | null | undefined): boolean {
  return (tags ?? []).some((t) => t.startsWith("traced:") || t === "enriched:tracerfy");
}

export async function buildTracerfyExport(a: ExportArgs) {
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const zips = a.zips ?? [];
  const minHomeValue = a.minHomeValue ?? 0;
  const skipTraced = a.skipTraced !== false;
  const skipEmailed = a.skipEmailed !== false;

  const rows = await db
    .select({
      id: prospects.id,
      householdId: prospects.householdId,
      firstName: prospects.firstName,
      middleName: prospects.middleName,
      lastName: prospects.lastName,
      fullName: prospects.fullName,
      email: prospects.email,
      phone: prospects.phone,
      phoneMobile: prospects.phoneMobile,
      leadStatus: prospects.leadStatus,
      source: prospects.source,
      doNotContact: prospects.doNotContact,
      pTags: prospects.tags,
      raw: prospects.raw,
      pAddress: prospects.addressLine1,
      pCity: prospects.city,
      pState: prospects.state,
      pZip: prospects.zip5,
      hId: prospectHouseholds.id,
      hAddress: prospectHouseholds.addressLine1,
      hCity: prospectHouseholds.city,
      hState: prospectHouseholds.state,
      hZip: prospectHouseholds.zip5,
      county: prospectHouseholds.county,
      householdName: prospectHouseholds.householdName,
      homeValue: prospectHouseholds.homeValue,
      homeValueSource: prospectHouseholds.homeValueSource,
      ownerOccupied: prospectHouseholds.ownerOccupied,
      hTags: prospectHouseholds.tags,
    })
    .from(prospects)
    .leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id))
    .orderBy(asc(prospects.id));

  type Row = (typeof rows)[number];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const zip = r.hZip ?? r.pZip;
    if (zips.length && !zips.includes(zip)) continue;
    if (minHomeValue > 0 && (r.homeValue ?? 0) < minHomeValue) continue;
    const key = r.householdId != null ? `h${r.householdId}` : `p${r.id}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }

  let skippedTraced = 0, skippedEmailed = 0, skippedDnc = 0;
  const kept: Row[][] = [];
  for (const g of groups.values()) {
    if (g.every((r) => r.doNotContact)) { skippedDnc++; continue; }
    const members = g.filter((r) => !r.doNotContact);
    const traced = members.some((r) => isTraced(r.pTags)) || isTraced(members[0].hTags);
    if (skipTraced && traced) { skippedTraced++; continue; }
    if (skipEmailed && members.some((r) => (r.email ?? "").trim() !== "")) { skippedEmailed++; continue; }
    kept.push(members);
  }
  kept.sort((x, y) => {
    const hv = (y[0].homeValue ?? -1) - (x[0].homeValue ?? -1);
    return hv !== 0 ? hv : x[0].id - y[0].id;
  });
  const limited = a.limit && a.limit > 0 ? kept.slice(0, a.limit) : kept;

  // Union of raw county keys, so the dump carries the whole original record.
  const rawKeys = new Set<string>();
  for (const g of limited) for (const r of g) for (const k of Object.keys(r.raw ?? {})) rawKeys.add(k);
  const rawCols = Array.from(rawKeys).sort();

  const header = [...TRACERFY_INPUT_HEADER, ...EXTRA_HEADER, ...rawCols.map((k) => `county_${k}`)];
  const lines = [header.map(csvCell).join(",")];
  const out: Array<Record<string, unknown>> = [];
  for (const g of limited) {
    const p = g[0];
    const others = g.slice(1);
    const co: CoOwner[] = others.length
      ? others.map((o) => ({ first: o.firstName ?? "", last: o.lastName ?? "" }))
      : coOwnersFromHouseholdName(p.householdName, p.firstName, p.lastName);
    const address = p.hAddress ?? p.pAddress ?? "";
    const city = p.hCity ?? p.pCity ?? "";
    const state = p.hState ?? p.pState ?? "IL";
    const zip = p.hZip ?? p.pZip ?? "";
    const traced = g.some((r) => isTraced(r.pTags)) || isTraced(p.hTags);
    const rec: Record<string, unknown> = {
      Address: address, City: city, State: state, Zip: zip, "First Name": p.firstName ?? "", "Last Name": p.lastName ?? "",
      "Home Value": p.homeValue ?? "", "VistaIntel ID": p.id, "Household ID": p.hId ?? "",
      "Owner Name On Record": p.fullName, "Household Name": p.householdName ?? "",
      "Co-Owner 1 First": co[0]?.first ?? "", "Co-Owner 1 Last": co[0]?.last ?? "",
      "Co-Owner 2 First": co[1]?.first ?? "", "Co-Owner 2 Last": co[1]?.last ?? "",
      "Mail Address": address, "Mail City": city, "Mail State": state, "Mail Zip": zip,
      Email: g.map((r) => r.email).filter(Boolean).join("; "),
      Phone: g.map((r) => r.phone).filter(Boolean).join("; "),
      Mobile: g.map((r) => r.phoneMobile).filter(Boolean).join("; "),
      "Lead Status": p.leadStatus,
      Tags: Array.from(new Set([...(p.pTags ?? []), ...(p.hTags ?? [])])).join("; "),
      Source: p.source, County: p.county ?? "",
      "Home Value Source": p.homeValueSource ?? "", "Owner Occupied": p.ownerOccupied == null ? "" : p.ownerOccupied ? "yes" : "no",
      Traced: traced ? "yes" : "no", "Co-Owner Records": others.map((o) => o.id).join("; "),
    };
    for (const k of rawCols) rec[`county_${k}`] = (p.raw as Record<string, unknown> | null)?.[k] ?? "";
    out.push(rec);
    lines.push(header.map((h) => csvCell(rec[h])).join(","));
  }

  return {
    ok: true,
    zips,
    header,
    rows: out,
    csv: lines.join("\r\n") + "\r\n",
    skippedTraced,
    skippedEmailed,
    skippedDnc,
    totalHouseholds: groups.size,
  };
}
