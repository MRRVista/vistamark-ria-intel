/**
 * Apply every migrations/*.sql file (idempotent). Delegates to the same
 * runner the Vercel admin/cron endpoints use (lib/migrate.ts) so local, CI
 * and production apply statements identically — including statements that
 * open with a comment block, which the previous standalone splitter dropped.
 */
import { runMigrations } from "../lib/migrate";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const r = await runMigrations();
  if (!r.ok) {
    console.error(`Migration failed: ${r.error}`);
    if (r.statement) console.error(r.statement);
    process.exit(1);
  }
  for (const f of r.applied) console.log(`${f.file}: ${f.statements} ran, ${f.skipped} skipped`);
  console.log("All migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
