import type { VercelRequest, VercelResponse } from "@vercel/node";
import { defaultSchHYear, ingestScheduleHI, type Schedule } from "../../lib/dol-5500/schedule-h";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual DOL Form 5500 Schedule H + I (plan financials / asset mix) ingest
 * trigger. Bearer CRON_SECRET required. Requires migration 0010.
 * ?year=YYYY (default DOL_5500_YEAR), ?schedule=H|I to load just one.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-dol-sch-h",
      description:
        "Manual trigger for DOL Form 5500 Schedule H (large plans) + Schedule I (small plans) ingest into dol_sch_h_i — restores plan total assets missing from F_5500 since 2024 and adds the asset-class breakdown. POST with Bearer CRON_SECRET. Run /api/admin/migrate first (migration 0010).",
      defaultYear: defaultSchHYear(),
      params: { year: "Optional YYYY override", schedule: "Optional H or I (default both)" },
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
    year = defaultSchHYear();
  }
  const schedParam = ((req.query.schedule as string | undefined) ?? "").toUpperCase();
  let schedules: Schedule[] = ["H", "I"];
  if (schedParam) {
    if (schedParam !== "H" && schedParam !== "I") {
      res.status(400).json({ error: "schedule must be H or I" });
      return;
    }
    schedules = [schedParam];
  }

  try {
    const result = await ingestScheduleHI(year, schedules);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      year,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
