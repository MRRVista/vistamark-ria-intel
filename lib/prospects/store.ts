/**
 * Prospect write path: batch upsert of households + people with merge
 * semantics, plus the import ledger.
 *
 * WHY BATCHED SQL AND NOT ROW-AT-A-TIME
 * ------------------------------------
 * The Neon HTTP driver costs one round trip per statement and cannot open an
 * interactive transaction, so a 5,000-row list written naively (3 statements
 * per row) would take minutes and blow Vercel's function budget. Instead each
 * import is: one SELECT to find email matches, N/400 multi-row INSERT ... ON
 * CONFLICT statements for households, the same for people. Tens of thousands
 * of rows finish in seconds.
 *
 * MERGE RULES (existing row vs. incoming record)
 * ----------------------------------------------
 *   most columns        incoming non-null wins, else keep existing
 *   do_not_*            OR — once someone opts out, an import cannot opt them in
 *   email_opt_in        incoming non-null wins (explicit consent change)
 *   lead_status         an import never demotes a worked lead back to 'new'
 *   tags                set union
 *   notes               appended when new text isn't already present
 *   wealth_signals      jsonb shallow merge (incoming keys win)
 *   source/import_id    first-seen provenance is preserved
 */
import { inArray, sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { prospectHouseholds, prospectImports, prospects, prospectZips } from "../db/schema";
import {
  inferColumnMap,
  normalizeProspect,
  rowToInput,
  type NameOrder,
  type NormalizedProspect,
  type ProspectInput,
} from "./normalize";
import type { Table } from "./tabular";

const CHUNK = 400;

export interface ImportOptions {
  via: "csv" | "xlsx" | "json" | "mcp" | "crm" | "form";
  source: string;
  sourceDetail?: string | null;
  filename?: string | null;
  submittedBy?: string | null;
  /** Skip rows whose zip is not an ACTIVE row in prospect_zips. */
  restrictZips?: boolean;
  /** Normalize, map, count, and match — but write nothing. */
  dryRun?: boolean;
  /** Applied to rows with no zip of their own (single-zip lists often omit it). */
  defaultZip?: string | null;
  /** Header (or header token) → ProspectInput field overrides for tabular imports. */
  columnMap?: Record<string, string>;
  /** Extra tags applied to every record in the batch. */
  tags?: string[];
  /** How to read a single full-name column: auto (default), first-last, or last-first (assessor/voter files). */
  nameOrder?: NameOrder;
}

export interface ImportSummary {
  ok: boolean;
  importId: number | null;
  dryRun: boolean;
  via: string;
  source: string;
  rowsReceived: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsRejected: number;
  householdsTouched: number;
  zipCounts: Record<string, number>;
  outOfTargetZips: Record<string, number>;
  columnMap?: Record<string, string>;
  unmappedColumns?: string[];
  rejected: Array<{ row: number; error: string }>;
  sample?: Array<Pick<NormalizedProspect, "fullName" | "email" | "addressLine1" | "zip5" | "personKey">>;
  ids?: number[];
  message?: string;
}

/** Tabular (CSV/XLSX) entry point. */
export async function importTable(table: Table, opts: ImportOptions): Promise<ImportSummary> {
  const { map, unmapped } = inferColumnMap(table.headers, opts.columnMap ?? {});
  const mappedFields = new Set(Object.values(map));
  const hasName = mappedFields.has("fullName") || mappedFields.has("lastName") || mappedFields.has("firstName");
  if (!hasName && !mappedFields.has("email")) {
    throw new Error(
      `Could not find a name or email column. Headers seen: ${table.headers.join(", ")}. ` +
        `Pass columnMap, e.g. {"Owner Nm": "fullName", "Situs Zip": "zip"}.`
    );
  }
  if (!mappedFields.has("zip") && !mappedFields.has("zip5") && !opts.defaultZip) {
    throw new Error(
      `No zip column found and no defaultZip given. Headers seen: ${table.headers.join(", ")}.`
    );
  }
  const inputs = table.rows.map((r) => rowToInput(r, map));
  const summary = await importRecords(inputs, opts);
  summary.columnMap = Object.fromEntries(Object.entries(map).map(([h, f]) => [h, String(f)]));
  summary.unmappedColumns = unmapped;
  return summary;
}

/** JSON / MCP entry point. */
export async function importRecords(inputs: ProspectInput[], opts: ImportOptions): Promise<ImportSummary> {
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");

  const summary: ImportSummary = {
    ok: true,
    importId: null,
    dryRun: !!opts.dryRun,
    via: opts.via,
    source: opts.source,
    rowsReceived: inputs.length,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsRejected: 0,
    householdsTouched: 0,
    zipCounts: {},
    outOfTargetZips: {},
    rejected: [],
  };

  // --- 1. Normalize + in-batch dedupe --------------------------------------
  const byKey = new Map<string, NormalizedProspect>();
  const keyByEmail = new Map<string, string>();
  inputs.forEach((raw, i) => {
    let n: NormalizedProspect;
    try {
      n = normalizeProspect(
        { ...raw, tags: mergeTags(raw.tags, opts.tags) },
        { defaultSource: opts.source, defaultSourceDetail: opts.sourceDetail ?? null, defaultZip: opts.defaultZip ?? null, nameOrder: opts.nameOrder ?? "auto" }
      );
    } catch (e: any) {
      summary.rowsRejected++;
      if (summary.rejected.length < 200) summary.rejected.push({ row: i + 1, error: e?.message ?? String(e) });
      return;
    }
    // Same email seen earlier in this batch under a different key -> same person.
    const priorKey = n.emailNormalized ? keyByEmail.get(n.emailNormalized) : undefined;
    const key = priorKey ?? n.personKey;
    const existing = byKey.get(key);
    byKey.set(key, existing ? mergeNormalized(existing, { ...n, personKey: key }) : { ...n, personKey: key });
    if (n.emailNormalized && !priorKey) keyByEmail.set(n.emailNormalized, key);
  });

  // --- 2. Zip gating -------------------------------------------------------
  let targetZips: Set<string> | null = null;
  if (opts.restrictZips) {
    const rows = await db.select({ zip5: prospectZips.zip5 }).from(prospectZips).where(sql`${prospectZips.active} = true`);
    targetZips = new Set(rows.map((r) => r.zip5));
  }
  const records: NormalizedProspect[] = [];
  for (const n of byKey.values()) {
    summary.zipCounts[n.zip5] = (summary.zipCounts[n.zip5] ?? 0) + 1;
    if (targetZips && !targetZips.has(n.zip5)) {
      summary.outOfTargetZips[n.zip5] = (summary.outOfTargetZips[n.zip5] ?? 0) + 1;
      summary.rowsSkipped++;
      continue;
    }
    records.push(n);
  }
  summary.sample = records.slice(0, 5).map((r) => ({
    fullName: r.fullName,
    email: r.email,
    addressLine1: r.addressLine1,
    zip5: r.zip5,
    personKey: r.personKey,
  }));

  // --- 3. Reconcile against existing rows by email --------------------------
  // A record whose email already belongs to a row with a different person_key
  // must target THAT row (address spelled differently, or no address before).
  const emails = Array.from(new Set(records.map((r) => r.emailNormalized).filter((e): e is string => !!e)));
  const existingKeyByEmail = new Map<string, string>();
  for (const chunk of chunks(emails, 1000)) {
    const rows = await db
      .select({ personKey: prospects.personKey, emailNormalized: prospects.emailNormalized })
      .from(prospects)
      .where(inArray(prospects.emailNormalized, chunk));
    for (const r of rows) if (r.emailNormalized && !existingKeyByEmail.has(r.emailNormalized)) existingKeyByEmail.set(r.emailNormalized, r.personKey);
  }
  const finalByKey = new Map<string, NormalizedProspect>();
  for (const r of records) {
    const target = (r.emailNormalized && existingKeyByEmail.get(r.emailNormalized)) || r.personKey;
    const prev = finalByKey.get(target);
    finalByKey.set(target, prev ? mergeNormalized(prev, { ...r, personKey: target }) : { ...r, personKey: target });
  }
  const finalRecords = Array.from(finalByKey.values());

  // --- 4. Dry run: estimate insert/update split and stop --------------------
  if (opts.dryRun) {
    const keys = finalRecords.map((r) => r.personKey);
    let existing = 0;
    for (const chunk of chunks(keys, 1000)) {
      const rows = await db.select({ k: prospects.personKey }).from(prospects).where(inArray(prospects.personKey, chunk));
      existing += rows.length;
    }
    summary.rowsUpdated = existing;
    summary.rowsInserted = finalRecords.length - existing;
    summary.householdsTouched = new Set(finalRecords.map((r) => r.addressKey).filter(Boolean)).size;
    return summary;
  }

  // Nothing survived normalization / zip gating: no ledger row, report why.
  if (!finalRecords.length) {
    summary.ok = summary.rowsRejected === 0;
    summary.message =
      summary.rowsRejected > 0
        ? `All ${summary.rowsRejected} row(s) were rejected — see \`rejected\` (first error: ${summary.rejected[0]?.error ?? "n/a"})`
        : "Nothing to import: every row was skipped by restrictZips";
    return summary;
  }

  // --- 5. Import ledger row -------------------------------------------------
  const [imp] = await db
    .insert(prospectImports)
    .values({
      via: opts.via,
      source: opts.source,
      sourceDetail: opts.sourceDetail ?? null,
      filename: opts.filename ?? null,
      submittedBy: opts.submittedBy ?? null,
      restrictZips: !!opts.restrictZips,
      dryRun: false,
      rowsReceived: inputs.length,
      columnMap: opts.columnMap ?? null,
      status: "running",
    })
    .returning({ id: prospectImports.id });
  summary.importId = imp.id;

  try {
    // --- 6. Households ------------------------------------------------------
    const hhByKey = new Map<string, NormalizedProspect>();
    for (const r of finalRecords) {
      if (!r.addressKey) continue;
      const prev = hhByKey.get(r.addressKey);
      hhByKey.set(r.addressKey, prev ? mergeNormalized(prev, r) : r);
    }
    const householdIdByKey = new Map<string, number>();
    for (const chunk of chunks(Array.from(hhByKey.values()), CHUNK)) {
      const rows = await db
        .insert(prospectHouseholds)
        .values(
          chunk.map((r) => ({
            addressKey: r.addressKey!,
            addressLine1: r.addressLine1!,
            addressLine2: r.addressLine2,
            city: r.city,
            state: r.state,
            zip5: r.zip5,
            zip4: r.zip4,
            county: r.county,
            householdName: r.household.householdName ?? (r.lastName ? `The ${r.lastName} Household` : null),
            homeValue: r.household.homeValue,
            homeValueSource: r.household.homeValueSource,
            homeValueAsOf: r.household.homeValueAsOf,
            yearBuilt: r.household.yearBuilt,
            sqFt: r.household.sqFt,
            lotAcres: r.household.lotAcres == null ? null : String(r.household.lotAcres),
            ownerOccupied: r.household.ownerOccupied,
            purchaseDate: r.household.purchaseDate,
            purchasePrice: r.household.purchasePrice,
            estHouseholdIncome: r.household.estHouseholdIncome,
            estNetWorthBand: r.estNetWorthBand,
            householdSize: r.household.householdSize,
            tags: r.tags,
          }))
        )
        .onConflictDoUpdate({
          target: prospectHouseholds.addressKey,
          set: {
            addressLine2: keep(prospectHouseholds.addressLine2),
            city: keep(prospectHouseholds.city),
            state: keep(prospectHouseholds.state),
            zip4: keep(prospectHouseholds.zip4),
            county: keep(prospectHouseholds.county),
            householdName: sql`COALESCE(${prospectHouseholds.householdName}, EXCLUDED.household_name)`,
            homeValue: keep(prospectHouseholds.homeValue),
            homeValueSource: sql`CASE WHEN EXCLUDED.home_value IS NULL THEN ${prospectHouseholds.homeValueSource} ELSE COALESCE(EXCLUDED.home_value_source, ${prospectHouseholds.homeValueSource}) END`,
            homeValueAsOf: sql`CASE WHEN EXCLUDED.home_value IS NULL THEN ${prospectHouseholds.homeValueAsOf} ELSE COALESCE(EXCLUDED.home_value_as_of, ${prospectHouseholds.homeValueAsOf}) END`,
            yearBuilt: keep(prospectHouseholds.yearBuilt),
            sqFt: keep(prospectHouseholds.sqFt),
            lotAcres: keep(prospectHouseholds.lotAcres),
            ownerOccupied: keep(prospectHouseholds.ownerOccupied),
            purchaseDate: keep(prospectHouseholds.purchaseDate),
            purchasePrice: keep(prospectHouseholds.purchasePrice),
            estHouseholdIncome: keep(prospectHouseholds.estHouseholdIncome),
            estNetWorthBand: keep(prospectHouseholds.estNetWorthBand),
            householdSize: keep(prospectHouseholds.householdSize),
            tags: unionTags(prospectHouseholds.tags),
            updatedAt: sql`NOW()`,
          },
        })
        .returning({ id: prospectHouseholds.id, addressKey: prospectHouseholds.addressKey });
      for (const row of rows) householdIdByKey.set(row.addressKey, row.id);
    }
    summary.householdsTouched = householdIdByKey.size;

    // --- 7. People ----------------------------------------------------------
    const ids: number[] = [];
    for (const chunk of chunks(finalRecords, CHUNK)) {
      const rows = await db
        .insert(prospects)
        .values(
          chunk.map((r) => ({
            householdId: r.addressKey ? householdIdByKey.get(r.addressKey) ?? null : null,
            personKey: r.personKey,
            firstName: r.firstName,
            middleName: r.middleName,
            lastName: r.lastName,
            suffix: r.suffix,
            fullName: r.fullName,
            email: r.email,
            emailNormalized: r.emailNormalized,
            emailStatus: r.email ? (r.emailNormalized ? "unverified" : "invalid") : "unknown",
            emailOptIn: r.emailOptIn,
            optInAt: r.emailOptIn ? sql`NOW()` : null,
            optInSource: r.emailOptIn ? r.optInSource ?? r.source : r.optInSource,
            doNotContact: r.doNotContact ?? false,
            doNotEmail: r.doNotEmail ?? false,
            doNotCall: r.doNotCall ?? false,
            doNotMail: r.doNotMail ?? false,
            phone: r.phone,
            phoneMobile: r.phoneMobile,
            addressLine1: r.addressLine1,
            addressLine2: r.addressLine2,
            city: r.city,
            state: r.state,
            zip5: r.zip5,
            zip4: r.zip4,
            ageBand: r.ageBand,
            birthYear: r.birthYear,
            occupation: r.occupation,
            employer: r.employer,
            title: r.title,
            industry: r.industry,
            linkedinUrl: r.linkedinUrl,
            estNetWorthBand: r.estNetWorthBand,
            estInvestableAssets: r.estInvestableAssets,
            estIncomeBand: r.estIncomeBand,
            isBusinessOwner: r.isBusinessOwner,
            isExecutive: r.isExecutive,
            hasTrust: r.hasTrust,
            wealthSignals: r.wealthSignals,
            leadScore: r.leadScore,
            leadStatus: r.leadStatus ?? "new",
            source: r.source,
            sourceDetail: r.sourceDetail,
            sourceRecordId: r.sourceRecordId,
            acquiredAt: r.acquiredAt ?? sql`CURRENT_DATE`,
            importId: imp.id,
            tags: r.tags,
            notes: r.notes,
            raw: r.raw,
          }))
        )
        .onConflictDoUpdate({
          target: prospects.personKey,
          set: {
            householdId: keep(prospects.householdId),
            firstName: keep(prospects.firstName),
            middleName: keep(prospects.middleName),
            lastName: keep(prospects.lastName),
            suffix: keep(prospects.suffix),
            // Longer = more complete ("John A Smith" beats "John Smith"); never replace a name with the placeholder.
            fullName: sql`CASE WHEN EXCLUDED.full_name = '(unknown)' OR length(EXCLUDED.full_name) < length(${prospects.fullName}) THEN ${prospects.fullName} ELSE EXCLUDED.full_name END`,
            email: keep(prospects.email),
            emailNormalized: keep(prospects.emailNormalized),
            emailStatus: sql`CASE WHEN EXCLUDED.email_normalized IS NOT NULL AND EXCLUDED.email_normalized IS DISTINCT FROM ${prospects.emailNormalized} THEN EXCLUDED.email_status ELSE ${prospects.emailStatus} END`,
            emailOptIn: keep(prospects.emailOptIn),
            optInAt: sql`CASE WHEN EXCLUDED.email_opt_in IS NOT NULL AND EXCLUDED.email_opt_in IS DISTINCT FROM ${prospects.emailOptIn} THEN NOW() ELSE ${prospects.optInAt} END`,
            optInSource: sql`CASE WHEN EXCLUDED.email_opt_in IS NOT NULL AND EXCLUDED.email_opt_in IS DISTINCT FROM ${prospects.emailOptIn} THEN EXCLUDED.opt_in_source ELSE ${prospects.optInSource} END`,
            doNotContact: sql`${prospects.doNotContact} OR EXCLUDED.do_not_contact`,
            doNotEmail: sql`${prospects.doNotEmail} OR EXCLUDED.do_not_email`,
            doNotCall: sql`${prospects.doNotCall} OR EXCLUDED.do_not_call`,
            doNotMail: sql`${prospects.doNotMail} OR EXCLUDED.do_not_mail`,
            phone: keep(prospects.phone),
            phoneMobile: keep(prospects.phoneMobile),
            addressLine1: keep(prospects.addressLine1),
            addressLine2: keep(prospects.addressLine2),
            city: keep(prospects.city),
            state: keep(prospects.state),
            zip5: sql`EXCLUDED.zip5`,
            zip4: keep(prospects.zip4),
            ageBand: keep(prospects.ageBand),
            birthYear: keep(prospects.birthYear),
            occupation: keep(prospects.occupation),
            employer: keep(prospects.employer),
            title: keep(prospects.title),
            industry: keep(prospects.industry),
            linkedinUrl: keep(prospects.linkedinUrl),
            estNetWorthBand: keep(prospects.estNetWorthBand),
            estInvestableAssets: keep(prospects.estInvestableAssets),
            estIncomeBand: keep(prospects.estIncomeBand),
            isBusinessOwner: keep(prospects.isBusinessOwner),
            isExecutive: keep(prospects.isExecutive),
            hasTrust: keep(prospects.hasTrust),
            wealthSignals: sql`${prospects.wealthSignals} || EXCLUDED.wealth_signals`,
            leadScore: keep(prospects.leadScore),
            leadStatus: sql`CASE WHEN EXCLUDED.lead_status = 'new' THEN ${prospects.leadStatus} ELSE EXCLUDED.lead_status END`,
            sourceDetail: sql`COALESCE(${prospects.sourceDetail}, EXCLUDED.source_detail)`,
            sourceRecordId: keep(prospects.sourceRecordId),
            tags: unionTags(prospects.tags),
            notes: sql`CASE WHEN EXCLUDED.notes IS NULL THEN ${prospects.notes} WHEN ${prospects.notes} IS NULL THEN EXCLUDED.notes WHEN position(EXCLUDED.notes in ${prospects.notes}) > 0 THEN ${prospects.notes} ELSE ${prospects.notes} || E'\n' || EXCLUDED.notes END`,
            raw: keep(prospects.raw),
            updatedAt: sql`NOW()`,
          },
        })
        .returning({ id: prospects.id, inserted: sql<boolean>`(xmax = 0)` });
      for (const row of rows) {
        ids.push(row.id);
        if (row.inserted) summary.rowsInserted++;
        else summary.rowsUpdated++;
      }
    }
    summary.ids = ids.length <= 500 ? ids : undefined;

    await db
      .update(prospectImports)
      .set({
        finishedAt: sql`NOW()`,
        rowsInserted: summary.rowsInserted,
        rowsUpdated: summary.rowsUpdated,
        rowsSkipped: summary.rowsSkipped,
        rowsRejected: summary.rowsRejected,
        zipCounts: summary.zipCounts,
        errors: summary.rejected.slice(0, 50),
        status: "done",
      })
      .where(sql`${prospectImports.id} = ${imp.id}`);
  } catch (e: any) {
    summary.ok = false;
    await db
      .update(prospectImports)
      .set({ finishedAt: sql`NOW()`, status: "failed", errors: [{ row: 0, error: e?.message ?? String(e) }] })
      .where(sql`${prospectImports.id} = ${imp.id}`);
    throw e;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** "incoming non-null wins, else keep existing" for an ON CONFLICT set clause. */
function keep(col: any) {
  return sql`COALESCE(EXCLUDED.${sql.identifier(col.name)}, ${col})`;
}

function unionTags(col: any) {
  return sql`(SELECT ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(${col}, '{}'::text[]) || COALESCE(EXCLUDED.${sql.identifier(col.name)}, '{}'::text[])) AS t ORDER BY t))`;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mergeTags(a: unknown, b?: string[] | null): string[] | null {
  const list: string[] = [];
  if (Array.isArray(a)) list.push(...a.map(String));
  else if (typeof a === "string") list.push(...a.split(/[;,|]/));
  if (b) list.push(...b);
  const out = Array.from(new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean)));
  return out.length ? out : null;
}

/** In-memory merge of two normalized records for the same person (later non-null wins). */
export function mergeNormalized(a: NormalizedProspect, b: NormalizedProspect): NormalizedProspect {
  const pick = <T>(x: T | null, y: T | null): T | null => (y != null ? y : x);
  const out: any = { ...a };
  for (const k of Object.keys(b) as Array<keyof NormalizedProspect>) {
    if (k === "household" || k === "wealthSignals" || k === "tags" || k === "notes" || k === "raw" || k === "personKey") continue;
    out[k] = pick((a as any)[k], (b as any)[k]);
  }
  out.personKey = a.personKey;
  out.household = Object.fromEntries(
    Object.keys(a.household).map((k) => [k, pick((a.household as any)[k], (b.household as any)[k])])
  );
  out.wealthSignals = { ...a.wealthSignals, ...b.wealthSignals };
  out.tags = mergeTags(a.tags, b.tags);
  out.notes = a.notes && b.notes && a.notes !== b.notes ? `${a.notes}\n${b.notes}` : b.notes ?? a.notes;
  out.raw = a.raw || b.raw ? { ...(a.raw ?? {}), ...(b.raw ?? {}) } : null;
  // consent flags: OR
  for (const f of ["doNotContact", "doNotEmail", "doNotCall", "doNotMail"] as const) out[f] = a[f] || b[f] ? true : a[f] ?? b[f];
  return out as NormalizedProspect;
}
