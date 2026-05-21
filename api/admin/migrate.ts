import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { neon } from "@neondatabase/serverless";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only callable with CRON_SECRET to prevent random schema rewrites
  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized — set CRON_SECRET env var and pass it as Bearer token" });
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    res.status(503).json({ error: "DATABASE_URL not configured" });
    return;
  }

  const sql = neon(url);
  // On Vercel, the migrations folder is bundled at the project root
  const candidateDirs = [
    join(process.cwd(), "migrations"),
    join(process.cwd(), "..", "migrations"),
    "/var/task/migrations",
  ];
  let dir: string | null = null;
  for (const d of candidateDirs) {
    try {
      readdirSync(d);
      dir = d;
      break;
    } catch {
      continue;
    }
  }
  if (!dir) {
    res.status(500).json({ error: "Could not locate migrations folder", tried: candidateDirs });
    return;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: Array<{ file: string; statements: number; skipped: number }> = [];

  for (const file of files) {
    const path = join(dir, file);
    const content = readFileSync(path, "utf-8");
    // Split ONLY on the explicit Drizzle statement-breakpoint marker.
    // Splitting on raw `;` shreds PL/pgSQL DO $$ ... EXCEPTION ... END $$ blocks into invalid fragments.
    const statements = content
      .split(/-->\s*statement-breakpoint/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.split("\n").every((line) => line.trim().startsWith("--") || line.trim().length === 0));

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
        return res.status(500).json({
          error: `Migration ${file} failed`,
          statement: stmt.slice(0, 300),
          message: err?.message,
        });
      }
    }
    applied.push({ file, statements: ran, skipped });
  }

  res.status(200).json({ ok: true, dir, applied });
}
