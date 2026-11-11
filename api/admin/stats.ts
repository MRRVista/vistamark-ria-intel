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
      name: "irs990_filings",
      source: "IRS TEOS 990 e-file XML (GitHub Actions, monthly)",
      countQuery: "SELECT COUNT(*)::int AS n FROM irs990_filings",
      latestQuery: "SELECT MAX(loaded_at) AS t FROM irs990_filings",
    },
    {
      name: "irs990_persons",
      source: "Part VII people from irs990_filings",
      countQuery: "SELECT COUNT(*)::int AS n FROM irs990_persons",
      latestQuery: "SELECT MAX(f.loaded_at) AS t FROM irs990_filings f",
    },
    {
      name: "irs990_batches",
      source: "Loader ledger — one row per IRS zip batch",
      countQuery: "SELECT COUNT(*)::int AS n FROM irs990_batches WHERE status = 'ok'",
      latestQuery: "SELECT MAX(finished_at) AS t FROM irs990_batches",
    },
    {
      name: "ingest_runs",
      source: "Written by all cron jobs + the irs990 loader",
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

  // The live catalog: every base table in the public schema with its columns,
  // so the Schema Atlas can show tables its hand-written list has not caught up
  // with (it documented 9 of 34 as of v0.39). Row counts for tables without a
  // probe above are the planner's estimate, labelled as such.
  let schema: Array<{ name: string; est_rows: number | null; columns: Array<{ n: string; t: string; nn: boolean; pk: boolean; idx: boolean | "unique" }> }> = [];
  try {
    const [cols, idx, est] = await Promise.all([
      sql(`SELECT c.table_name AS t, c.column_name AS n, c.data_type AS dt, c.udt_name AS udt,
                  c.character_maximum_length AS len, (c.is_nullable = 'NO') AS nn
           FROM information_schema.columns c
           JOIN information_schema.tables tb
             ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
           WHERE c.table_schema = 'public'
           ORDER BY c.table_name, c.ordinal_position`),
      sql(`SELECT t.relname AS t, a.attname AS n, bool_or(i.indisprimary) AS pk, bool_or(i.indisunique AND i.indnatts = 1) AS uq
           FROM pg_index i
           JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace ns ON ns.oid = t.relnamespace AND ns.nspname = 'public'
           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
           GROUP BY 1, 2`),
      sql(`SELECT c.relname AS t, c.reltuples::bigint AS n
           FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
           WHERE c.relkind = 'r'`),
    ]);
    const idxBy = new Map<string, { pk: boolean; uq: boolean }>();
    for (const r of idx as any[]) idxBy.set(`${r.t}.${r.n}`, { pk: !!r.pk, uq: !!r.uq });
    const estBy = new Map<string, number>();
    for (const r of est as any[]) estBy.set(String(r.t), Number(r.n));
    const byTable = new Map<string, (typeof schema)[number]>();
    for (const c of cols as any[]) {
      let t = byTable.get(c.t);
      if (!t) {
        const n = estBy.get(c.t);
        t = { name: c.t, est_rows: n != null && n >= 0 ? n : null, columns: [] };
        byTable.set(c.t, t);
      }
      const type = c.dt === "character varying" ? `varchar${c.len ? `(${c.len})` : ""}`
        : c.dt === "ARRAY" ? `${String(c.udt).replace(/^_/, "")}[]`
        : c.dt === "USER-DEFINED" ? String(c.udt)
        : c.dt === "timestamp without time zone" ? "timestamp"
        : String(c.dt);
      const ix = idxBy.get(`${c.t}.${c.n}`);
      t.columns.push({ n: c.n, t: type, nn: !!c.nn, pk: !!ix?.pk, idx: ix ? (ix.uq && !ix.pk ? "unique" : true) : false });
    }
    schema = [...byTable.values()];
    const probed = new Set(tables.map((t) => t.name));
    for (const t of schema) {
      if (!probed.has(t.name)) tables.push({ name: t.name, source: "planner estimate (pg_class.reltuples)", count: t.est_rows, latest_update: null } as any);
    }
  } catch {
    // The catalog overlay is optional; the probed stats above still stand.
  }

  res.status(200).json({
    ok: true,
    db_ready: true,
    generated_at: new Date().toISOString(),
    tables,
    schema,
    last_ingest_runs,
  });
}
