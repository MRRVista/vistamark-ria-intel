/**
 * Email append — find an email for a prospect from name + postal address.
 *
 * v0.24.0. Two providers behind one selection and write path:
 *
 *   atdata     AtData Email Append (paid). GET https://api.atdata.com/v5/eppend
 *              with first/last/street/city/state/zip. Each returned email is
 *              tagged "Individual" (full name + address matched) or
 *              "Household" (address + last name only). Only Individual
 *              matches are written unless acceptHousehold is set, so we never
 *              pay for, or email, a spouse or grown child by mistake.
 *              Needs ATDATA_API_KEY.
 *
 *   published  Free of vendor fees: the prospect engine's existing web-search
 *              research (researchProspect). Accepts only an email literally
 *              printed on a page it retrieved, with the source URL, never from
 *              social or people-search sites, never on low identity confidence.
 *              Costs model + web-search usage. Needs ANTHROPIC_API_KEY.
 *
 * Every attempt is recorded (tag `append:<provider>:tried` + a prospect_events
 * row), so a household is never re-queried — and never re-billed — by the
 * same provider. Nothing here runs on a schedule; it is triggered on purpose.
 * dryRun makes NO external calls: it returns who would be queried.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, isDbReady, schema } from "../db";
import { researchProspect } from "./engine";

const { prospects, prospectHouseholds, prospectEvents } = schema;

export type AppendProvider = "atdata" | "published";

export interface AppendOptions {
  provider: AppendProvider;
  zips?: string[];               // default: every active target zip
  minHomeValue?: number;         // only households at or above this estimated value
  limit?: number;                // prospects to query this run
  acceptHousehold?: boolean;     // atdata only; default false (Individual matches only)
  trustFirst?: boolean;          // trust-titled households first within the value order
  dryRun?: boolean;              // select only; no external calls, no writes
  actor?: string;
}

export interface AppendRow {
  id: number;
  name: string;
  address: string;
  homeValue: number | null;
  outcome: "individual" | "household" | "household_skipped" | "published" | "no_match" | "duplicate_email" | "invalid_postal" | "error" | "would_query";
  email?: string;
  detail?: string;
}

export interface AppendSummary {
  ok: boolean;
  provider: AppendProvider;
  dryRun: boolean;
  selected: number;
  queried: number;
  written: number;
  counts: Record<string, number>;
  rows: AppendRow[];
  message?: string;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ATDATA_URL = "https://api.atdata.com/v5/eppend";
const LIMITS: Record<AppendProvider, { def: number; max: number; concurrency: number; timeoutMs: number }> = {
  atdata: { def: 25, max: 500, concurrency: 5, timeoutMs: 15_000 },
  published: { def: 6, max: 15, concurrency: 3, timeoutMs: 120_000 },
};

export function appendProviderReady(p: AppendProvider): string | null {
  if (p === "atdata" && !process.env.ATDATA_API_KEY) return "ATDATA_API_KEY is not set on the VistaIntel Vercel project";
  if (p === "published" && !process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY is not set on the VistaIntel Vercel project";
  return null;
}

async function activeZips(): Promise<string[]> {
  const rows = await db.select({ zip5: schema.prospectZips.zip5 }).from(schema.prospectZips).where(eq(schema.prospectZips.active, true));
  return rows.map((r) => r.zip5);
}

async function selectForAppend(o: AppendOptions, limit: number) {
  const zips = o.zips?.length ? o.zips : await activeZips();
  if (!zips.length) return [];
  const triedTag = `append:${o.provider}:tried`;
  const conds = [
    sql`${prospects.zip5} IN (${sql.join(zips.map((z) => sql`${z}`), sql`, `)})`,
    eq(prospects.leadStatus, "new"),
    eq(prospects.doNotContact, false),
    eq(prospects.doNotEmail, false),
    sql`${prospects.email} IS NULL`,
    sql`${prospects.firstName} IS NOT NULL AND length(${prospects.firstName}) > 1`,
    sql`${prospects.lastName} IS NOT NULL`,
    sql`${prospects.addressLine1} IS NOT NULL`,
    sql`NOT (coalesce(${prospects.tags}, ARRAY[]::text[]) && ARRAY[${triedTag}, 'use:political', 'name-truncated']::text[])`,
  ];
  if (o.minHomeValue) conds.push(sql`${prospectHouseholds.homeValue} >= ${o.minHomeValue}`);
  const order = [
    ...(o.trustFirst ? [sql`coalesce(${prospects.hasTrust}, false) DESC`] : []),
    sql`${prospectHouseholds.homeValue} DESC NULLS LAST`,
    desc(prospects.leadScore),
    asc(prospects.id),
  ];
  return db
    .select({
      id: prospects.id,
      fullName: prospects.fullName,
      firstName: prospects.firstName,
      middleName: prospects.middleName,
      lastName: prospects.lastName,
      addressLine1: prospects.addressLine1,
      city: prospects.city,
      state: prospects.state,
      zip5: prospects.zip5,
      zip4: prospects.zip4,
      employer: prospects.employer,
      title: prospects.title,
      tags: prospects.tags,
      homeValue: prospectHouseholds.homeValue,
    })
    .from(prospects)
    .leftJoin(prospectHouseholds, eq(prospects.householdId, prospectHouseholds.id))
    .where(and(...conds))
    .orderBy(...order)
    .limit(limit);
}

type Candidate = Awaited<ReturnType<typeof selectForAppend>>[number];

// ── Providers ────────────────────────────────────────────────────────────────────────────

interface ProviderResult {
  outcome: AppendRow["outcome"];
  email?: string;
  matchType?: string;
  detail?: string;
  meta?: Record<string, unknown>;
  enrich?: Partial<typeof prospects.$inferInsert>;
}

async function viaAtData(c: Candidate, acceptHousehold: boolean): Promise<ProviderResult> {
  const qs = new URLSearchParams({
    first: c.firstName ?? "",
    last: c.lastName ?? "",
    street: c.addressLine1 ?? "",
    city: c.city ?? "",
    state: c.state ?? "IL",
    zip: c.zip4 ? `${c.zip5}-${c.zip4}` : c.zip5,
    api_key: process.env.ATDATA_API_KEY ?? "",
  });
  if (c.middleName) qs.set("middle", c.middleName);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMITS.atdata.timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${ATDATA_URL}?${qs}`, { headers: { Accept: "application/json" }, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 200) }; }
  if (!res.ok || body?.error_code) {
    const msg = String(body?.error_msg ?? body?.raw ?? `${res.status} ${res.statusText}`);
    if (/postal address/i.test(msg)) return { outcome: "invalid_postal", detail: msg };
    throw new Error(`AtData ${res.status}: ${msg}`);
  }
  const hits: Array<{ email?: string; email_match_type?: string }> = Array.isArray(body?.email_append) ? body.email_append : [];
  const valid = hits.filter((h) => typeof h.email === "string" && EMAIL_RE.test(h.email.trim()));
  const individual = valid.find((h) => /^individual$/i.test(h.email_match_type ?? ""));
  const household = valid.find((h) => /^household$/i.test(h.email_match_type ?? ""));
  if (individual) return { outcome: "individual", email: individual.email!.trim().toLowerCase(), matchType: "Individual" };
  if (household && acceptHousehold) return { outcome: "household", email: household.email!.trim().toLowerCase(), matchType: "Household" };
  if (household) return { outcome: "household_skipped", detail: "Household-level match only; not written (acceptHousehold off)" };
  return { outcome: "no_match" };
}

const SOCIAL_OR_BROKER = /(linkedin|facebook|instagram|twitter|x\.com|whitepages|spokeo|truepeoplesearch|fastpeoplesearch|beenverified|radaris|zillow|redfin|realtor\.com|mylife|intelius|peoplefinders)/i;

async function viaPublished(c: Candidate): Promise<ProviderResult> {
  const r = await researchProspect(
    {
      fullName: c.fullName,
      firstName: c.firstName,
      lastName: c.lastName,
      addressLine1: c.addressLine1,
      city: c.city,
      state: c.state,
      zip5: c.zip5,
      employer: c.employer,
      title: c.title,
    },
    LIMITS.published.timeoutMs
  );
  // Professional context is worth keeping even when no email is found.
  const enrich: Partial<typeof prospects.$inferInsert> = {};
  if (r.confidence !== "low" && !r.is_entity) {
    if (r.employer) enrich.employer = r.employer;
    if (r.title) enrich.title = r.title;
    if (r.occupation) enrich.occupation = r.occupation;
    if (r.industry) enrich.industry = r.industry;
    if (r.linkedin_url) enrich.linkedinUrl = r.linkedin_url;
    if (r.is_business_owner != null) enrich.isBusinessOwner = r.is_business_owner;
    if (r.is_executive != null) enrich.isExecutive = r.is_executive;
  }
  const meta = { confidence: r.confidence, identity: r.identity_match, hooks: r.personalization_hooks, sources: r.sources, summary: r.summary };
  if (r.is_entity) return { outcome: "no_match", detail: "entity, not a person", meta };
  if (!r.email || !r.email_source_url) return { outcome: "no_match", detail: "no published email", meta, enrich };
  if (SOCIAL_OR_BROKER.test(r.email_source_url)) return { outcome: "no_match", detail: "email only on a social or people-search site; rejected", meta, enrich };
  if (r.confidence === "low") return { outcome: "no_match", detail: "identity confidence low; rejected", meta, enrich };
  return { outcome: "published", email: r.email, matchType: `published:${r.email_kind ?? "unknown"}`, detail: r.email_source_url, meta: { ...meta, emailSourceUrl: r.email_source_url, emailKind: r.email_kind }, enrich };
}

// ── Write path ─────────────────────────────────────────────────────────────────────────

async function emailTakenByOther(email: string, id: number): Promise<boolean> {
  const rows = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.emailNormalized, email), sql`${prospects.id} <> ${id}`))
    .limit(1);
  return rows.length > 0;
}

async function record(c: Candidate, o: AppendOptions, pr: ProviderResult): Promise<AppendRow["outcome"]> {
  const tags = new Set<string>(c.tags ?? []);
  tags.add(`append:${o.provider}:tried`);
  let outcome = pr.outcome;
  let wrote = false;

  if (pr.email) {
    if (await emailTakenByOther(pr.email, c.id)) {
      outcome = "duplicate_email";
    } else {
      tags.add(o.provider === "atdata" ? `email:atdata-${(pr.matchType ?? "").toLowerCase()}` : "email:published");
      await db
        .update(prospects)
        .set({
          ...(pr.enrich ?? {}),
          email: pr.email,
          emailNormalized: pr.email,
          emailStatus: "unverified",
          tags: Array.from(tags),
          updatedAt: new Date(),
        })
        .where(eq(prospects.id, c.id));
      wrote = true;
    }
  }
  if (!wrote) {
    await db
      .update(prospects)
      .set({ ...(pr.enrich ?? {}), tags: Array.from(tags), updatedAt: new Date() })
      .where(eq(prospects.id, c.id));
  }
  await db.insert(prospectEvents).values({
    prospectId: c.id,
    kind: "email_append",
    detail: `${o.provider}: ${outcome}${pr.detail ? ` — ${pr.detail}` : ""}`.slice(0, 500),
    meta: { provider: o.provider, outcome, matchType: pr.matchType ?? null, email: wrote ? pr.email : null, ...(pr.meta ?? {}) },
    actor: o.actor ?? "email-append",
  });
  return outcome;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────

export async function runEmailAppend(o: AppendOptions): Promise<AppendSummary> {
  if (!isDbReady()) throw new Error("DATABASE_URL not configured");
  const lim = LIMITS[o.provider];
  const limit = Math.max(1, Math.min(o.limit ?? lim.def, lim.max));
  const summary: AppendSummary = { ok: true, provider: o.provider, dryRun: !!o.dryRun, selected: 0, queried: 0, written: 0, counts: {}, rows: [] };

  const notReady = appendProviderReady(o.provider);
  if (notReady && !o.dryRun) {
    summary.ok = false;
    summary.message = notReady;
    return summary;
  }

  const candidates = await selectForAppend(o, limit);
  summary.selected = candidates.length;
  const view = (c: Candidate) => ({
    id: c.id,
    name: c.fullName,
    address: [c.addressLine1, c.city, c.zip5].filter(Boolean).join(", "),
    homeValue: c.homeValue ?? null,
  });

  if (o.dryRun) {
    summary.rows = candidates.map((c) => ({ ...view(c), outcome: "would_query" as const }));
    summary.counts.would_query = candidates.length;
    summary.message = notReady ? `Dry run only. Before a live run: ${notReady}.` : "Dry run: no external calls were made and nothing was written.";
    return summary;
  }

  summary.rows = await pool(candidates, lim.concurrency, async (c): Promise<AppendRow> => {
    try {
      const pr = o.provider === "atdata" ? await viaAtData(c, !!o.acceptHousehold) : await viaPublished(c);
      summary.queried++;
      const outcome = await record(c, o, pr);
      const wrote = (outcome === "individual" || outcome === "household" || outcome === "published");
      if (wrote) summary.written++;
      return { ...view(c), outcome, email: wrote ? pr.email : undefined, detail: pr.detail };
    } catch (e) {
      // Our failure (network, vendor outage, quota) — never mark the household tried.
      return { ...view(c), outcome: "error", detail: e instanceof Error ? e.message : String(e) };
    }
  });
  for (const r of summary.rows) summary.counts[r.outcome] = (summary.counts[r.outcome] ?? 0) + 1;
  summary.ok = !summary.rows.some((r) => r.outcome === "error") || summary.queried > 0;
  return summary;
}
