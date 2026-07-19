/**
 * VistaCRM — the Vistamark identity hub. VistaIntel is a spoke: per
 * vistamark-crm/docs/ACCESS.md, callers are authorized by resolving their
 * Entra identity (oid / preferred_username claim) against VistaCRM's
 * `principals` table and enforcing active + can_read.
 *
 * Live path: read-only Postgres lookup via VISTACRM_DATABASE_URL
 * (role `vistaintel_ro`, SELECT on principals only).
 *
 * Bootstrap path: until that env var lands, the five principals documented
 * in vistamark-crm/docs/ACCESS.md (recorded 2026-07-14) act as a fallback
 * so sign-in works on day one. Same people, same Entra OIDs — and the CRM
 * table becomes the live source of truth the moment the connection string
 * is configured. No Wealthbox anywhere in this path.
 */
import { Client } from "pg";

export interface CrmPrincipal {
  id: string;
  entraOid: string | null;
  upn: string;
  displayName: string;
  kind: string;
  canRead: boolean;
  canWrite: boolean;
  active: boolean;
  source: "vistacrm" | "fallback";
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Seeded verbatim from vistamark-crm docs/ACCESS.md + db/schema.sql
// (identity ids 1–5 follow the schema's insertion order).
const FALLBACK_PRINCIPALS: ReadonlyArray<Omit<CrmPrincipal, "source">> = [
  { id: "1", entraOid: "5d9dc8c2-4575-41c2-ac1c-01989b03a11c", upn: "rstephens@vistamarkllc.com", displayName: "Randall Stephens", kind: "service", canRead: true, canWrite: true, active: true },
  { id: "2", entraOid: "ff11124e-e1f4-4018-b931-008822e05306", upn: "mrice@vistamarkllc.com", displayName: "Matt Rice", kind: "partner", canRead: true, canWrite: true, active: true },
  { id: "3", entraOid: "6e5591cb-9766-446c-9ffb-59c33c73beb0", upn: "smcevilly@vistamarkllc.com", displayName: "Sean McEvilly", kind: "partner", canRead: true, canWrite: true, active: true },
  { id: "4", entraOid: "fd34f785-3ae6-470a-8e97-b4222ade318d", upn: "rwalter@vistamarkllc.com", displayName: "Ryan Walter", kind: "partner", canRead: true, canWrite: true, active: true },
  { id: "5", entraOid: "f479ac65-7b5b-433e-966e-51bf2fa4fcd2", upn: "wseyfarth@vistamarkllc.com", displayName: "Bill Seyfarth", kind: "partner", canRead: true, canWrite: true, active: true },
];

interface PrincipalRow {
  id: string;
  entra_oid: string | null;
  upn: string;
  display_name: string;
  kind: string;
  can_read: boolean;
  can_write: boolean;
  active: boolean;
}

/** Resolve an Entra identity to a VistaCRM principal, or null if unknown. */
export async function resolvePrincipal(oid: string, upn: string): Promise<CrmPrincipal | null> {
  const url = process.env.VISTACRM_DATABASE_URL;
  const cleanOid = UUID_RE.test(oid) ? oid.toLowerCase() : null;
  const cleanUpn = upn.trim().toLowerCase();

  if (!url) {
    const hit = FALLBACK_PRINCIPALS.find(
      (p) => (cleanOid !== null && p.entraOid === cleanOid) || p.upn === cleanUpn
    );
    return hit ? { ...hit, source: "fallback" } : null;
  }

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 6000,
    query_timeout: 6000,
  });
  await client.connect();
  try {
    const r = await client.query<PrincipalRow>(
      `select id::text as id,
              entra_oid::text as entra_oid,
              upn::text as upn,
              display_name, kind, can_read, can_write, active
         from principals
        where ($1::uuid is not null and entra_oid = $1::uuid)
           or lower(upn::text) = $2
        limit 1`,
      [cleanOid, cleanUpn]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      entraOid: row.entra_oid,
      upn: row.upn,
      displayName: row.display_name,
      kind: row.kind,
      canRead: row.can_read,
      canWrite: row.can_write,
      active: row.active,
      source: "vistacrm",
    };
  } finally {
    await client.end();
  }
}
