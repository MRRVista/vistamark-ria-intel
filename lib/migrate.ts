/**
 * The one migration runner. Used by:
 *   - api/admin/migrate.ts          (manual trigger, Bearer CRON_SECRET)
 *   - api/admin/bootstrap-once.ts
 *   - api/cron/refresh-ipeds.ts, refresh-nacubo.ts, prospect-engine.ts,
 *     nonprofit-engine.ts           (auto-bootstrap when their tables are missing)
 *   - scripts/migrate.ts            (local + the GitHub Actions data loaders)
 *
 * Ledger (v0.39): each file that applies cleanly is recorded in
 * schema_migrations and never replayed. Before the ledger every call re-ran
 * all files and leaned on every statement being idempotent — true so far, but
 * it meant a single UPDATE or DROP in a future migration would fire on every
 * cron bootstrap. The first run against an existing database replays the
 * (idempotent) history once and records it; from then on only new files run.
 *
 * Within a file, statements failing with "already exists" or "duplicate" are
 * still skipped, so a file interrupted halfway can simply be run again.
 *
 * DATABASE_DRIVER=pg runs the same thing over node-postgres (local / tests);
 * the default is Neon's HTTP driver, as in lib/db.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { neon } from "@neondatabase/serverless";
import { sql as dsql } from "drizzle-orm";
import { db } from "./db";

const CANDIDATE_DIRS = [
  join(process.cwd(), "migrations"),
  join(process.cwd(), "..", "migrations"),
  "/var/task/migrations",
];

function findMigrationsDir(): string | null {
  for (const d of CANDIDATE_DIRS) {
    try {
      readdirSync(d);
      return d;
    } catch {
      continue;
    }
  }
  return null;
}

export interface MigrationFileResult {
  file: string;
  statements: number;
  skipped: number;
  /** True when the ledger already had this file and nothing was executed. */
  alreadyApplied?: boolean;
}

type Exec = (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

async function connect(url: string): Promise<{ exec: Exec; close: () => Promise<void> }> {
  if (process.env.DATABASE_DRIVER === "pg") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require("pg") as typeof import("pg");
    const client = new Client({ connectionString: url });
    await client.connect();
    return {
      exec: async (text, params) => (await client.query(text, params as any[])).rows,
      close: () => client.end(),
    };
  }
  const sql = neon(url);
  return {
    exec: async (text, params) => (await sql(text, (params ?? []) as any[])) as Array<Record<string, unknown>>,
    close: async () => {},
  };
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
  statements INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0
)`;

export type MigrationRunSummary =
  | { ok: true; dir: string; applied: MigrationFileResult[] }
  | { ok: false; error: string; dir?: string; statement?: string };

export async function runMigrations(): Promise<MigrationRunSummary> {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, error: "DATABASE_URL not configured" };

  const dir = findMigrationsDir();
  if (!dir) {
    return {
      ok: false,
      error: "Could not locate migrations folder (tried " + CANDIDATE_DIRS.join(", ") + ")",
    };
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: MigrationFileResult[] = [];
  const { exec, close } = await connect(url);

  try {
    await exec(LEDGER_DDL);
    const done = new Set((await exec("SELECT filename FROM schema_migrations")).map((r) => String(r.filename)));

  for (const file of files) {
    if (done.has(file)) {
      applied.push({ file, statements: 0, skipped: 0, alreadyApplied: true });
      continue;
    }
    const content = readFileSync(join(dir, file), "utf-8");
    const statements = content
      .split(/-->\s*statement-breakpoint/i)
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.length > 0 &&
          !s
            .split("\n")
            .every((line) => line.trim().startsWith("--") || line.trim().length === 0)
      );

    let ran = 0;
    let skipped = 0;
    for (const stmt of statements) {
      try {
        await exec(stmt);
        ran++;
      } catch (err: any) {
        if (/already exists|duplicate/i.test(err?.message ?? "")) {
          skipped++;
          continue;
        }
        return {
          ok: false,
          dir,
          error: `Migration ${file} failed: ${err?.message ?? String(err)}`,
          statement: stmt.slice(0, 300),
        };
      }
    }
    await exec(
      "INSERT INTO schema_migrations (filename, statements, skipped) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING",
      [file, ran, skipped]
    );
    applied.push({ file, statements: ran, skipped });
  }

  return { ok: true, dir, applied };
  } finally {
    await close().catch(() => {});
  }
}

/**
 * Cheap check: does the v0.4.0 schema exist? Returns true if
 * ipeds_institutions is present. Used by cron handlers to decide whether
 * to auto-bootstrap migrations on this tick.
 */
export async function v04TablesExist(): Promise<boolean> {
  if (!db) return false;
  try {
    const r = await db.execute(
      dsql`SELECT to_regclass('public.ipeds_institutions') AS r`
    );
    const rows = (r as any).rows ?? [];
    return rows[0]?.r != null;
  } catch {
    return false;
  }
}
