/**
 * NACUBO benchmark ingest. Currently seeds the nacubo_benchmarks table from
 * hardcoded public-aggregate data in lib/nacubo/data.ts. The granular
 * institution-specific dataset is paywalled ($500/yr from NACUBO); a future
 * v0.4.1+ may add a scraper for the public participants Excel file when its
 * direct URL is confirmed.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { nacuboBenchmarks, ingestRuns } from "../db/schema";
import { NACUBO_SEED } from "./data";

const SOURCE = "nacubo/public-aggregate";

export interface NacuboIngestResult {
  rowsUpserted: number;
  durationMs: number;
}

export async function ingestNacuboBenchmarks(): Promise<NacuboIngestResult> {
  if (!db) throw new Error("Database not configured");
  const start = Date.now();

  const runInsert = await db
    .insert(ingestRuns)
    .values({ source: SOURCE, status: "running" })
    .returning({ id: ingestRuns.id });
  const runId = runInsert[0]!.id;

  try {
    await db
      .insert(nacuboBenchmarks)
      .values(NACUBO_SEED)
      .onConflictDoUpdate({
        target: [nacuboBenchmarks.fyear, nacuboBenchmarks.cohort],
        set: {
          cohortCount: sql`excluded.cohort_count`,
          totalAssets: sql`excluded.total_assets`,
          medianValue: sql`excluded.median_value`,
          return1y: sql`excluded.return_1y`,
          return3y: sql`excluded.return_3y`,
          return5y: sql`excluded.return_5y`,
          return10y: sql`excluded.return_10y`,
          spendingRate: sql`excluded.spending_rate`,
          spendingAmount: sql`excluded.spending_amount`,
          assetAllocJson: sql`excluded.asset_alloc_json`,
          source: sql`excluded.source`,
          lastUpdatedAt: sql`NOW()`,
        },
      });

    await db
      .update(ingestRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        firmsProcessed: NACUBO_SEED.length,
        firmsInserted: NACUBO_SEED.length,
      })
      .where(sql`${ingestRuns.id} = ${runId}`);

    return { rowsUpserted: NACUBO_SEED.length, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(ingestRuns)
      .set({
        status: "error",
        finishedAt: new Date(),
        errorMessage: message,
      })
      .where(sql`${ingestRuns.id} = ${runId}`);
    throw err;
  }
}
