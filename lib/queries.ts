import { and, asc, desc, eq, gte, ilike, isNotNull, lte, or, sql, inArray } from "drizzle-orm";
import { db, isDbReady } from "./db";
import { firms, firmHistory, advisors, advisorHistory, firmCustodians, ingestRuns, privateFunds } from "./db/schema";
import { redactUrl } from "./data/http";

export interface SearchRiasParams {
  state?: string;
  city?: string;
  minAum?: number;
  maxAum?: number;
  minAccounts?: number;
  hasCustody?: boolean;
  isLargeAdviser?: boolean;
  minPctPensionPlans?: number;
  minPctCharitableOrgs?: number;
  minPctHighNetWorth?: number;
  minPctGovernmentEntities?: number;
  minPctIndividualNonHnw?: number;
  offersPensionConsulting?: boolean;
  offersFinancialPlanning?: boolean;
  offersAdvisorSelection?: boolean;
  nameContains?: string;
  sortBy?: "aum" | "accounts" | "employees" | "name";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function searchRias(params: SearchRiasParams) {
  if (!isDbReady()) return { rows: [], total: 0, dbReady: false };

  const conds = [];
  if (params.state) conds.push(eq(firms.mainOfficeState, params.state.toUpperCase()));
  if (params.city) conds.push(ilike(firms.mainOfficeCity, params.city));
  if (params.minAum != null) conds.push(gte(firms.totalAum, params.minAum));
  if (params.maxAum != null) conds.push(lte(firms.totalAum, params.maxAum));
  if (params.minAccounts != null) conds.push(gte(firms.totalAccounts, params.minAccounts));
  if (params.hasCustody != null) conds.push(eq(firms.hasCustody, params.hasCustody));
  if (params.isLargeAdviser != null) conds.push(eq(firms.isLargeAdviser, params.isLargeAdviser));
  if (params.minPctPensionPlans != null) conds.push(gte(firms.pctPensionPlans, params.minPctPensionPlans.toString()));
  if (params.minPctCharitableOrgs != null) conds.push(gte(firms.pctCharitableOrgs, params.minPctCharitableOrgs.toString()));
  if (params.minPctHighNetWorth != null) conds.push(gte(firms.pctIndividualHnw, params.minPctHighNetWorth.toString()));
  if (params.minPctGovernmentEntities != null) conds.push(gte(firms.pctGovernmentEntities, params.minPctGovernmentEntities.toString()));
  if (params.minPctIndividualNonHnw != null) conds.push(gte(firms.pctIndividualNonHnw, params.minPctIndividualNonHnw.toString()));
  if (params.offersPensionConsulting) conds.push(eq(firms.svcPensionConsulting, true));
  if (params.offersFinancialPlanning) conds.push(eq(firms.svcFinancialPlanning, true));
  if (params.offersAdvisorSelection) conds.push(eq(firms.svcAdvisorSelection, true));
  if (params.nameContains) {
    const q = `%${params.nameContains}%`;
    conds.push(or(ilike(firms.legalName, q), ilike(firms.primaryBusinessName, q)));
  }

  const where = conds.length > 0 ? and(...conds) : undefined;
  const sortDir = params.sortDir === "asc" ? asc : desc;
  const sortCol = { aum: firms.totalAum, accounts: firms.totalAccounts, employees: firms.totalEmployees, name: firms.legalName }[params.sortBy ?? "aum"];
  const limit = Math.min(params.limit ?? 50, 500);
  const offset = params.offset ?? 0;

  const rows = await db.select({
    crdNumber: firms.crdNumber, legalName: firms.legalName, primaryBusinessName: firms.primaryBusinessName,
    city: firms.mainOfficeCity, state: firms.mainOfficeState, website: firms.website,
    totalAum: firms.totalAum, discretionaryAum: firms.discretionaryAum, totalAccounts: firms.totalAccounts,
    totalEmployees: firms.totalEmployees, registeredIarCount: firms.registeredIarCount,
    hasCustody: firms.hasCustody, registrationStatus: firms.registrationStatus,
  }).from(firms).where(where).orderBy(sortDir(sortCol)).limit(limit).offset(offset);

  const totalRes = await db.select({ count: sql<number>`count(*)::int` }).from(firms).where(where);
  return { rows, total: totalRes[0]?.count ?? 0, dbReady: true };
}

export async function getRiaProfile(args: { crdNumber?: number; legalName?: string }) {
  if (!isDbReady()) return { firm: null, dbReady: false };
  let firm = null;
  if (args.crdNumber) {
    const rows = await db.select().from(firms).where(eq(firms.crdNumber, args.crdNumber));
    firm = rows[0] ?? null;
  } else if (args.legalName) {
    const rows = await db.select().from(firms).where(ilike(firms.legalName, `%${args.legalName}%`)).orderBy(desc(firms.totalAum)).limit(1);
    firm = rows[0] ?? null;
  }
  if (!firm) return { firm: null, dbReady: true };
  const [history, advisorRows, custodianRows, fundRows] = await Promise.all([
    db.select().from(firmHistory).where(eq(firmHistory.crdNumber, firm.crdNumber)).orderBy(desc(firmHistory.filingDate)).limit(20),
    db.select().from(advisors).where(eq(advisors.currentFirmCrd, firm.crdNumber)).limit(100),
    db.select().from(firmCustodians).where(eq(firmCustodians.firmCrd, firm.crdNumber)),
    db.select().from(privateFunds).where(eq(privateFunds.firmCrd, firm.crdNumber)),
  ]);
  const { rawJson, ...firmClean } = firm;
  return { firm: firmClean, aumHistory: history, keyAdvisors: advisorRows, custodians: custodianRows, privateFunds: fundRows, dbReady: true };
}

export async function searchAdvisors(args: { name?: string; currentFirmName?: string; limit?: number }) {
  if (!isDbReady()) return { rows: [], dbReady: false };
  const conds = [];
  if (args.name) conds.push(ilike(advisors.fullName, `%${args.name}%`));
  if (args.currentFirmName) {
    const matching = await db.select({ crd: firms.crdNumber }).from(firms).where(ilike(firms.legalName, `%${args.currentFirmName}%`)).limit(50);
    if (matching.length === 0) return { rows: [], dbReady: true };
    conds.push(inArray(advisors.currentFirmCrd, matching.map((m: { crd: number }) => m.crd)));
  }
  const rows = await db.select({
    crdNumber: advisors.crdNumber, fullName: advisors.fullName, title: advisors.title,
    currentFirmCrd: advisors.currentFirmCrd, hasDisclosures: advisors.hasDisclosures,
  }).from(advisors).where(conds.length ? and(...conds) : undefined).limit(Math.min(args.limit ?? 50, 200));
  return { rows, dbReady: true };
}

export async function findAlumni(args: { priorFirmName: string; limit?: number }) {
  if (!isDbReady()) return { rows: [], dbReady: false };
  const matching = await db.select({ crd: firms.crdNumber }).from(firms).where(ilike(firms.legalName, `%${args.priorFirmName}%`)).limit(10);
  if (matching.length === 0) return { rows: [], dbReady: true };
  const priorCrds = matching.map((m: { crd: number }) => m.crd);
  const limit = Math.min(args.limit ?? 100, 500);
  const rows = await db.select({
    advisorCrd: advisors.crdNumber, fullName: advisors.fullName, currentFirmCrd: advisors.currentFirmCrd,
    currentFirmName: firms.legalName, currentFirmState: firms.mainOfficeState, currentFirmAum: firms.totalAum,
    priorFirmCrd: advisorHistory.firmCrd, leftPriorFirmOn: advisorHistory.endDate,
  }).from(advisorHistory)
    .innerJoin(advisors, eq(advisors.crdNumber, advisorHistory.advisorCrd))
    .leftJoin(firms, eq(firms.crdNumber, advisors.currentFirmCrd))
    .where(and(
      inArray(advisorHistory.firmCrd, priorCrds),
      isNotNull(advisorHistory.endDate),
      sql`${advisors.currentFirmCrd} IS NOT NULL AND ${advisors.currentFirmCrd} NOT IN (${sql.join(priorCrds.map((c: number) => sql`${c}`), sql`, `)})`
    ))
    .orderBy(desc(advisorHistory.endDate)).limit(limit);
  return { rows, dbReady: true };
}

export async function getAumHistory(args: { crdNumber: number; limit?: number }) {
  if (!isDbReady()) return { rows: [], dbReady: false };
  const rows = await db.select().from(firmHistory).where(eq(firmHistory.crdNumber, args.crdNumber)).orderBy(desc(firmHistory.filingDate)).limit(Math.min(args.limit ?? 50, 200));
  return { rows, dbReady: true };
}

export async function firmsUsingCustodian(args: { custodianName: string; limit?: number }) {
  if (!isDbReady()) return { rows: [], dbReady: false };
  const rows = await db.select({
    firmCrd: firmCustodians.firmCrd, firmName: firms.legalName, state: firms.mainOfficeState,
    totalAum: firms.totalAum, custodianName: firmCustodians.custodianName,
    aumHeld: firmCustodians.aumHeld, accountsHeld: firmCustodians.accountsHeld,
  }).from(firmCustodians)
    .innerJoin(firms, eq(firms.crdNumber, firmCustodians.firmCrd))
    .where(ilike(firmCustodians.custodianName, `%${args.custodianName}%`))
    .orderBy(desc(firmCustodians.aumHeld)).limit(Math.min(args.limit ?? 100, 500));
  return { rows, dbReady: true };
}

export async function topRiasBy(args: { metric: "aum" | "accounts" | "employees" | "iars"; state?: string; limit?: number }) {
  if (!isDbReady()) return { rows: [], dbReady: false };
  const col = { aum: firms.totalAum, accounts: firms.totalAccounts, employees: firms.totalEmployees, iars: firms.registeredIarCount }[args.metric];
  const conds = [isNotNull(col)];
  if (args.state) conds.push(eq(firms.mainOfficeState, args.state.toUpperCase()));
  const rows = await db.select({
    crdNumber: firms.crdNumber, legalName: firms.legalName, state: firms.mainOfficeState,
    totalAum: firms.totalAum, totalAccounts: firms.totalAccounts,
    totalEmployees: firms.totalEmployees, registeredIarCount: firms.registeredIarCount,
  }).from(firms).where(and(...conds)).orderBy(desc(col)).limit(Math.min(args.limit ?? 25, 100));
  return { rows, dbReady: true };
}

/**
 * Slim view of an ingest run for diagnostics. Error messages are redacted
 * (credential-safe) and truncated — they surface on the unauthenticated
 * selftest, so they must never carry secrets or unbounded upstream bodies.
 */
function slimRun(r: any) {
  if (!r) return null;
  return {
    id: r.id ?? null,
    source: r.source ?? null,
    status: r.status ?? null,
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
    rowsProcessed: r.firmsProcessed ?? null,
    ...(r.errorMessage ? { error: redactUrl(String(r.errorMessage)).slice(0, 200) } : {}),
  };
}

export async function databaseStatus() {
  if (!isDbReady()) return { dbReady: false, message: "DATABASE_URL is not configured. Connect Neon/Postgres in the Vercel dashboard and redeploy." };
  const [firmCountRes, lastOkRes, recentRes, latestSnapshotRes] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(firms),
    db.select().from(ingestRuns).where(eq(ingestRuns.status, "ok")).orderBy(desc(ingestRuns.finishedAt)).limit(1),
    db.select().from(ingestRuns).orderBy(desc(ingestRuns.startedAt)).limit(40),
    db.select({ date: sql<string>`max(${firmHistory.filingDate})::text` }).from(firmHistory),
  ]);

  // Latest run per ingest FAMILY (source prefix before '/'), errors first.
  // This is the fix for the silent-failure blind spot: the old lastIngest
  // filtered status='ok', so a scheduled ingest that errored every week was
  // invisible here. Now each family's most recent outcome — including its
  // errorMessage — is one database_status call away.
  const latestPerFamily = new Map<string, any>();
  for (const r of recentRes) {
    const family = String((r as any).source ?? "unknown").split("/")[0];
    if (!latestPerFamily.has(family)) latestPerFamily.set(family, slimRun(r));
  }
  const at = (x: any) => (x?.startedAt ? new Date(x.startedAt).getTime() : 0);
  const pipelineHealth = [...latestPerFamily.values()].sort((a, b) => {
    const ae = a?.status === "error" ? 0 : 1;
    const be = b?.status === "error" ? 0 : 1;
    if (ae !== be) return ae - be;
    return at(b) - at(a);
  });

  return {
    dbReady: true,
    firmCount: firmCountRes[0]?.count ?? 0,
    pipelineHealth,
    lastIngest: slimRun(recentRes[0] ?? null),
    lastSuccessfulIngest: slimRun(lastOkRes[0] ?? null),
    latestSnapshotDate: latestSnapshotRes[0]?.date ?? null,
    note: "pipelineHealth = each ingest family's LATEST run over the last 40 runs, errors sorted first — a failing scheduled ingest surfaces its (redacted, truncated) errorMessage here instead of hiding behind an ok-only filter. lastIngest is the most recent run of ANY status; lastSuccessfulIngest preserves the previous ok-only semantics. A family absent from pipelineHealth has never created a run record — its handler is not being reached at all (auth, routing, or the cron never firing).",
  };
}
