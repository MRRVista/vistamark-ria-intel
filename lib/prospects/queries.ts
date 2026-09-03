/**
 * Prospect read/update path — everything the MCP tools and /api/prospects
 * expose that is not a bulk import.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { prospectEvents, prospectHouseholds, prospectImports, prospects, prospectZips } from "../db/schema";
import { LEAD_STATUSES, normalizeEmail, normalizeZip, str, tagsList } from "./normalize";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface ProspectSearchArgs {
  zip?: string;
  zips?: string[];
  q?: string;
  lastName?: string;
  email?: string;
  street?: string;
  city?: string;
  leadStatus?: string | string[];
  source?: string;
  tag?: string;
  hasEmail?: boolean;
  emailOptIn?: boolean;
  excludeDoNotContact?: boolean;
  contactableByEmail?: boolean;
  minHomeValue?: number;
  maxHomeValue?: number;
  minLeadScore?: number;
  minInvestableAssets?: number;
  isBusinessOwner?: boolean;
  isExecutive?: boolean;
  householdId?: number;
  importId?: number;
  updatedSince?: string;
  notSyncedToCrm?: boolean;
  sortBy?: "updated_at" | "last_name" | "home_value" | "lead_score" | "created_at";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function zipList(zip?: string, zips?: string[]): string[] {
  const all = [...(zips ?? []), ...(zip ? String(zip).split(/[,\s]+/) : [])];
  return Array.from(new Set(all.map((z) => normalizeZip(z).zip5).filter((z): z is string => !!z)));
}

export function buildProspectWhere(a: ProspectSearchArgs): SQL | undefined {
  const conds: SQL[] = [];
  const zips = zipList(a.zip, a.zips);
  if (zips.length) conds.push(inArray(prospects.zip5, zips));
  if (a.q) {
    const like = `%${a.q.trim()}%`;
    conds.push(
      or(
        ilike(prospects.fullName, like),
        ilike(prospects.email, like),
        ilike(prospects.addressLine1, like),
        ilike(prospects.employer, like),
        ilike(prospects.notes, like)
      )!
    );
  }
  if (a.lastName) conds.push(ilike(prospects.lastName, `${a.lastName.trim()}%`));
  if (a.email) {
    const n = normalizeEmail(a.email);
    conds.push(n.normalized ? eq(prospects.emailNormalized, n.normalized) : ilike(prospects.email, `%${a.email}%`));
  }
  if (a.street) conds.push(ilike(prospects.addressLine1, `%${a.street.trim()}%`));
  if (a.city) conds.push(ilike(prospects.city, a.city.trim()));
  if (a.leadStatus) {
    const list = (Array.isArray(a.leadStatus) ? a.leadStatus : String(a.leadStatus).split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (list.length) conds.push(inArray(prospects.leadStatus, list));
  }
  if (a.source) conds.push(ilike(prospects.source, `${a.source}%`));
  if (a.tag) conds.push(sql`${prospects.tags} @> ARRAY[${a.tag.toLowerCase()}]::text[]`);
  if (a.hasEmail === true) conds.push(isNotNull(prospects.emailNormalized));
  if (a.hasEmail === false) conds.push(isNull(prospects.emailNormalized));
  if (a.emailOptIn != null) conds.push(eq(prospects.emailOptIn, a.emailOptIn));
  if (a.excludeDoNotContact) conds.push(eq(prospects.doNotContact, false));
  if (a.contactableByEmail) {
    conds.push(isNotNull(prospects.emailNormalized), eq(prospects.doNotContact, false), eq(prospects.doNotEmail, false));
    conds.push(sql`${prospects.emailStatus} NOT IN ('invalid','bounced')`);
  }
  if (a.minLeadScore != null) conds.push(gte(prospects.leadScore, a.minLeadScore));
  if (a.minInvestableAssets != null) conds.push(gte(prospects.estInvestableAssets, a.minInvestableAssets));
  if (a.isBusinessOwner != null) conds.push(eq(prospects.isBusinessOwner, a.isBusinessOwner));
  if (a.isExecutive != null) conds.push(eq(prospects.isExecutive, a.isExecutive));
  if (a.householdId != null) conds.push(eq(prospects.householdId, a.householdId));
  if (a.importId != null) conds.push(eq(prospects.importId, a.importId));
  if (a.updatedSince) conds.push(gte(prospects.updatedAt, new Date(a.updatedSince)));
  if (a.notSyncedToCrm) conds.push(or(isNull(prospects.crmSyncedAt), sql`${prospects.updatedAt} > ${prospects.crmSyncedAt}`)!);
  if (a.minHomeValue != null) conds.push(gte(prospectHouseholds.homeValue, a.minHomeValue));
  if (a.maxHomeValue != null) conds.push(lte(prospectHouseholds.homeValue, a.maxHomeValue));
  return conds.length ? and(...conds) : undefined;
}

const SORT: Record<string, any> = {
  updated_at: prospects.updatedAt,
  created_at: prospects.createdAt,
  last_name: prospects.lastName,
  lead_score: prospects.leadScore,
  home_value: prospectHouseholds.homeValue,
};

export function shapeRow(p: any, h: any) {
  return {
    id: p.id,
    householdId: p.householdId,
    name: {
      first: p.firstName,
      middle: p.middleName,
      last: p.lastName,
      suffix: p.suffix,
      full: p.fullName,
    },
    email: p.email,
    emailStatus: p.emailStatus,
    emailOptIn: p.emailOptIn,
    phone: p.phone,
    phoneMobile: p.phoneMobile,
    address: {
      line1: p.addressLine1,
      line2: p.addressLine2,
      city: p.city,
      state: p.state,
      zip5: p.zip5,
      zip4: p.zip4,
    },
    consent: {
      doNotContact: p.doNotContact,
      doNotEmail: p.doNotEmail,
      doNotCall: p.doNotCall,
      doNotMail: p.doNotMail,
      contactableByEmail:
        !!p.emailNormalized && !p.doNotContact && !p.doNotEmail && !["invalid", "bounced"].includes(p.emailStatus),
    },
    profile: {
      ageBand: p.ageBand,
      birthYear: p.birthYear,
      occupation: p.occupation,
      employer: p.employer,
      title: p.title,
      industry: p.industry,
      linkedinUrl: p.linkedinUrl,
    },
    wealth: {
      estNetWorthBand: p.estNetWorthBand ?? h?.estNetWorthBand ?? null,
      estInvestableAssets: p.estInvestableAssets,
      estIncomeBand: p.estIncomeBand,
      isBusinessOwner: p.isBusinessOwner,
      isExecutive: p.isExecutive,
      hasTrust: p.hasTrust,
      signals: p.wealthSignals,
      homeValue: h?.homeValue ?? null,
      homeValueSource: h?.homeValueSource ?? null,
      homeValueAsOf: h?.homeValueAsOf ?? null,
      purchasePrice: h?.purchasePrice ?? null,
      purchaseDate: h?.purchaseDate ?? null,
      yearBuilt: h?.yearBuilt ?? null,
      sqFt: h?.sqFt ?? null,
      lotAcres: h?.lotAcres != null ? Number(h.lotAcres) : null,
      ownerOccupied: h?.ownerOccupied ?? null,
      estHouseholdIncome: h?.estHouseholdIncome ?? null,
      householdSize: h?.householdSize ?? null,
      wealthScore: h?.wealthScore ?? null,
    },
    lead: { score: p.leadScore, status: p.leadStatus },
    provenance: {
      source: p.source,
      sourceDetail: p.sourceDetail,
      sourceRecordId: p.sourceRecordId,
      acquiredAt: p.acquiredAt,
      importId: p.importId,
    },
    crm: {
      vistacrmContactId: p.vistacrmContactId,
      wealthboxContactId: p.wealthboxContactId,
      syncedAt: p.crmSyncedAt,
      vistacrmHouseholdId: h?.vistacrmHouseholdId ?? null,
    },
    tags: p.tags,
    notes: p.notes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function prospectsSearch(args: ProspectSearchArgs = {}) {
  if (!isDbReady()) return { rows: [], total: 0, dbReady: false };
  const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 1000);
  const offset = Math.max(Number(args.offset ?? 0), 0);
  const where = buildProspectWhere(args);
  const order = SORT[args.sortBy ?? "updated_at"] ?? prospects.updatedAt;
  const dir = args.sortDir === "asc" ? asc : desc;

  const base = db
    .select({ p: prospects, h: prospectHouseholds })
    .from(prospects)
    .leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id));
  const rows = await (where ? base.where(where) : base).orderBy(dir(order), asc(prospects.id)).limit(limit).offset(offset);

  const countQ = db
    .select({ n: sql<number>`count(*)::int` })
    .from(prospects)
    .leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id));
  const [{ n }] = await (where ? countQ.where(where) : countQ);

  return {
    total: n,
    limit,
    offset,
    zips: zipList(args.zip, args.zips),
    rows: rows.map((r) => shapeRow(r.p, r.h)),
    dbReady: true,
  };
}

// ---------------------------------------------------------------------------
// Lookup (one person + household + siblings + events)
// ---------------------------------------------------------------------------

export async function prospectLookup(args: { id?: number; email?: string; personKey?: string }) {
  if (!isDbReady()) return { row: null, dbReady: false };
  let where: SQL | undefined;
  if (args.id != null) where = eq(prospects.id, Number(args.id));
  else if (args.personKey) where = eq(prospects.personKey, args.personKey);
  else if (args.email) {
    const n = normalizeEmail(args.email);
    if (!n.normalized) throw new Error(`Invalid email: ${args.email}`);
    where = eq(prospects.emailNormalized, n.normalized);
  } else throw new Error("prospect_lookup requires id, email, or personKey");

  const rows = await db
    .select({ p: prospects, h: prospectHouseholds })
    .from(prospects)
    .leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id))
    .where(where)
    .limit(1);
  const hit = rows[0];
  if (!hit) return { row: null, dbReady: true };

  const [householdMembers, events] = await Promise.all([
    hit.p.householdId
      ? db
          .select({ id: prospects.id, fullName: prospects.fullName, email: prospects.email, leadStatus: prospects.leadStatus })
          .from(prospects)
          .where(and(eq(prospects.householdId, hit.p.householdId), sql`${prospects.id} <> ${hit.p.id}`))
      : Promise.resolve([]),
    db.select().from(prospectEvents).where(eq(prospectEvents.prospectId, hit.p.id)).orderBy(desc(prospectEvents.at)).limit(50),
  ]);

  return {
    row: shapeRow(hit.p, hit.h),
    household: hit.h
      ? { id: hit.h.id, name: hit.h.householdName, addressKey: hit.h.addressKey, tags: hit.h.tags, notes: hit.h.notes, members: householdMembers }
      : null,
    events,
    dbReady: true,
  };
}

// ---------------------------------------------------------------------------
// Update one prospect (status / consent / enrichment / note)
// ---------------------------------------------------------------------------

export interface ProspectUpdateArgs {
  id: number;
  leadStatus?: string;
  leadScore?: number;
  emailOptIn?: boolean;
  optInSource?: string;
  emailStatus?: string;
  doNotContact?: boolean;
  doNotEmail?: boolean;
  doNotCall?: boolean;
  doNotMail?: boolean;
  addTags?: string[] | string;
  removeTags?: string[] | string;
  note?: string;
  wealthSignals?: Record<string, unknown>;
  estNetWorthBand?: string;
  estInvestableAssets?: number;
  occupation?: string;
  employer?: string;
  title?: string;
  linkedinUrl?: string;
  phone?: string;
  phoneMobile?: string;
  email?: string;
  vistacrmContactId?: string;
  wealthboxContactId?: string;
  event?: { kind: string; detail?: string; meta?: Record<string, unknown> };
  actor?: string;
}

export async function prospectUpdate(a: ProspectUpdateArgs) {
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  if (a.id == null) throw new Error("prospect_update requires id");
  const id = Number(a.id);
  const [current] = await db.select().from(prospects).where(eq(prospects.id, id)).limit(1);
  if (!current) throw new Error(`No prospect with id ${id}`);

  const set: Record<string, unknown> = { updatedAt: sql`NOW()` };
  const events: Array<{ kind: string; detail: string | null; meta: Record<string, unknown> | null }> = [];

  if (a.leadStatus != null) {
    const s = String(a.leadStatus).toLowerCase();
    if (!(LEAD_STATUSES as readonly string[]).includes(s)) throw new Error(`Invalid leadStatus '${s}' (allowed: ${LEAD_STATUSES.join(", ")})`);
    if (s !== current.leadStatus) {
      set.leadStatus = s;
      events.push({ kind: "status_change", detail: `${current.leadStatus} -> ${s}`, meta: { from: current.leadStatus, to: s } });
    }
  }
  if (a.leadScore != null) set.leadScore = Math.max(0, Math.min(100, Math.trunc(Number(a.leadScore))));
  if (a.emailOptIn != null) {
    set.emailOptIn = !!a.emailOptIn;
    set.optInAt = sql`NOW()`;
    set.optInSource = a.optInSource ?? a.actor ?? "manual";
    events.push({ kind: "consent", detail: a.emailOptIn ? "email opt-in" : "email opt-out", meta: { source: set.optInSource } });
    if (a.emailOptIn === false) set.doNotEmail = true;
  }
  if (a.emailStatus != null) set.emailStatus = String(a.emailStatus).toLowerCase();
  for (const f of ["doNotContact", "doNotEmail", "doNotCall", "doNotMail"] as const) {
    if (a[f] != null) {
      set[f] = !!a[f];
      events.push({ kind: "consent", detail: `${f} = ${!!a[f]}`, meta: null });
    }
  }
  if (a.email != null) {
    const n = normalizeEmail(a.email);
    set.email = n.email;
    set.emailNormalized = n.normalized;
    set.emailStatus = n.normalized ? "unverified" : "invalid";
  }
  for (const f of ["estNetWorthBand", "occupation", "employer", "title", "linkedinUrl", "phone", "phoneMobile", "vistacrmContactId", "wealthboxContactId"] as const) {
    if (a[f] != null) set[f] = str(a[f]);
  }
  if (a.estInvestableAssets != null) set.estInvestableAssets = Math.round(Number(a.estInvestableAssets));
  if (a.wealthSignals && typeof a.wealthSignals === "object") set.wealthSignals = { ...(current.wealthSignals ?? {}), ...a.wealthSignals };
  if (a.vistacrmContactId != null) set.crmSyncedAt = sql`NOW()`;

  if (a.addTags != null || a.removeTags != null) {
    const cur = new Set(current.tags ?? []);
    for (const t of tagsList(a.addTags) ?? []) cur.add(t);
    for (const t of tagsList(a.removeTags) ?? []) cur.delete(t);
    set.tags = Array.from(cur).sort();
  }
  if (a.note) {
    const note = String(a.note).trim();
    set.notes = current.notes ? `${current.notes}\n${note}` : note;
    events.push({ kind: "note", detail: note, meta: null });
  }
  if (a.event?.kind) events.push({ kind: String(a.event.kind).slice(0, 32), detail: a.event.detail ?? null, meta: a.event.meta ?? null });

  const [updated] = await db.update(prospects).set(set as any).where(eq(prospects.id, id)).returning();
  if (events.length) {
    await db.insert(prospectEvents).values(events.map((e) => ({ prospectId: id, kind: e.kind, detail: e.detail, meta: e.meta, actor: a.actor ?? null })));
  }
  const [h] = updated.householdId
    ? await db.select().from(prospectHouseholds).where(eq(prospectHouseholds.id, updated.householdId)).limit(1)
    : [null];
  return { row: shapeRow(updated, h), eventsLogged: events.length };
}

// ---------------------------------------------------------------------------
// Zip summary + target-zip management
// ---------------------------------------------------------------------------

export async function prospectsZipSummary(args: { zip?: string; zips?: string[]; includeInactive?: boolean } = {}) {
  if (!isDbReady()) return { zips: [], dbReady: false };
  const filter = zipList(args.zip, args.zips);

  const targets = await db
    .select()
    .from(prospectZips)
    .where(and(filter.length ? inArray(prospectZips.zip5, filter) : undefined, args.includeInactive ? undefined : eq(prospectZips.active, true)))
    .orderBy(asc(prospectZips.priority), asc(prospectZips.zip5));

  const stats = await db
    .select({
      zip5: prospects.zip5,
      people: sql<number>`count(*)::int`,
      withEmail: sql<number>`count(${prospects.emailNormalized})::int`,
      optedIn: sql<number>`count(*) FILTER (WHERE ${prospects.emailOptIn} = true)::int`,
      contactableByEmail: sql<number>`count(*) FILTER (WHERE ${prospects.emailNormalized} IS NOT NULL AND NOT ${prospects.doNotContact} AND NOT ${prospects.doNotEmail} AND ${prospects.emailStatus} NOT IN ('invalid','bounced'))::int`,
      doNotContact: sql<number>`count(*) FILTER (WHERE ${prospects.doNotContact})::int`,
      lastUpdated: sql<string>`max(${prospects.updatedAt})`,
    })
    .from(prospects)
    .where(filter.length ? inArray(prospects.zip5, filter) : undefined)
    .groupBy(prospects.zip5);

  const statusRows = await db
    .select({ zip5: prospects.zip5, status: prospects.leadStatus, n: sql<number>`count(*)::int` })
    .from(prospects)
    .where(filter.length ? inArray(prospects.zip5, filter) : undefined)
    .groupBy(prospects.zip5, prospects.leadStatus);
  const statusByZip = new Map<string, Record<string, number>>();
  for (const r of statusRows) {
    const m = statusByZip.get(r.zip5) ?? {};
    m[r.status] = r.n;
    statusByZip.set(r.zip5, m);
  }

  const hh = await db
    .select({
      zip5: prospectHouseholds.zip5,
      households: sql<number>`count(*)::int`,
      withHomeValue: sql<number>`count(${prospectHouseholds.homeValue})::int`,
      avgHomeValue: sql<number>`round(avg(${prospectHouseholds.homeValue}))::float8`,
      medianHomeValue: sql<number>`round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${prospectHouseholds.homeValue}))::float8`,
      maxHomeValue: sql<number>`max(${prospectHouseholds.homeValue})::float8`,
      over2m: sql<number>`count(*) FILTER (WHERE ${prospectHouseholds.homeValue} >= 2000000)::int`,
    })
    .from(prospectHouseholds)
    .where(filter.length ? inArray(prospectHouseholds.zip5, filter) : undefined)
    .groupBy(prospectHouseholds.zip5);

  const statByZip = new Map(stats.map((s) => [s.zip5, s]));
  const hhByZip = new Map(hh.map((s) => [s.zip5, s]));
  const allZips = new Set<string>([...targets.map((t) => t.zip5), ...statByZip.keys()]);

  const zips = Array.from(allZips)
    .map((z) => {
      const t = targets.find((x) => x.zip5 === z) ?? null;
      const s = statByZip.get(z);
      const h = hhByZip.get(z);
      return {
        zip5: z,
        target: t
          ? { city: t.city, state: t.state, county: t.county, label: t.label, priority: t.priority, active: t.active, notes: t.notes }
          : null,
        people: s?.people ?? 0,
        households: h?.households ?? 0,
        withEmail: s?.withEmail ?? 0,
        optedIn: s?.optedIn ?? 0,
        contactableByEmail: s?.contactableByEmail ?? 0,
        doNotContact: s?.doNotContact ?? 0,
        byStatus: statusByZip.get(z) ?? {},
        homeValues: h
          ? { withValue: h.withHomeValue, avg: numOrNull(h.avgHomeValue), median: numOrNull(h.medianHomeValue), max: numOrNull(h.maxHomeValue), over2m: h.over2m }
          : null,
        lastUpdated: s?.lastUpdated ?? null,
      };
    })
    .sort((a, b) => (a.target?.priority ?? 99) - (b.target?.priority ?? 99) || b.people - a.people);

  const imports = await db.select().from(prospectImports).orderBy(desc(prospectImports.startedAt)).limit(10);
  return { zips, recentImports: imports, dbReady: true };
}

export async function prospectZipTargets(args: {
  action?: "list" | "add" | "update" | "deactivate" | "activate";
  zip?: string;
  city?: string;
  state?: string;
  county?: string;
  label?: string;
  priority?: number;
  notes?: string;
}) {
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const action = args.action ?? "list";
  if (action === "list") {
    const rows = await db.select().from(prospectZips).orderBy(asc(prospectZips.active), asc(prospectZips.priority), asc(prospectZips.zip5));
    return { zips: rows };
  }
  const z = normalizeZip(args.zip).zip5;
  if (!z) throw new Error(`'${args.zip}' is not a valid 5-digit zip`);
  if (action === "add" || action === "update") {
    const [row] = await db
      .insert(prospectZips)
      .values({
        zip5: z,
        city: str(args.city),
        state: str(args.state)?.toUpperCase().slice(0, 2) ?? null,
        county: str(args.county),
        label: str(args.label),
        priority: args.priority != null ? Math.trunc(Number(args.priority)) : 1,
        notes: str(args.notes),
        active: true,
      })
      .onConflictDoUpdate({
        target: prospectZips.zip5,
        set: {
          city: sql`COALESCE(EXCLUDED.city, ${prospectZips.city})`,
          state: sql`COALESCE(EXCLUDED.state, ${prospectZips.state})`,
          county: sql`COALESCE(EXCLUDED.county, ${prospectZips.county})`,
          label: sql`COALESCE(EXCLUDED.label, ${prospectZips.label})`,
          priority: args.priority != null ? Math.trunc(Number(args.priority)) : sql`${prospectZips.priority}`,
          notes: sql`COALESCE(EXCLUDED.notes, ${prospectZips.notes})`,
          active: true,
          updatedAt: sql`NOW()`,
        },
      })
      .returning();
    return { zip: row };
  }
  const [row] = await db
    .update(prospectZips)
    .set({ active: action === "activate", updatedAt: sql`NOW()` })
    .where(eq(prospectZips.zip5, z))
    .returning();
  if (!row) throw new Error(`Zip ${z} is not in the target list`);
  return { zip: row };
}

// ---------------------------------------------------------------------------
// CRM export — the VistaCRM-facing feed
// ---------------------------------------------------------------------------

export interface CrmExportArgs extends ProspectSearchArgs {
  markSynced?: boolean;
  vistacrmContactIds?: Record<string, string>; // prospect id -> CRM contact id (ack from VistaCRM)
  actor?: string;
}

/**
 * Filtered, CRM-shaped payload. Defaults to contactable people in target
 * zips that VistaCRM has not seen (or that changed since it last did), so a
 * VistaCRM puller can call it on a schedule with no arguments. Pass
 * markSynced=true once VistaCRM has committed the batch; pass
 * vistacrmContactIds to write the CRM's ids back so the link is two-way.
 */
export async function prospectsExportCrm(args: CrmExportArgs = {}) {
  if (!isDbReady()) return { contacts: [], total: 0, dbReady: false };
  const search: ProspectSearchArgs = {
    excludeDoNotContact: true,
    notSyncedToCrm: args.notSyncedToCrm ?? true,
    sortBy: "updated_at",
    sortDir: "asc",
    limit: Math.min(Number(args.limit ?? 500), 2000),
    ...args,
  };
  delete (search as any).markSynced;
  delete (search as any).vistacrmContactIds;
  delete (search as any).actor;
  const result = await prospectsSearch(search);

  const contacts = result.rows.map((r) => ({
    externalId: `vistaintel:prospect:${r.id}`,
    prospectId: r.id,
    householdExternalId: r.householdId ? `vistaintel:household:${r.householdId}` : null,
    vistacrmContactId: r.crm.vistacrmContactId,
    firstName: r.name.first,
    middleName: r.name.middle,
    lastName: r.name.last,
    suffix: r.name.suffix,
    fullName: r.name.full,
    email: r.consent.contactableByEmail ? r.email : null,
    emailOnFile: r.email,
    emailOptIn: r.emailOptIn,
    phone: r.consent.doNotCall ? null : r.phone,
    mobile: r.consent.doNotCall ? null : r.phoneMobile,
    address: r.consent.doNotMail ? null : r.address,
    zip5: r.address.zip5,
    consent: r.consent,
    profile: r.profile,
    wealth: r.wealth,
    lead: r.lead,
    tags: r.tags,
    notes: r.notes,
    source: r.provenance.source,
    sourceDetail: r.provenance.sourceDetail,
    acquiredAt: r.provenance.acquiredAt,
    updatedAt: r.updatedAt,
  }));

  let marked = 0;
  if (args.vistacrmContactIds && typeof args.vistacrmContactIds === "object") {
    for (const [pid, cid] of Object.entries(args.vistacrmContactIds)) {
      const res = await db
        .update(prospects)
        .set({ vistacrmContactId: String(cid), crmSyncedAt: sql`NOW()` })
        .where(eq(prospects.id, Number(pid)))
        .returning({ id: prospects.id });
      marked += res.length;
    }
  } else if (args.markSynced && contacts.length) {
    const ids = contacts.map((c) => c.prospectId);
    const res = await db.update(prospects).set({ crmSyncedAt: sql`NOW()` }).where(inArray(prospects.id, ids)).returning({ id: prospects.id });
    marked = res.length;
    await db.insert(prospectEvents).values(ids.map((id) => ({ prospectId: id, kind: "crm_push", detail: "exported to VistaCRM", actor: args.actor ?? null })));
  }

  return {
    generatedAt: new Date().toISOString(),
    total: result.total,
    returned: contacts.length,
    filters: search,
    markedSynced: marked,
    contacts,
    dbReady: true,
  };
}

// ---------------------------------------------------------------------------
// Imports ledger
// ---------------------------------------------------------------------------

export async function prospectImportsList(args: { limit?: number } = {}) {
  if (!isDbReady()) return { imports: [], dbReady: false };
  const rows = await db
    .select()
    .from(prospectImports)
    .orderBy(desc(prospectImports.startedAt))
    .limit(Math.min(Number(args.limit ?? 25), 200));
  return { imports: rows, dbReady: true };
}
