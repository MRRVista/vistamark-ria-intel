import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireCron } from "../../lib/auth";
import { ingestCountyParcels, type County, type ParcelIngestResult } from "../../lib/prospects/parcels";

/**
 * County parcel ingest (v0.23.0) — DuPage + Cook property rolls -> prospects.
 *
 *   GET /api/cron/ingest-parcels                         (Vercel cron, monthly: both counties, Hinsdale)
 *   GET /api/cron/ingest-parcels?county=dupage&dryRun=1  (Bearer CRON_SECRET)
 *
 * Params: county=dupage|cook|both (default both) · city=HINSDALE · dryRun=1 ·
 * includeAbsentee=1 · limit=N (testing).
 * Loads owner-occupied residents only by default; entity owners are counted
 * and sampled, not loaded. Writes through importRecords(), so re-runs merge.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    res.status(401).json({ error: cron.reason });
    return;
  }
  const q = (k: string) => (Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]) as string | undefined;
  const which = (q("county") ?? "both").toLowerCase();
  const counties: County[] = which === "both" ? ["dupage", "cook"] : which === "cook" ? ["cook"] : ["dupage"];
  const flag = (k: string) => ["1", "true", "yes"].includes((q(k) ?? "").toLowerCase());
  const limit = q("limit") ? Math.max(1, Number(q("limit"))) : undefined;

  const results: Array<ParcelIngestResult | { county: County; ok: false; error: string }> = [];
  for (const county of counties) {
    try {
      results.push(
        await ingestCountyParcels(county, {
          city: q("city") ?? "HINSDALE",
          dryRun: flag("dryRun"),
          includeAbsentee: flag("includeAbsentee"),
          submittedBy: "cron:ingest-parcels",
          limit,
        })
      );
    } catch (err) {
      results.push({ county, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const ok = results.every((r) => !("ok" in r && r.ok === false));
  res.status(ok ? 200 : 500).json({ ok, dryRun: flag("dryRun"), results });
}
