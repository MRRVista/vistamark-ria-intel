import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../../lib/auth";
import { irs990Status } from "../../lib/irs990/queries";
import { DEFAULT_INDEX_YEARS, listIndexBatches } from "../../lib/irs990/ingest";

/**
 * GET /api/admin/irs990            — loader ledger: totals, per-batch status, filings by year/type
 * GET /api/admin/irs990?index=2025 — also diff the IRS index for that year against the ledger
 *
 * Read-only. The loader itself runs in GitHub Actions (.github/workflows/
 * irs990-ingest.yml) because a batch is too large for a Vercel function;
 * this endpoint is how the console and Randall see what it has done.
 *
 * Auth: ACCESS_TOKEN header or Entra session, like the rest of /api/admin/*.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "GET only" });
    return;
  }
  const auth = await requireAccessOrSession(req);
  if (!auth.ok) {
    res.status(401).json({ ok: false, error: auth.reason });
    return;
  }
  try {
    const status = await irs990Status();
    let indexDiff: unknown = undefined;
    const indexYear = typeof req.query.index === "string" ? Number(req.query.index) : NaN;
    if (Number.isInteger(indexYear)) {
      const batches = await listIndexBatches(indexYear);
      const ok = new Set(((status as any).batches ?? []).filter((b: any) => b.status === "ok").map((b: any) => String(b.batch_id)));
      indexDiff = {
        indexYear,
        batches: batches.map((b) => ({ ...b, loaded: ok.has(b.batchId) })),
        pending: batches.filter((b) => !ok.has(b.batchId)).map((b) => b.batchId),
      };
    }
    res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      loader: {
        where: "GitHub Actions workflow 'IRS 990 ingest' (.github/workflows/irs990-ingest.yml)",
        schedule: "monthly, 8th 08:10 UTC; manual dispatch for backfills",
        defaultIndexYears: DEFAULT_INDEX_YEARS,
        source: "https://apps.irs.gov/pub/epostcard/990/xml/<year>/",
      },
      ...status,
      ...(indexDiff ? { indexDiff } : {}),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
