import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../../lib/auth";
import { neon } from "@neondatabase/serverless";

/**
 * GET /api/admin/stats
 *
 * Live counts and freshness for every table in the schema. Powers the Schema
 * Atlas page (live row counts) and the Query Console header.
 *
 * Auth: same ACCESS_TOKEN pattern as the rest of /api/admin/*.
 *
 * Returns:
 *   {
 *     ok: true,
 *     generated_at: ISO timestamp,
 *     db_ready: bool,
 *     tables: [
 *       { name, count, latest_update, source, error? },
 *       ...
 *     ],
 *     last_ingest_runs: [ {...}, ... ]   // most recent 10
 *   }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS so the static atlas/console pages can call this from any origin
  // during local dev. In production both are served same-origin from /public.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, ACCESS_TOKEN, access_token"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "GET only" });
    return;
  }

  const auth = await requireAccessOrSession(req);
  if (!auth.ok) {
    res.status(401).json({ ok: false, error: auth.reason });
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    res.status(200).json({
      ok: true,
      db_ready: false,
      generated_at: new Date().toISOString(),
      tables: [],
      last_ingest_runs: [],
      note: "DATABASE_URL not set — running in static-docs mode",
    });
    return;
  }

  const sql = neon(url);

  // Each table-stat probe is independent so a missing table (pre-migration)
  // doesn't kill the whole response. Errors are captured per-table.
  const probes: Array<{
    name: string;
    source: string;
    countQuery: string;
    latestQuery: string | null;
  }> = [
    {
      name: "firms",
      source: "SEC Form ADV (weekly cron)",
      countQuery: "SELECT COUNT(*)::int AS n FROM firms",
      latestQuery: "SELECT MAX(last_updated_at) AS t FROM firms",
    },
    {
      name: "firm_history",
      source: "Derived from firms on each ADV refresh",
      countQuery: "SELECT COUNT(*)::int AS n FROM firm_history",
      latestQuery: "SELECT MAX(filing_date) AS t FROM firm_history",
    },
    {
      name: "advisors",
      source: "Form ADV Part 2B + IAPD",
      countQuery: "SELECT COUNT(*)::int AS n FROM advisors",
      latestQuery: "SELECT MAX(last_updated_at) AS t FROM advisors",
    },
    {
      name: "advisor_history",
      source: "Derived from advisor CRD changes over time",
      countQuery: "SELECT COUNT(*)::int AS n FROM advisor_history",
      latestQuery: "SELECT MAX(discovered_at) AS t FROM advisor_history",
    },
    {
      name: "firm_custodians",
      source: "Form ADV Part 1, Schedule D",
      countQuery: "SELECT COUNT(*)::int AS n FROM firm_custodians",
      latestQuery: null,
    },
    {
      name: "private_funds",
      source: "Form ADV Section 7.B.1",
      countQuery: "SELECT COUNT(*)::int AS n FROM private_funds",
      latestQuery: null,
    },
    {
      name: "nonprofits",
      source: "IRS EO BMF (monthly cron)",
      countQuery: "SELECT COUNT(*)::int AS n FROM nonprofits",
      latestQuery: "SELECT MAX(last_updated_at) AS t FROM nonprofits",
    },
    {
      name: "ingest_runs",
      source: "Written by all cron jobs",
      countQuery: "SELECT COUNT(*)::int AS n FROM ingest_runs",
      latestQuery: "SELECT MAX(started_at) AS t FROM ingest_runs",
    },
  ];

  const tables = await Promise.all(
    probes.map(async (p) => {
      try {
        const countResult = (await sql(p.countQuery)) as Array<{ n: number }>;
        const count = countResult[0]?.n ?? 0;
        let latest_update: string | null = null;
        if (p.latestQuery) {
          const latestResult = (await sql(p.latestQuery)) as Array<{ t: string | null }>;
          latest_update = latestResult[0]?.t ?? null;
        }
        return { name: p.name, source: p.source, count, latest_update };
      } catch (err: any) {
        return {
          name: p.name,
          source: p.source,
          count: null,
          latest_update: null,
          error: err?.message ?? String(err),
        };
      }
    })
  );

  // Recent ingest history — useful health signal at the top of the dashboard.
  let last_ingest_runs: any[] = [];
  try {
    last_ingest_runs = (await sql(
      `SELECT id, started_at, finished_at, source, feed_date,
              firms_processed, firms_inserted, firms_updated,
              status, error_message
       FROM ingest_runs
       ORDER BY started_at DESC
       LIMIT 10`
    )) as any[];
  } catch {
    // Table might not exist yet — that's fine
  }

  res.status(200).json({
    ok: true,
    db_ready: true,
    generated_at: new Date().toISOString(),
    tables,
    last_ingest_runs,
  });
}
