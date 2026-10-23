/**
 * Query handlers for the IRS EO extras family (Pub 78 / Auto-Revocation / 990-N).
 *
 * All read the tables from migrations/0011_irs_eo_extras.sql, loaded by
 * scripts/irs-eo-extras-ingest.ts. Every query is guarded with to_regclass so
 * the tools answer clean-empty (tableReady:false) before the migration lands
 * or before the first load, instead of throwing "relation does not exist".
 *
 * 990-N officer street address (officer_address1/2) is stored but never
 * selected here — officer city/state/zip only.
 */

import { sql } from "drizzle-orm";
import { db, isDbReady } from "../db";
import { SUBSECTION_LABEL } from "../irs-bmf/columns";

export const SOURCE = "IRS TEOS bulk downloads (apps.irs.gov/pub/epostcard/data-download-{pub78,revocation,epostcard}.zip)";

/** Publication 78 deductibility codes — https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads */
export const PUB78_CODES: Record<string, { label: string; limit: string }> = {
  PC: { label: "Public charity", limit: "50% of AGI (60% for cash gifts)" },
  POF: { label: "Private operating foundation", limit: "50% of AGI (60% for cash gifts)" },
  PF: { label: "Private foundation", limit: "30% of AGI (generally)" },
  GROUP: { label: "Group exemption — subordinates covered; check the central org", limit: "varies by subordinate type" },
  LODGE: { label: "Domestic fraternal society (lodge) — deductible only for charitable purposes", limit: "30% of AGI" },
  UNKWN: { label: "Charitable status not yet determined", limit: "contact the organization" },
  EO: { label: "Organization described in IRC 170(c) other than 501(c)(3) (e.g. veterans, cemetery, governmental unit)", limit: "30% of AGI (generally)" },
  FORGN: { label: "Foreign-addressed organization — deductibility may be limited by treaty", limit: "see treaty (Canada / Mexico / Israel)" },
  SO: { label: "Type I, II or functionally integrated Type III supporting organization (509(a)(3))", limit: "50% of AGI; not a DAF-eligible grantee from most sponsors" },
  SONFI: { label: "Type III non-functionally integrated supporting organization", limit: "50% of AGI; excluded from most DAF / PF grants" },
  SOUNK: { label: "Supporting organization, type unspecified", limit: "50% of AGI; verify type before PF / DAF grants" },
};

const EIN_NOTE = "EIN as 9 digits or 'XX-XXXXXXX'.";

function cleanEin(ein: string | number): string {
  const d = String(ein).replace(/\D/g, "").padStart(9, "0");
  if (d.length !== 9) throw new Error(`Invalid EIN: ${ein}`);
  return d;
}
function rows<T = any>(r: any): T[] {
  return (r?.rows ?? r ?? []) as T[];
}
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = num(v);
  return Math.min(Math.max(Math.trunc(n ?? def), min), max);
}
function st(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s.length === 2 ? s : null;
}
function zip5(v: unknown): string | null {
  const s = typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "";
  return s.length >= 5 ? s.slice(0, 5) : null;
}
function isoDate(v: unknown, arg: string): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`${arg}: use YYYY, YYYY-MM or YYYY-MM-DD (got '${s}')`);
}

export function decodePub78(codes: string | null | undefined) {
  const list = (codes ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  return list.map((code) => ({ code, ...(PUB78_CODES[code] ?? { label: "Unrecognized code", limit: "unknown" }) }));
}

async function ready(table: string): Promise<boolean> {
  const r = rows(await db.execute(sql`SELECT to_regclass(${"public." + table}) AS r`));
  return r[0]?.r != null;
}

// ---------------------------------------------------------------------------
// irs_pub78_lookup
// ---------------------------------------------------------------------------

export interface Pub78LookupArgs {
  ein?: string | number;
  name?: string;
  state?: string;
  city?: string;
  limit?: number;
}

export async function irsPub78Lookup(args: Pub78LookupArgs) {
  if (!isDbReady()) return { source: SOURCE, dbReady: false, tableReady: false, results: [] };
  if (!(await ready("irs_pub78"))) return { source: SOURCE, dbReady: true, tableReady: false, results: [], note: "irs_pub78 not loaded yet (migration 0011 + 'IRS EO extras ingest' workflow)." };
  if (args.ein == null && !args.name) throw new Error(`irs_pub78_lookup requires \`ein\` or \`name\` (+ state). ${EIN_NOTE}`);
  const limit = clampInt(args.limit, 10, 1, 25);
  const SELECT = sql`p.ein, p.name, p.city, p.state, p.country, p.deductibility_codes AS "codes", p.loaded_at AS "loadedAt"`;
  let found: any[];
  let matchedBy: string;
  if (args.ein != null) {
    const ein = cleanEin(args.ein);
    found = rows(await db.execute(sql`SELECT ${SELECT} FROM irs_pub78 p WHERE p.ein = ${ein}`));
    matchedBy = "ein";
    if (!found.length) {
      // Say WHY it is missing when we can: revoked? 990-N filer? in the BMF at all?
      const rev = (await ready("irs_eo_revocations"))
        ? rows(await db.execute(sql`SELECT revocation_date::text AS "revocationDate", reinstatement_date::text AS "reinstatementDate" FROM irs_eo_revocations WHERE ein = ${ein} ORDER BY revocation_date DESC LIMIT 1`))
        : [];
      const n990 = (await ready("irs_990n"))
        ? rows(await db.execute(sql`SELECT tax_year AS "taxYear", name FROM irs_990n WHERE ein = ${ein} ORDER BY tax_year DESC LIMIT 1`))
        : [];
      const bmf = (await ready("nonprofits"))
        ? rows(await db.execute(sql`SELECT name, subsection, deductibility FROM nonprofits WHERE ein = ${ein}`))
        : [];
      return {
        source: SOURCE,
        dbReady: true,
        tableReady: true,
        ein,
        eligible: false,
        results: [],
        context: { latestRevocation: rev[0] ?? null, latest990N: n990[0] ?? null, bmf: bmf[0] ?? null },
        note: "Not in Publication 78 — the IRS does not currently list this EIN as eligible to receive tax-deductible contributions. Common reasons: not a 170(c) org (e.g. 501(c)(4)/(6)), auto-revoked (see context.latestRevocation), a church / government unit that need not apply, or a subordinate covered by a group ruling (search the parent).",
      };
    }
  } else {
    const conds: any[] = [sql`p.name % ${args.name!}`];
    const s = st(args.state);
    if (s) conds.push(sql`p.state = ${s}`);
    if (args.city) conds.push(sql`p.city ILIKE ${args.city.trim()}`);
    found = rows(await db.execute(sql`
      SELECT ${SELECT}, similarity(p.name, ${args.name!})::float AS score
      FROM irs_pub78 p WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY score DESC, p.name LIMIT ${limit}`));
    matchedBy = "name (trigram)";
    if (!found.length && !s) {
      // retry as a plain substring — short / uncommon names score low on trigram
      found = rows(await db.execute(sql`SELECT ${SELECT} FROM irs_pub78 p WHERE p.name ILIKE ${"%" + args.name!.trim() + "%"} ORDER BY p.name LIMIT ${limit}`));
      matchedBy = "name (substring)";
    }
  }
  return {
    source: SOURCE,
    dbReady: true,
    tableReady: true,
    matchedBy,
    eligible: found.length > 0,
    count: found.length,
    results: found.map((r) => ({
      ein: r.ein, name: r.name, city: r.city, state: r.state, country: r.country,
      codes: r.codes, deductibility: decodePub78(r.codes), ...(r.score != null ? { score: Math.round(r.score * 1000) / 1000 } : {}),
    })),
    asOf: found[0]?.loadedAt ?? null,
    note: "Listed = eligible to receive tax-deductible charitable contributions as of the last monthly IRS file. PC/POF = 50%-limit public charities; PF = 30%-limit private foundation; SO/SONFI/SOUNK = supporting orgs (SONFI excluded from most DAF / private-foundation grants). Cross-check irs_eo_lookup for subsection and foundation code.",
  };
}

// ---------------------------------------------------------------------------
// irs_revocation_search
// ---------------------------------------------------------------------------

export interface RevocationSearchArgs {
  ein?: string | number;
  name?: string;
  state?: string;
  city?: string;
  zip?: string;
  exemptionType?: string | number;
  revokedFrom?: string;
  revokedTo?: string;
  reinstated?: boolean;
  sortBy?: "revocation_date" | "posting_date" | "name";
  limit?: number;
  offset?: number;
}

export async function irsRevocationSearch(args: RevocationSearchArgs) {
  if (!isDbReady()) return { source: SOURCE, dbReady: false, tableReady: false, results: [] };
  if (!(await ready("irs_eo_revocations"))) return { source: SOURCE, dbReady: true, tableReady: false, results: [], note: "irs_eo_revocations not loaded yet (migration 0011 + 'IRS EO extras ingest' workflow)." };
  const limit = clampInt(args.limit, 25, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 100_000);
  const conds: any[] = [];
  if (args.ein != null) conds.push(sql`r.ein = ${cleanEin(args.ein)}`);
  if (args.name) conds.push(sql`r.name % ${args.name.trim()}`);
  const s = st(args.state);
  if (s) conds.push(sql`r.state = ${s}`);
  if (args.city) conds.push(sql`r.city ILIKE ${args.city.trim()}`);
  const z = zip5(args.zip);
  if (z) conds.push(sql`r.zip LIKE ${z + "%"}`);
  if (args.exemptionType != null && args.exemptionType !== "") {
    const code = String(args.exemptionType).replace(/\D/g, "").padStart(2, "0");
    conds.push(sql`r.exemption_type = ${code}`);
  }
  const from = isoDate(args.revokedFrom, "revokedFrom");
  const to = isoDate(args.revokedTo, "revokedTo");
  if (from) conds.push(sql`r.revocation_date >= ${from}::date`);
  if (to) conds.push(sql`r.revocation_date <= ${to}::date`);
  if (args.reinstated === true) conds.push(sql`r.reinstatement_date IS NOT NULL`);
  if (args.reinstated === false) conds.push(sql`r.reinstatement_date IS NULL`);
  if (!conds.length) throw new Error("irs_revocation_search needs at least one filter (ein, name, state, city, zip, exemptionType, revokedFrom/To, reinstated).");
  const where = sql.join(conds, sql` AND `);
  const orderBy =
    args.sortBy === "name" ? sql`r.name ASC` :
    args.sortBy === "posting_date" ? sql`r.posting_date DESC NULLS LAST` :
    args.name ? sql`similarity(r.name, ${args.name.trim()}) DESC, r.revocation_date DESC` :
    sql`r.revocation_date DESC, r.name`;
  const [countRes, listRes] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS total FROM irs_eo_revocations r WHERE ${where}`),
    db.execute(sql`
      SELECT r.ein, r.name, r.dba, r.city, r.state, r.zip, r.country, r.exemption_type AS "exemptionType",
             r.revocation_date::text AS "revocationDate", r.posting_date::text AS "postingDate",
             r.reinstatement_date::text AS "reinstatementDate"
      FROM irs_eo_revocations r WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`),
  ]);
  const list = rows(listRes).map((r) => {
    const sub = Number(r.exemptionType);
    return {
      ...r,
      exemptionLabel: r.exemptionType === "00" ? "unknown / 4947(a)(1) trust" : SUBSECTION_LABEL[sub] ?? (Number.isFinite(sub) ? `501(c)(${sub})` : null),
      reinstated: r.reinstatementDate != null,
    };
  });
  return {
    source: SOURCE,
    dbReady: true,
    tableReady: true,
    total: rows(countRes)[0]?.total ?? 0,
    limit,
    offset,
    results: list,
    note: "Automatic revocation under IRC 6033(j): three consecutive years without a 990 / 990-EZ / 990-N. revocationDate = effective date (usually the 15th of the 5th month after year-end); postingDate = when the IRS published it. reinstated:true means the org later regained exemption (reinstatementDate; often retroactive to the revocation date). A revoked, non-reinstated org cannot receive deductible gifts — check irs_pub78_lookup.",
  };
}

// ---------------------------------------------------------------------------
// irs_990n_search
// ---------------------------------------------------------------------------

const N990_SELECT = sql`
  n.ein, n.tax_year AS "taxYear", n.name, n.gross_receipts_under_50k AS "grossReceiptsUnder50k", n.terminated,
  n.tax_period_begin::text AS "taxPeriodBegin", n.tax_period_end::text AS "taxPeriodEnd", n.website,
  n.officer_name AS "officerName", n.officer_city AS "officerCity", n.officer_state AS "officerState", n.officer_zip AS "officerZip",
  n.org_city AS "orgCity", n.org_state AS "orgState", n.org_zip AS "orgZip", n.dba1, n.dba2`;

export interface N990SearchArgs {
  ein?: string | number;
  name?: string;
  state?: string;
  city?: string;
  zip?: string;
  officerName?: string;
  taxYear?: number;
  minTaxYear?: number;
  includeTerminated?: boolean;
  hasWebsite?: boolean;
  limit?: number;
  offset?: number;
}

export async function irs990nSearch(args: N990SearchArgs) {
  if (!isDbReady()) return { source: SOURCE, dbReady: false, tableReady: false, results: [] };
  if (!(await ready("irs_990n"))) return { source: SOURCE, dbReady: true, tableReady: false, results: [], note: "irs_990n not loaded yet (migration 0011 + 'IRS EO extras ingest' workflow)." };
  const limit = clampInt(args.limit, 25, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 100_000);
  const conds: any[] = [];
  if (args.ein != null) conds.push(sql`n.ein = ${cleanEin(args.ein)}`);
  if (args.name) conds.push(sql`n.name % ${args.name.trim()}`);
  if (args.officerName) conds.push(sql`n.officer_name % ${args.officerName.trim()}`);
  const s = st(args.state);
  if (s) conds.push(sql`n.org_state = ${s}`);
  if (args.city) conds.push(sql`n.org_city ILIKE ${args.city.trim()}`);
  const z = zip5(args.zip);
  if (z) conds.push(sql`n.org_zip LIKE ${z + "%"}`);
  const ty = num(args.taxYear);
  if (ty) conds.push(sql`n.tax_year = ${Math.trunc(ty)}`);
  const mty = num(args.minTaxYear);
  if (mty) conds.push(sql`n.tax_year >= ${Math.trunc(mty)}`);
  if (!args.includeTerminated) conds.push(sql`n.terminated = FALSE`);
  if (args.hasWebsite) conds.push(sql`n.website IS NOT NULL`);
  if (!conds.length) throw new Error("irs_990n_search needs at least one filter (ein, name, officerName, state, city, zip, taxYear).");
  const where = sql.join(conds, sql` AND `);
  const orderBy =
    args.name ? sql`similarity(n.name, ${args.name.trim()}) DESC, n.tax_year DESC` :
    args.officerName ? sql`similarity(n.officer_name, ${args.officerName.trim()}) DESC, n.tax_year DESC` :
    sql`n.tax_year DESC, n.name`;
  const [countRes, listRes] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS total FROM irs_990n n WHERE ${where}`),
    db.execute(sql`SELECT ${N990_SELECT} FROM irs_990n n WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`),
  ]);
  return {
    source: SOURCE,
    dbReady: true,
    tableReady: true,
    total: rows(countRes)[0]?.total ?? 0,
    limit,
    offset,
    results: rows(listRes),
    note: "990-N e-Postcard filers (gross receipts normally <= $50K). The IRS file carries each org's MOST RECENT postcard only, so taxYear tells you when it last filed; terminated filers are excluded unless includeTerminated. officerName is the principal officer the filer named (officer city/state/zip only — street address withheld). For orgs that file full returns use irs990_filing_search.",
  };
}

// ---------------------------------------------------------------------------
// irs_990n_officers_search
// ---------------------------------------------------------------------------

export interface N990OfficersArgs {
  surname?: string;
  name?: string;
  state?: string;
  zip?: string;
  city?: string;
  minTaxYear?: number;
  limit?: number;
  offset?: number;
}

export async function irs990nOfficersSearch(args: N990OfficersArgs) {
  if (!isDbReady()) return { source: SOURCE, dbReady: false, tableReady: false, results: [] };
  if (!(await ready("irs_990n"))) return { source: SOURCE, dbReady: true, tableReady: false, results: [], note: "irs_990n not loaded yet (migration 0011 + 'IRS EO extras ingest' workflow)." };
  const limit = clampInt(args.limit, 25, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 100_000);
  const s = st(args.state);
  const z = zip5(args.zip);
  const surname = typeof args.surname === "string" ? args.surname.trim().replace(/[^A-Za-z' -]/g, "") : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!s && !z) throw new Error("irs_990n_officers_search requires `state` or `zip` — 1.5M officers nationwide, a bare surname is not useful.");
  if (!surname && !name && !z) throw new Error("irs_990n_officers_search needs `surname` or `name` when scoped by state only; a bare zip (5 digits) lists every small-org officer in that zip.");
  const conds: any[] = [sql`n.officer_name IS NOT NULL`, sql`n.terminated = FALSE`];
  // Surname = last whitespace token of the officer name (the file is free text, "First Last" or "First M Last").
  if (surname) conds.push(sql`upper(regexp_replace(n.officer_name, '^.*\\s', '')) = ${surname.toUpperCase()}`);
  if (name) conds.push(sql`n.officer_name % ${name}`);
  if (s) conds.push(sql`(n.officer_state = ${s} OR (n.officer_state IS NULL AND n.org_state = ${s}))`);
  if (z) conds.push(sql`(n.officer_zip LIKE ${z + "%"} OR n.org_zip LIKE ${z + "%"})`);
  if (args.city) conds.push(sql`(n.officer_city ILIKE ${args.city.trim()} OR n.org_city ILIKE ${args.city.trim()})`);
  const mty = num(args.minTaxYear);
  if (mty) conds.push(sql`n.tax_year >= ${Math.trunc(mty)}`);
  const where = sql.join(conds, sql` AND `);
  const orderBy = name ? sql`similarity(n.officer_name, ${name}) DESC, n.tax_year DESC` : sql`n.tax_year DESC, n.officer_name, n.name`;
  const [countRes, listRes] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS total FROM irs_990n n WHERE ${where}`),
    db.execute(sql`
      SELECT ${N990_SELECT}${name ? sql`, similarity(n.officer_name, ${name})::float AS score` : sql``}
      FROM irs_990n n WHERE ${where} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`),
  ]);
  return {
    source: SOURCE,
    dbReady: true,
    tableReady: true,
    query: { surname: surname || null, name: name || null, state: s, zip: z },
    total: rows(countRes)[0]?.total ?? 0,
    limit,
    offset,
    results: rows(listRes),
    note: "Principal officers of 990-N (<= $50K receipts) filers — the small-org counterpart of irs990_people_search (which covers 990/990-EZ/990-PF Part VII). One officer per org per filing; the officer's own zip is usually a home or business mailing address (street withheld). Surname match is on the last token of the free-text name, so 'Van Buren'-style surnames need `name`.",
  };
}

// ---------------------------------------------------------------------------
// irs_eo_extras_status
// ---------------------------------------------------------------------------

export async function irsEoExtrasStatus() {
  if (!isDbReady()) return { source: SOURCE, dbReady: false };
  const tables = { pub78: "irs_pub78", revocation: "irs_eo_revocations", "990n": "irs_990n" } as const;
  const readiness = Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([k, t]) => [k, await ready(t)])));
  const ledgerReady = await ready("irs_eo_extras_loads");
  const counts: Record<string, number | null> = {};
  for (const [k, t] of Object.entries(tables)) {
    counts[k] = readiness[k] ? Number(rows(await db.execute(sql.raw(`SELECT count(*)::bigint AS n FROM ${t}`)))[0]?.n ?? 0) : null;
  }
  const loads = ledgerReady
    ? rows(await db.execute(sql`
        SELECT DISTINCT ON (dataset) dataset, status, started_at AS "startedAt", finished_at AS "finishedAt",
               rows_read AS "rowsRead", rows_loaded AS "rowsLoaded", rows_rejected AS "rowsRejected",
               bytes, source_last_modified AS "sourceLastModified", runner, error_message AS "errorMessage"
        FROM irs_eo_extras_loads ORDER BY dataset, started_at DESC`))
    : [];
  const lastOk = ledgerReady
    ? rows(await db.execute(sql`SELECT dataset, max(finished_at) AS "lastOkAt" FROM irs_eo_extras_loads WHERE status='ok' GROUP BY dataset`))
    : [];
  const extra: Record<string, unknown> = {};
  if (readiness["990n"] && counts["990n"]) {
    extra.n990ByTaxYear = rows(await db.execute(sql`SELECT tax_year AS "taxYear", count(*)::int AS filers FROM irs_990n GROUP BY 1 ORDER BY 1 DESC LIMIT 8`));
  }
  if (readiness.revocation && counts.revocation) {
    extra.revocationsByYear = rows(await db.execute(sql`SELECT extract(year FROM revocation_date)::int AS year, count(*)::int AS revoked, count(reinstatement_date)::int AS reinstated FROM irs_eo_revocations GROUP BY 1 ORDER BY 1 DESC LIMIT 8`));
  }
  return {
    source: SOURCE,
    dbReady: true,
    migrationApplied: ledgerReady,
    tables: Object.fromEntries(Object.entries(tables).map(([k, t]) => [k, { table: t, ready: readiness[k], rows: counts[k], lastOkAt: lastOk.find((r) => r.dataset === k)?.lastOkAt ?? null }])),
    latestLoads: loads,
    ...extra,
    loader: {
      where: "GitHub Actions workflow 'IRS EO extras ingest' (.github/workflows/irs-eo-extras-ingest.yml)",
      schedule: "monthly, 10th 09:10 UTC; manual dispatch (datasets / dry / max_rows)",
      semantics: "full refresh per dataset: load into <table>_new, build indexes, swap in one transaction",
    },
  };
}
