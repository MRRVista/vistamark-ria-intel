import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../../lib/auth";
import { irsEoExtrasStatus } from "../../lib/irs-eo-extras/queries";
import { DATASET_URLS } from "../../lib/irs-eo-extras/ingest";

/**
 * GET /api/admin/irs-eo-extras — loader ledger for Pub 78 / Auto-Revocation /
 * 990-N: migration state, row counts, latest load per dataset, 990-N filers
 * by tax year, revocations by year.
 *
 * Read-only. The loader itself runs in GitHub Actions (.github/workflows/
 * irs-eo-extras-ingest.yml) because the files are 100–286 MB inflated; this
 * endpoint is how the console and Randall see what it has done.
 *
 * Auth: Bearer CRON_SECRET (same key the workflows / backfills use), or the
 * ACCESS_TOKEN header / Entra session lane that /api/admin/irs990 accepts.
 */
function hasCronSecret(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "GET only" });
    return;
  }
  if (!hasCronSecret(req)) {
    const auth = await requireAccessOrSession(req);
    if (!auth.ok) {
      res.status(401).json({ ok: false, error: auth.reason });
      return;
    }
  }
  try {
    const status = await irsEoExtrasStatus();
    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      loader: {
        where: "GitHub Actions workflow 'IRS EO extras ingest' (.github/workflows/irs-eo-extras-ingest.yml)",
        schedule: "monthly, 10th 09:10 UTC; manual dispatch (datasets / dry / max_rows / force_swap)",
        semantics: "full refresh per dataset — load <table>_new, build indexes, swap in one transaction",
        sources: DATASET_URLS,
      },
      ...status,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
