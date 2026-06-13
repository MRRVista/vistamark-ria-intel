import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { db } from "../../lib/db";

/**
 * Read-only diagnostic endpoint. Returns:
 *   - exact row counts for ipeds_institutions, endowments, nacubo_benchmarks, ppp_loans
 *   - distinct institutions and fyears coverage in endowments
 *   - the 50 most recent ipeds/* + sba-ppp/* ingest_runs entries
 *   - a Yale + Harvard sanity slice of the endowments table
 *
 * Auth: Vercel SSO (canary deployment URLs are protected by default).
 * No mutations; safe to call repeatedly.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (!db) {
    res.status(500).json({ ok: false, error: "Database not configured" });
    return;
  }
  try {
    const countsResult = await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM ipeds_institutions)                       AS institutions_total,
        (SELECT COUNT(*) FROM endowments)                               AS endowments_total,
        (SELECT COUNT(*) FROM nacubo_benchmarks)                        AS nacubo_total,
        (SELECT COUNT(*) FROM ppp_loans)                                AS ppp_total,
        (SELECT COUNT(DISTINCT unitid) FROM endowments)                 AS distinct_endowment_institutions,
        (SELECT COUNT(DISTINCT fyear) FROM endowments)                  AS distinct_fyears,
        (SELECT MIN(fyear) FROM endowments)                             AS earliest_fyear,
        (SELECT MAX(fyear) FROM endowments)                             AS latest_fyear,
        (SELECT COUNT(*) FROM endowments WHERE market_value_eoy > 0)    AS rows_with_eoy_value
    `);

    const ingestRunsResult = await db.execute(sql`
      SELECT source, status, firms_processed, firms_inserted, started_at, finished_at,
             error_message
      FROM ingest_runs
      WHERE source LIKE 'ipeds/%' OR source LIKE 'sba-ppp/%'
      ORDER BY started_at DESC
      LIMIT 50
    `);

    const yaleHarvardResult = await db.execute(sql`
      SELECT i.unitid, i.instnm, e.fyear, e.file_type,
             e.market_value_eoy, e.market_value_boy,
             e.net_change_in_endowment, e.net_investment_return, e.withdrawals
      FROM endowments e
      JOIN ipeds_institutions i ON i.unitid = e.unitid
      WHERE i.instnm IN ('Yale University', 'Harvard University')
      ORDER BY i.instnm, e.fyear DESC
    `);

    // Per-year coverage: how many institutions reported endowments each year
    const perYearResult = await db.execute(sql`
      SELECT fyear, file_type, COUNT(*) AS rows_count
      FROM endowments
      GROUP BY fyear, file_type
      ORDER BY fyear DESC, file_type
    `);

    res.status(200).json({
      ok: true,
      counts: (countsResult as any).rows?.[0] ?? null,
      ingestRuns: (ingestRunsResult as any).rows ?? [],
      yaleHarvard: (yaleHarvardResult as any).rows ?? [],
      perYearCoverage: (perYearResult as any).rows ?? [],
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}
