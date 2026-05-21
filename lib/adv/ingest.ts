import { gunzipSync } from "zlib";
import { db } from "../db";
import { firms, firmHistory, ingestRuns } from "../db/schema";
import { sql } from "drizzle-orm";
import { parseAdvXml } from "./parser";
import type { FirmInsert } from "../db/schema";

const SEC_BULK_BASE = process.env.SEC_BULK_BASE_URL ?? "https://reports.adviserinfo.sec.gov/reports/CompilationReports";

const FEED_TYPES = ["IA_FIRM_SEC_Feed", "IA_FIRM_State_Feed"] as const;

export async function findLatestFeedUrl(feedType: typeof FEED_TYPES[number] = "IA_FIRM_SEC_Feed"): Promise<{ url: string; date: string } | null> {
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = String(d.getFullYear());
    const url = `${SEC_BULK_BASE}/${feedType}_${mm}_${dd}_${yyyy}.xml.gz`;
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) return { url, date: `${yyyy}-${mm}-${dd}` };
    } catch {}
  }
  return null;
}

export async function downloadAndDecompress(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return gunzipSync(buf).toString("utf-8");
}

export async function upsertFirms(records: FirmInsert[], feedDate: string): Promise<{ inserted: number; updated: number }> {
  if (!db) throw new Error("Database not configured");
  let inserted = 0;
  let updated = 0;
  const BATCH = 500;
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const result = await db.insert(firms).values(chunk).onConflictDoUpdate({
      target: firms.crdNumber,
      set: {
        legalName: sql`excluded.legal_name`,
        primaryBusinessName: sql`excluded.primary_business_name`,
        secNumber: sql`excluded.sec_number`,
        mainOfficeStreet: sql`excluded.main_office_street`,
        mainOfficeCity: sql`excluded.main_office_city`,
        mainOfficeState: sql`excluded.main_office_state`,
        mainOfficeZip: sql`excluded.main_office_zip`,
        mainOfficeCountry: sql`excluded.main_office_country`,
        website: sql`excluded.website`,
        mainPhone: sql`excluded.main_phone`,
        email: sql`excluded.email`,
        totalAum: sql`excluded.total_aum`,
        discretionaryAum: sql`excluded.discretionary_aum`,
        nonDiscretionaryAum: sql`excluded.non_discretionary_aum`,
        totalAccounts: sql`excluded.total_accounts`,
        discretionaryAccounts: sql`excluded.discretionary_accounts`,
        nonDiscretionaryAccounts: sql`excluded.non_discretionary_accounts`,
        totalEmployees: sql`excluded.total_employees`,
        registeredIarCount: sql`excluded.registered_iar_count`,
        registrationStatus: sql`excluded.registration_status`,
        isLargeAdviser: sql`excluded.is_large_adviser`,
        pctIndividualNonHnw: sql`excluded.pct_individual_non_hnw`,
        pctIndividualHnw: sql`excluded.pct_individual_hnw`,
        pctPensionPlans: sql`excluded.pct_pension_plans`,
        pctCharitableOrgs: sql`excluded.pct_charitable_orgs`,
        pctCorporations: sql`excluded.pct_corporations`,
        pctOtherInstitutional: sql`excluded.pct_other_institutional`,
        pctPooledInvestment: sql`excluded.pct_pooled_investment`,
        pctGovernmentEntities: sql`excluded.pct_government_entities`,
        pctOther: sql`excluded.pct_other`,
        compAumPct: sql`excluded.comp_aum_pct`,
        compHourly: sql`excluded.comp_hourly`,
        compFixedFee: sql`excluded.comp_fixed_fee`,
        compCommission: sql`excluded.comp_commission`,
        compPerformance: sql`excluded.comp_performance`,
        compSubscription: sql`excluded.comp_subscription`,
        compOther: sql`excluded.comp_other`,
        hasCustody: sql`excluded.has_custody`,
        custodyAum: sql`excluded.custody_aum`,
        custodyAccounts: sql`excluded.custody_accounts`,
        hasDisclosures: sql`excluded.has_disclosures`,
        lastFilingDate: sql`excluded.last_filing_date`,
        lastUpdatedAt: sql`now()`,
      },
    }).returning({ crd: firms.crdNumber, firstSeen: firms.firstSeenAt });

    const now = Date.now();
    for (const r of result) {
      if (r.firstSeen && now - new Date(r.firstSeen).getTime() < 10_000) inserted++;
      else updated++;
    }

    await db.insert(firmHistory).values(
      chunk.filter((c) => c.totalAum != null).map((c) => ({
        crdNumber: c.crdNumber,
        filingDate: feedDate,
        totalAum: c.totalAum,
        discretionaryAum: c.discretionaryAum,
        totalAccounts: c.totalAccounts,
        totalEmployees: c.totalEmployees,
        registeredIarCount: c.registeredIarCount,
      }))
    ).onConflictDoNothing();
  }
  return { inserted, updated };
}

export async function runFullIngest(): Promise<{ feedDate: string; firmsProcessed: number; inserted: number; updated: number; durationMs: number }> {
  const startedAt = Date.now();
  if (!db) throw new Error("DATABASE_URL not configured");
  const run = await db.insert(ingestRuns).values({ source: "sec_iapd", status: "running" }).returning({ id: ingestRuns.id });
  const runId = run[0].id;
  try {
    const feed = await findLatestFeedUrl("IA_FIRM_SEC_Feed");
    if (!feed) throw new Error("Could not locate a recent SEC feed file");
    const xml = await downloadAndDecompress(feed.url);
    const records = parseAdvXml(xml);
    const { inserted, updated } = await upsertFirms(records, feed.date);
    await db.update(ingestRuns).set({
      finishedAt: new Date(), feedDate: feed.date, firmsProcessed: records.length,
      firmsInserted: inserted, firmsUpdated: updated, status: "ok",
    }).where(sql`${ingestRuns.id} = ${runId}`);
    return { feedDate: feed.date, firmsProcessed: records.length, inserted, updated, durationMs: Date.now() - startedAt };
  } catch (err) {
    await db.update(ingestRuns).set({
      finishedAt: new Date(), status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    }).where(sql`${ingestRuns.id} = ${runId}`);
    throw err;
  }
}
