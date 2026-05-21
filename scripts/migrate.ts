import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { neon } from "@neondatabase/serverless";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const sql = neon(url);
  const dir = join(process.cwd(), "migrations");

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const path = join(dir, file);
    console.log(`Applying ${file}...`);
    const content = readFileSync(path, "utf-8");
    // Split on statement-breakpoint (Drizzle convention) or on ;
    const statements = content
      .split(/--> statement-breakpoint|;\s*$/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("--"));

    for (const stmt of statements) {
      try {
        await sql(stmt);
      } catch (err: any) {
        if (/already exists|duplicate/i.test(err?.message ?? "")) {
          console.log(`  (skipped: ${err.message.split("\n")[0]})`);
          continue;
        }
        throw err;
      }
    }
    console.log(`  done.`);
  }

  console.log("All migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
