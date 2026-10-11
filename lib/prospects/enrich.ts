/**
 * Contact enrichment upload (v0.25.0).
 *
 * Attach emails and phones you obtained elsewhere — a Tracerfy results file,
 * your own contact export, a list you bought — to the households already in
 * the prospects database. Nothing here looks anyone up; it only joins a file
 * you supply to records that exist, so Randall's existing prospects_search /
 * prospect_lookup tools can answer "John Smith on Oak Street" with what you
 * loaded.
 *
 * Matching, per row:
 *   1. `id` column (VistaIntel prospect id) if present, else the household by
 *      USPS-normalized address + ZIP.
 *   2. The person in the file must be the owner on record: same surname, same
 *      first name or initial. Anyone else (a relative, a prior owner) is
 *      reported and skipped — never added as a new record.
 * What is kept:
 *   - Skip-trace style files (Email-1..Email-5): only emails whose local part
 *     carries the owner's first or last name, in the file's rank order; the
 *     best becomes `email`, up to two more are kept as alternates on the event.
 *   - A single `email` column (your own lists): taken as given.
 *   - Phones: primary/first mobile → phone_mobile, first landline → phone.
 *     Existing values are never overwritten unless overwrite=1.
 *   - DOB, age, relatives and the like are ignored even if present.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, isDbReady, schema } from "../db";
import { addressKey, normalizePhone } from "./normalize";
import { parseTabular } from "./tabular";

const { prospects, prospectHouseholds, prospectEvents } = schema;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const letters = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
const cleanSurname = (last: string | null | undefined) =>
  (last ?? "").replace(/(\s+(tr|trs|trst|trust|trustee|trustees|ttee|decl|rev|living))+$/i, "").trim();

export function samePerson(fileFirst: string, fileLast: string, ownerFirst: string | null, ownerLast: string | null): boolean {
  const fl = letters(fileLast), ol = letters(cleanSurname(ownerLast));
  if (!fl || fl !== ol) return false;
  const ff = letters(fileFirst), of = letters(ownerFirst);
  if (!ff || !of) return true;
  if (ff.length === 1 || of.length === 1) return ff.charAt(0) === of.charAt(0);
  return ff === of || ff.startsWith(of) || of.startsWith(ff);
}

export function namedOnly(emails: string[], first: string | null, last: string | null): string[] {
  const wf = letters(first), wl = letters(cleanSurname(last));
  return emails.filter((e) => {
    const local = letters(e.split("@")[0]);
    return (wl.length >= 3 && local.includes(wl)) || (wf.length >= 3 && local.includes(wf));
  });
}

export interface EnrichArgs {
  data: Buffer | string;
  filename?: string;
  source?: string;        // e.g. "tracerfy", "matt-contacts"
  tag?: string;           // e.g. "queue:first"
  overwrite?: boolean;
  dryRun?: boolean;
  actor?: string;
}

export interface EnrichRow {
  row: number;
  address: string;
  name: string;
  outcome: "written" | "would_write" | "no_data" | "household_not_in_pool" | "other_person" | "nothing_usable" | "duplicate_email" | "bad_row";
  prospectId?: number;
  email?: string;
  phone?: string;
  mobile?: string;
}

export async function enrichContacts(a: EnrichArgs) {
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const table = parseTabular(a.data, { filename: a.filename });
  const source = (a.source || "upload").toLowerCase().replace(/[^a-z0-9:-]/g, "-").slice(0, 40);

  const keyOf = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const headers = new Map(table.headers.map((h) => [keyOf(h), h]));
  const get = (row: Record<string, string>, ...names: string[]) => {
    for (const n of names) {
      const h = headers.get(keyOf(n));
      if (h && row[h] != null && String(row[h]).trim() !== "") return String(row[h]).trim();
    }
    return "";
  };
  const numbered = (prefix: string, max: number) =>
    Array.from({ length: max }, (_, i) => headers.get(keyOf(`${prefix}-${i + 1}`)) ?? headers.get(keyOf(`${prefix}${i + 1}`))).filter(Boolean) as string[];
  const emailCols = numbered("email", 5);
  const mobileCols = numbered("mobile", 5);
  const landCols = numbered("landline", 3);
  const skipTraceStyle = emailCols.length > 1;

  const out: EnrichRow[] = [];
  let i = 0;
  for (const row of table.rows) {
    i++;
    const address = get(row, "address", "address1", "property address", "street");
    const zip = get(row, "zip", "zip5", "zipcode", "postal code").slice(0, 5);
    const first = get(row, "first_name", "first name", "firstname");
    const last = get(row, "last_name", "last name", "lastname");
    const idRaw = get(row, "id", "vistaintel id", "prospect id");
    const name = `${first} ${last}`.trim();

    // Emails and phones present on the row.
    const rawEmails = (skipTraceStyle ? emailCols.map((h) => row[h]) : [get(row, "email", "email-1", "email1", "email address")])
      .map((e) => String(e ?? "").trim().toLowerCase())
      .filter((e) => EMAIL_RE.test(e));
    const primary = get(row, "primary_phone", "primary phone");
    const primaryType = get(row, "primary_phone_type", "primary phone type").toLowerCase();
    const mobiles = [primaryType.startsWith("mobile") ? primary : "", ...mobileCols.map((h) => row[h]), get(row, "mobile", "cell")]
      .map((p) => normalizePhone(p)).filter(Boolean) as string[];
    const lands = [primaryType.startsWith("land") ? primary : "", ...landCols.map((h) => row[h]), get(row, "phone", "landline")]
      .map((p) => normalizePhone(p)).filter(Boolean) as string[];

    if (!first && !last && !rawEmails.length && !mobiles.length && !lands.length) {
      out.push({ row: i, address, name, outcome: "no_data" });
      continue;
    }

    // Find the household's people.
    let cands: Array<{ id: number; firstName: string | null; lastName: string | null; email: string | null; phone: string | null; phoneMobile: string | null; tags: string[] | null }> = [];
    const cols = { id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, email: prospects.email, phone: prospects.phone, phoneMobile: prospects.phoneMobile, tags: prospects.tags };
    if (idRaw && /^\d+$/.test(idRaw)) {
      cands = await db.select(cols).from(prospects).where(eq(prospects.id, Number(idRaw)));
    } else {
      const key = addressKey(address, zip || null);
      if (!key) { out.push({ row: i, address, name, outcome: "bad_row" }); continue; }
      cands = await db.select(cols).from(prospects).innerJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id)).where(eq(prospectHouseholds.addressKey, key));
    }
    if (!cands.length) { out.push({ row: i, address, name, outcome: "household_not_in_pool" }); continue; }

    const owner = cands.find((c) => samePerson(first, last, c.firstName, c.lastName)) ?? (idRaw && !first && !last ? cands[0] : undefined);
    if (!owner) { out.push({ row: i, address, name, outcome: "other_person", prospectId: cands[0].id }); continue; }

    const emails = Array.from(new Set(skipTraceStyle ? namedOnly(rawEmails, owner.firstName, owner.lastName) : rawEmails));
    const mobile = mobiles[0];
    const phone = lands[0];
    const set: Record<string, unknown> = {};
    if (emails[0] && (a.overwrite || !owner.email)) {
      const taken = await db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.emailNormalized, emails[0]), sql`${prospects.id} <> ${owner.id}`)).limit(1);
      if (taken.length) { out.push({ row: i, address, name, outcome: "duplicate_email", prospectId: owner.id }); continue; }
      set.email = emails[0];
      set.emailNormalized = emails[0];
      set.emailStatus = "unverified";
    }
    if (mobile && (a.overwrite || !owner.phoneMobile)) set.phoneMobile = mobile;
    if (phone && (a.overwrite || !owner.phone)) set.phone = phone;
    if (!Object.keys(set).length) { out.push({ row: i, address, name, outcome: "nothing_usable", prospectId: owner.id }); continue; }

    if (!a.dryRun) {
      const tags = Array.from(new Set([...(owner.tags ?? []), `enriched:${source}`, ...(set.email ? [`email:${source}`] : []), ...(a.tag ? [a.tag] : [])]));
      await db.update(prospects).set({ ...set, tags, updatedAt: new Date() }).where(eq(prospects.id, owner.id));
      await db.insert(prospectEvents).values({
        prospectId: owner.id,
        kind: "contact_enrich",
        detail: `${source}: ${Object.keys(set).filter((k) => k !== "emailNormalized" && k !== "emailStatus").join(", ")}`,
        meta: { source, filename: a.filename ?? null, email: set.email ?? null, alternateEmails: emails.slice(1, 3), phone: set.phone ?? null, phoneMobile: set.phoneMobile ?? null },
        actor: a.actor ?? "enrich-upload",
      });
    }
    out.push({ row: i, address, name, outcome: a.dryRun ? "would_write" : "written", prospectId: owner.id, email: set.email as string | undefined, phone: set.phone as string | undefined, mobile: set.phoneMobile as string | undefined });
  }

  const counts: Record<string, number> = {};
  for (const r of out) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return {
    ok: true,
    dryRun: !!a.dryRun,
    source,
    rows: out.length,
    counts,
    withEmail: out.filter((r) => r.email).length,
    withPhone: out.filter((r) => r.phone || r.mobile).length,
    results: out,
  };
}
