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

  // ?raw=<crd_number> — dump the stored raw_json for one firm so we can see
  // the actual XML structure fast-xml-parser produced.
  const rawCrd = typeof req.query.raw === "string" ? Number(req.query.raw) : null;

  try {
    const sql = neon(process.env.DATABASE_URL);

    if (rawCrd && Number.isFinite(rawCrd)) {
      const rows = await sql(
        `SELECT crd_number, legal_name, raw_json FROM firms WHERE crd_number = $1`,
        [rawCrd]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: `No firm with CRD ${rawCrd}` });
        return;
      }
      const row = rows[0];
      let parsedRaw: any = null;
      try {
        parsedRaw = JSON.parse(row.raw_json);
      } catch {
        parsedRaw = { error: "raw_json was not valid JSON", text: String(row.raw_json).slice(0, 5000) };
      }
      res.status(200).json({
        crd_number: row.crd_number,
        legal_name: row.legal_name,
        rawStructure: parsedRaw,
      });
      return;
    }

    const [
      counts,
      topAum,
      vistamark,
      fiducient,
      historyCount,
      stateBreakdown,
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
      hint: "Pass ?raw=<crd_number> to dump that firm's raw parsed-XML structure",
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
