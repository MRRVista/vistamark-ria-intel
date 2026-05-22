import type { VercelRequest, VercelResponse } from "@vercel/node";
import { defaultIngestYear, ingestYear } from "../../lib/dol-5500/ingest";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual DOL Form 5500 ingest trigger. Bearer CRON_SECRET required.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-dol-5500",
      description: "Manual trigger for DOL Form 5500 main filing ingest. POST with Bearer CRON_SECRET.",
      defaultYear: defaultIngestYear(),
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
    year = defaultIngestYear();
  }

  try {
    const result = await ingestYear(year);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      year,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
