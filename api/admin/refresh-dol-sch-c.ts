import type { VercelRequest, VercelResponse } from "@vercel/node";
import { defaultSchCYear, ingestScheduleC } from "../../lib/filings-people/schedule-c";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual DOL Form 5500 Schedule C (Part I Item 2 service providers) ingest
 * trigger. Bearer CRON_SECRET required. Requires migration 0009.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-dol-sch-c",
      description:
        "Manual trigger for DOL Form 5500 Schedule C Part I Item 2 (service providers + comp) ingest into dol_sch_c_providers. POST with Bearer CRON_SECRET. Run /api/admin/migrate first (migration 0009).",
      defaultYear: defaultSchCYear(),
      params: { year: "Optional YYYY override" },
    });
    return;
  }

  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized — Bearer CRON_SECRET required" });
    return;
  }

  const yearParam = req.query.year as string | undefined;
  let year: number;
  if (yearParam) {
    if (!/^\d{4}$/.test(yearParam)) {
      res.status(400).json({ error: "year must be a 4-digit YYYY" });
      return;
    }
    year = Number(yearParam);
  } else {
    year = defaultSchCYear();
  }

  try {
    const result = await ingestScheduleC(year);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      year,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
