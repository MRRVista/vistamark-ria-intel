/**
 * Shared migration runner. Used by:
 *   - api/admin/migrate.ts        (manual trigger, Bearer CRON_SECRET)
 *   - api/cron/refresh-ipeds.ts   (auto-bootstrap when v0.4.0 tables missing)
 *   - api/cron/refresh-nacubo.ts  (same)
 *
 * Idempotent: statements failing with "already exists" or "duplicate" are
 * silently skipped, so re-running is safe.
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
}

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

  const sql = neon(url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: MigrationFileResult[] = [];

  for (const file of files) {
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
        await sql(stmt);
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
    applied.push({ file, statements: ran, skipped });
  }

  return { ok: true, dir, applied };
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
