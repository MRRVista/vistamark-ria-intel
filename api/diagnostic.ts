import type { VercelRequest, VercelResponse } from "@vercel/node";
import { neon } from "@neondatabase/serverless";

/**
 * One-shot diagnostic endpoint — verifies parser worked end-to-end.
 * Removed in cleanup commit after initial ingest validation.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: "DATABASE_URL not configured" });
    return;
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const [
      counts,
      topAum,
      vistamark,
      fiducient,
      historyCount,
      stateBreakdown,
      sampleFirm,
    ] = await Promise.all([
      sql(`
        SELECT
          count(*)::int AS total,
          count(total_aum)::int AS with_aum,
          count(*) FILTER (WHERE has_custody = true)::int AS with_custody,
          count(*) FILTER (WHERE has_disclosures = true)::int AS with_disclosures,
          count(*) FILTER (WHERE is_large_adviser = true)::int AS large_advisers,
          count(*) FILTER (WHERE registration_status = 'sec_registered')::int AS sec_reg,
          count(*) FILTER (WHERE registration_status = 'state_registered')::int AS state_reg,
          count(*) FILTER (WHERE registration_status = 'exempt_reporting')::int AS era,
          count(DISTINCT main_office_state)::int AS states_represented
        FROM firms
      `),
      sql(`
        SELECT crd_number, legal_name, total_aum, main_office_city, main_office_state, total_employees, registered_iar_count
        FROM firms
        WHERE total_aum IS NOT NULL
        ORDER BY total_aum DESC
        LIMIT 5
      `),
      sql(`
        SELECT crd_number, legal_name, primary_business_name, total_aum, main_office_city, main_office_state, registration_status
        FROM firms
        WHERE legal_name ILIKE '%vistamark%' OR primary_business_name ILIKE '%vistamark%'
        LIMIT 5
      `),
      sql(`
        SELECT crd_number, legal_name, primary_business_name, total_aum, main_office_city, main_office_state, registration_status
        FROM firms
        WHERE legal_name ILIKE '%fiducient%' OR primary_business_name ILIKE '%fiducient%'
        LIMIT 5
      `),
      sql(`SELECT count(*)::int AS count FROM firm_history`),
      sql(`
        SELECT main_office_state, count(*)::int AS firm_count
        FROM firms
        WHERE main_office_state IS NOT NULL
        GROUP BY main_office_state
        ORDER BY firm_count DESC
        LIMIT 10
      `),
      sql(`SELECT * FROM firms WHERE total_aum IS NOT NULL ORDER BY total_aum DESC LIMIT 1`),
    ]);

    res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      counts: counts[0],
      historyRows: historyCount[0],
      topByAum: topAum,
      vistamarkMatches: vistamark,
      fiducientMatches: fiducient,
      topStates: stateBreakdown,
      sampleFirmColumns: sampleFirm[0] ? Object.keys(sampleFirm[0]) : [],
      sampleFirmAumFields: sampleFirm[0]
        ? {
            total_aum: sampleFirm[0].total_aum,
            discretionary_aum: sampleFirm[0].discretionary_aum,
            non_discretionary_aum: sampleFirm[0].non_discretionary_aum,
            total_accounts: sampleFirm[0].total_accounts,
            total_employees: sampleFirm[0].total_employees,
            registered_iar_count: sampleFirm[0].registered_iar_count,
            pct_individual_hnw: sampleFirm[0].pct_individual_hnw,
            pct_pension_plans: sampleFirm[0].pct_pension_plans,
            comp_aum_pct: sampleFirm[0].comp_aum_pct,
            svc_financial_planning: sampleFirm[0].svc_financial_planning,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
