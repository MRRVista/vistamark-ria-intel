/**
 * Bulk data loads that are too big / too slow for a Vercel lambda, run from
 * GitHub Actions over the `pg` driver (DATABASE_DRIVER=pg) straight into Neon.
 *
 *   npx tsx scripts/data-loads.ts --jobs sch-h,ppp,13f [--year 2024]
 *        [--ppp-files 150k_plus|all] [--ppp-max-rows N]
 *        [--f13-url <zip url>] [--f13-manager <substr>] [--f13-max-holdings N]
 *
 * Jobs
 *   sch-h  DOL Form 5500 Schedule H + I for --year (default DOL_5500_YEAR or
 *          current-2). Restores plan total assets / asset mix (migration 0010).
 *   ppp    SBA PPP FOIA loan-level CSVs from data.sba.gov. Default = the
 *          national >= $150K file (~1M rows). --ppp-files all adds the twelve
 *          <= $150K national chunks (~10M rows; several hours on Neon).
 *   13f    SEC Form 13F quarterly data set. Default = the newest zip linked on
 *          sec.gov/data-research/sec-markets-data/form-13f-data-sets; filings
 *          table in full, holdings in full unless --f13-manager / max given.
 *
 * Every job records ingest_runs rows via the existing library loaders, so
 * database_status / the console Status page see these exactly like crons.
 * Needs DATABASE_URL. Idempotent (upserts) — safe to re-run.
 */
import { politeFetch } from "../lib/data/http";

process.env.DATABASE_DRIVER = process.env.DATABASE_DRIVER || "pg";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const PPP_PAGE = "https://data.sba.gov/dataset/ppp-foia";
const F13_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets";

async function pppUrls(all: boolean): Promise<string[]> {
  const res = await politeFetch(PPP_PAGE, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`PPP page HTTP ${res.status}`);
  const html = await res.text();
  const urls = Array.from(new Set(html.match(/https?:\/\/data\.sba\.gov\/[^"' ]+\.csv/g) ?? []));
  const plus = urls.filter((u) => /150k_plus/i.test(u));
  const upTo = urls.filter((u) => /up_to_150k/i.test(u)).sort();
  if (!plus.length) throw new Error("PPP: no 150k_plus CSV link found on data.sba.gov");
  return all ? [...plus, ...upTo] : plus;
}

async function latest13fUrl(): Promise<string> {
  const res = await politeFetch(F13_PAGE, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`13F page HTTP ${res.status}`);
  const html = await res.text();
  const hrefs = Array.from(html.matchAll(/href="([^"]*form-13f-data-sets\/[^"]*_form13f\.zip)"/gi)).map((m) => m[1]!);
  if (!hrefs.length) throw new Error("13F: no quarterly zip link found on sec.gov");
  // Page lists newest first.
  const h = hrefs[0]!;
  return h.startsWith("http") ? h : `https://www.sec.gov${h}`;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const jobs = (arg("jobs") ?? "sch-h,ppp,13f").split(",").map((s) => s.trim()).filter(Boolean);
  const summary: Record<string, unknown> = {};
  const failures: string[] = [];

  for (const job of jobs) {
    const t0 = Date.now();
    try {
      if (job === "sch-h") {
        const { ingestScheduleHI } = await import("../lib/dol-5500/schedule-h");
        const { defaultIngestYear } = await import("../lib/dol-5500/ingest");
        const year = Number(arg("year") ?? process.env.DOL_5500_YEAR ?? defaultIngestYear());
        console.log(`[sch-h] year ${year}`);
        const r = await ingestScheduleHI(year);
        summary[job] = r;
      } else if (job === "ppp") {
        const { ingestPpp } = await import("../lib/sba-ppp/ingest");
        const urls = await pppUrls(arg("ppp-files") === "all");
        const maxRows = arg("ppp-max-rows") ? Number(arg("ppp-max-rows")) : undefined;
        const results: unknown[] = [];
        for (const u of urls) {
          console.log(`[ppp] ${u}`);
          results.push(await ingestPpp(u, maxRows));
        }
        summary[job] = results;
      } else if (job === "13f") {
        const { ingest13f } = await import("../lib/sec-13f/ingest");
        const url = arg("f13-url") ?? (await latest13fUrl());
        console.log(`[13f] ${url}`);
        summary[job] = await ingest13f(url, {
          managerFilter: arg("f13-manager") || undefined,
          maxHoldings: arg("f13-max-holdings") ? Number(arg("f13-max-holdings")) : undefined,
        });
      } else {
        throw new Error(`unknown job ${job}`);
      }
      console.log(`[${job}] done in ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(summary[job]).slice(0, 600));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${job}] FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${msg}`);
      failures.push(`${job}: ${msg}`);
      summary[job] = { error: msg };
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("fs");
    const lines = ["## Data loads", "", "| job | result |", "|---|---|"];
    for (const [k, v] of Object.entries(summary)) lines.push(`| ${k} | \`${JSON.stringify(v).slice(0, 400).replace(/\|/g, "\\|")}\` |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
  if (failures.length) {
    console.error(`\n${failures.length} job(s) failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
