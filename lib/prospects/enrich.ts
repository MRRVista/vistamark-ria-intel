/**
 * Contact enrichment upload (v0.25.0, extended v0.25.2).
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
 *      reported and skipped — except in a trust-titled household, where the
 *      roll shows a trustee and Tracerfy's resident is accepted as a new
 *      record (v0.25.2, tagged name-source:<source>).
 * What is kept:
 *   - Skip-trace style files (Email-1..Email-5): only emails whose local part
 *     carries the owner's first or last name, in the file's rank order; the
 *     best becomes `email`, up to two more are kept as alternates on the event.
 *   - A spouse named in the household ("Richard & Maria Loeber") whose first
 *     name appears in one of the emails gets their own prospect record in the
 *     household carrying that email (v0.25.2), so outreach can address both.
 *   - A single `email` column (your own lists): taken as given.
 *   - Phones: primary/first mobile → phone_mobile, first landline → phone.
 *     Existing values are never overwritten unless overwrite=1.
 *   - DOB, age, relatives and the like are ignored even if present.
 * Every household the file reached (hit or not) is tagged
 * traced:<source>:<date> (v0.25.2) so the Tracerfy export skips it next time —
 * a trace costs credits, and the tag is what stops a house being paid for twice.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, isDbReady, schema } from "../db";
import { coOwnersFromHouseholdName } from "./export";
import { addressKey, normalizePhone, personKey, titleCase } from "./normalize";
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

/** Emails that carry a specific first name (3+ letters) in the local part. */
export function firstNamed(emails: string[], first: string | null | undefined): string[] {
  const wf = letters(first);
  if (wf.length < 3) return [];
  return emails.filter((e) => letters(e.split("@")[0]).includes(wf));
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
  outcome: "written" | "would_write" | "no_data" | "household_not_in_pool" | "other_person" | "added_resident" | "nothing_usable" | "duplicate_email" | "bad_row";
  prospectId?: number;
  email?: string;
  phone?: string;
  mobile?: string;
  spouse?: { prospectId?: number; name: string; email: string };
}

type Cand = {
  id: number; householdId: number | null; firstName: string | null; lastName: string | null;
  email: string | null; phone: string | null; phoneMobile: string | null; tags: string[] | null;
  zip5: string; addressLine1: string | null; city: string | null; state: string | null;
  householdName: string | null; householdTags: string[] | null;
};

export async function enrichContacts(a: EnrichArgs) {
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const table = parseTabular(a.data, { filename: a.filename });
  const source = (a.source || "upload").toLowerCase().replace(/[^a-z0-9:-]/g, "-").slice(0, 40);
  const today = new Date().toISOString().slice(0, 10);
  const tracedTag = `traced:${source}:${today}`;

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

  const cols = {
    id: prospects.id, householdId: prospects.householdId, firstName: prospects.firstName, lastName: prospects.lastName,
    email: prospects.email, phone: prospects.phone, phoneMobile: prospects.phoneMobile, tags: prospects.tags,
    zip5: prospects.zip5, addressLine1: prospects.addressLine1, city: prospects.city, state: prospects.state,
    householdName: prospectHouseholds.householdName, householdTags: prospectHouseholds.tags,
  };

  // Tag every member of a household the file reached, once per household.
  const tracedHouseholds = new Set<string>();
  async function markTraced(cands: Cand[]) {
    if (a.dryRun || !cands.length) return;
    const key = cands[0].householdId != null ? `h${cands[0].householdId}` : `p${cands[0].id}`;
    if (tracedHouseholds.has(key)) return;
    tracedHouseholds.add(key);
    for (const c of cands) {
      if ((c.tags ?? []).includes(tracedTag)) continue;
      const tags = Array.from(new Set([...(c.tags ?? []), tracedTag]));
      await db.update(prospects).set({ tags, updatedAt: new Date() }).where(eq(prospects.id, c.id));
      c.tags = tags;
    }
  }

  async function emailTaken(email: string, exceptId: number): Promise<boolean> {
    const taken = await db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.emailNormalized, email), sql`${prospects.id} <> ${exceptId}`)).limit(1);
    return taken.length > 0;
  }

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

    // Find the household's people.
    let cands: Cand[] = [];
    if (idRaw && /^\d+$/.test(idRaw)) {
      cands = await db.select(cols).from(prospects).leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id)).where(eq(prospects.id, Number(idRaw)));
    } else {
      const key = addressKey(address, zip || null);
      if (!key) { out.push({ row: i, address, name, outcome: "bad_row" }); continue; }
      cands = await db.select(cols).from(prospects).innerJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id)).where(eq(prospectHouseholds.addressKey, key));
    }
    if (!cands.length) { out.push({ row: i, address, name, outcome: "household_not_in_pool" }); continue; }
    await markTraced(cands);

    if (!first && !last && !rawEmails.length && !mobiles.length && !lands.length) {
      out.push({ row: i, address, name, outcome: "no_data", prospectId: cands[0].id });
      continue;
    }

    let owner = cands.find((c) => samePerson(first, last, c.firstName, c.lastName)) ?? (idRaw && !first && !last ? cands[0] : undefined);
    let addedResident = false;
    if (!owner) {
      const trustTitled = cands.some((c) => (c.tags ?? []).includes("trust-titled") || (c.householdTags ?? []).includes("trust-titled"));
      if (!trustTitled || !first || !last) { out.push({ row: i, address, name, outcome: "other_person", prospectId: cands[0].id }); continue; }
      // Trust on the roll, person from the trace: accept them as a resident alongside the trustee record.
      const base = cands[0];
      const newKey = personKey(base.zip5, last, first, base.addressLine1 ?? address, null);
      const existing = await db.select({ id: prospects.id }).from(prospects).where(eq(prospects.personKey, newKey)).limit(1);
      if (existing.length) {
        const found = await db.select(cols).from(prospects).leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id)).where(eq(prospects.id, existing[0].id));
        owner = found[0];
      } else if (!a.dryRun) {
        const [ins] = await db.insert(prospects).values({
          householdId: base.householdId, personKey: newKey,
          firstName: titleCase(first), lastName: titleCase(last), fullName: `${titleCase(first)} ${titleCase(last)}`,
          zip5: base.zip5, addressLine1: base.addressLine1, city: base.city, state: base.state,
          source: `enrich:${source}`, sourceDetail: a.filename ?? null,
          tags: [`name-source:${source}`, "trust-resident", tracedTag, ...(a.tag ? [a.tag] : [])],
        }).returning({ id: prospects.id });
        owner = { ...base, id: ins.id, firstName: titleCase(first), lastName: titleCase(last), email: null, phone: null, phoneMobile: null, tags: [`name-source:${source}`, "trust-resident", tracedTag] };
        addedResident = true;
      } else {
        owner = { ...base, id: -1, firstName: titleCase(first), lastName: titleCase(last), email: null, phone: null, phoneMobile: null, tags: [] };
        addedResident = true;
      }
    }

    const emails = Array.from(new Set(skipTraceStyle ? namedOnly(rawEmails, owner.firstName, owner.lastName) : rawEmails));
    const mobile = mobiles[0];
    const phone = lands[0];
    const set: Record<string, unknown> = {};
    if (emails[0] && (a.overwrite || !owner.email)) {
      if (owner.id > 0 && await emailTaken(emails[0], owner.id)) { out.push({ row: i, address, name, outcome: "duplicate_email", prospectId: owner.id }); continue; }
      set.email = emails[0];
      set.emailNormalized = emails[0];
      set.emailStatus = "unverified";
    }
    if (mobile && (a.overwrite || !owner.phoneMobile)) set.phoneMobile = mobile;
    if (phone && (a.overwrite || !owner.phone)) set.phone = phone;

    // Spouse / co-owner: a first-name email in the same result row gets its own record.
    let spouse: EnrichRow["spouse"];
    if (skipTraceStyle && owner.id > 0) {
      const others = cands.filter((c) => c.id !== owner!.id);
      const named = others.length
        ? others.map((o) => ({ first: o.firstName ?? "", last: o.lastName ?? "", rec: o as Cand | null }))
        : coOwnersFromHouseholdName(owner.householdName, owner.firstName, owner.lastName).map((c) => ({ ...c, rec: null as Cand | null }));
      for (const co of named) {
        const hit = firstNamed(rawEmails, co.first).find((e) => e !== set.email && e !== owner!.email);
        if (!hit) continue;
        if (co.rec) {
          if (co.rec.email && !a.overwrite) break;
          if (!a.dryRun && !(await emailTaken(hit, co.rec.id))) {
            await db.update(prospects).set({ email: hit, emailNormalized: hit, emailStatus: "unverified", tags: Array.from(new Set([...(co.rec.tags ?? []), `enriched:${source}`, `email:${source}`, ...(a.tag ? [a.tag] : [])])), updatedAt: new Date() }).where(eq(prospects.id, co.rec.id));
            await db.insert(prospectEvents).values({ prospectId: co.rec.id, kind: "contact_enrich", detail: `${source}: email (co-owner, from row ${i})`, meta: { source, filename: a.filename ?? null, email: hit }, actor: a.actor ?? "enrich-upload" });
          }
          spouse = { prospectId: co.rec.id, name: `${co.first} ${co.last}`.trim(), email: hit };
        } else {
          const coKey = personKey(owner.zip5, co.last, co.first, owner.addressLine1 ?? address, null);
          const dup = await db.select({ id: prospects.id, email: prospects.email }).from(prospects).where(eq(prospects.personKey, coKey)).limit(1);
          if (dup.length) { spouse = { prospectId: dup[0].id, name: `${co.first} ${co.last}`.trim(), email: dup[0].email ?? hit }; break; }
          if (!a.dryRun && !(await emailTaken(hit, 0))) {
            const [ins] = await db.insert(prospects).values({
              householdId: owner.householdId, personKey: coKey,
              firstName: titleCase(co.first), lastName: titleCase(co.last), fullName: `${titleCase(co.first)} ${titleCase(co.last)}`,
              email: hit, emailNormalized: hit, emailStatus: "unverified",
              zip5: owner.zip5, addressLine1: owner.addressLine1, city: owner.city, state: owner.state,
              source: `enrich:${source}`, sourceDetail: a.filename ?? null,
              tags: ["co-owner", `enriched:${source}`, `email:${source}`, tracedTag, ...(a.tag ? [a.tag] : [])],
            }).returning({ id: prospects.id });
            await db.insert(prospectEvents).values({ prospectId: ins.id, kind: "contact_enrich", detail: `${source}: co-owner record created with email (from row ${i})`, meta: { source, filename: a.filename ?? null, email: hit, primaryProspectId: owner.id }, actor: a.actor ?? "enrich-upload" });
            spouse = { prospectId: ins.id, name: `${co.first} ${co.last}`.trim(), email: hit };
          } else {
            spouse = { name: `${co.first} ${co.last}`.trim(), email: hit };
          }
        }
        break;
      }
    }

    if (!Object.keys(set).length) {
      out.push({ row: i, address, name, outcome: addedResident ? "added_resident" : "nothing_usable", prospectId: owner.id > 0 ? owner.id : undefined, spouse });
      continue;
    }

    if (!a.dryRun && owner.id > 0) {
      const tags = Array.from(new Set([...(owner.tags ?? []), tracedTag, `enriched:${source}`, ...(set.email ? [`email:${source}`] : []), ...(a.tag ? [a.tag] : [])]));
      await db.update(prospects).set({ ...set, tags, updatedAt: new Date() }).where(eq(prospects.id, owner.id));
      await db.insert(prospectEvents).values({
        prospectId: owner.id,
        kind: "contact_enrich",
        detail: `${source}: ${Object.keys(set).filter((k) => k !== "emailNormalized" && k !== "emailStatus").join(", ")}${addedResident ? " (resident added for trust-titled home)" : ""}`,
        meta: { source, filename: a.filename ?? null, email: set.email ?? null, alternateEmails: emails.slice(1, 3), phone: set.phone ?? null, phoneMobile: set.phoneMobile ?? null, spouse: spouse ?? null },
        actor: a.actor ?? "enrich-upload",
      });
    }
    out.push({ row: i, address, name, outcome: a.dryRun ? "would_write" : addedResident ? "added_resident" : "written", prospectId: owner.id > 0 ? owner.id : undefined, email: set.email as string | undefined, phone: set.phone as string | undefined, mobile: set.phoneMobile as string | undefined, spouse });
  }

  const counts: Record<string, number> = {};
  for (const r of out) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return {
    ok: true,
    dryRun: !!a.dryRun,
    source,
    tracedTag,
    rows: out.length,
    counts,
    withEmail: out.filter((r) => r.email).length,
    withPhone: out.filter((r) => r.phone || r.mobile).length,
    withSpouseEmail: out.filter((r) => r.spouse?.email).length,
    householdsTagged: tracedHouseholds.size,
    results: out,
  };
}
