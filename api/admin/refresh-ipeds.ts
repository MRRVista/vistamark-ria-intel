import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ingestDirectory,
  ingestFinance,
  pickNextFinance,
  isDirectoryNeeded,
  DEFAULT_DIRECTORY_YEAR,
  DEFAULT_FINANCE_YEARS,
} from "../../lib/ipeds/ingest";
import type { IpedsFinanceFile } from "../../lib/ipeds/columns";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Manual IPEDS ingest trigger. Bearer CRON_SECRET required.
 *
 * Usage:
 *   POST /api/admin/refresh-ipeds                       -> next (year, file) in backfill
 *   POST /api/admin/refresh-ipeds?mode=directory        -> ingest directory file (HD2023)
 *   POST /api/admin/refresh-ipeds?mode=directory&year=2024
 *   POST /api/admin/refresh-ipeds?fyear=2023&file=F2    -> specific finance file
 *   POST /api/admin/refresh-ipeds?fyear=2023&file=F1A   -> public FASB
 *   GET  /api/admin/refresh-ipeds                       -> show status
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    res.status(200).json({
      name: "refresh-ipeds",
      description:
        "IPEDS Finance Survey + Directory ingest. Source: NCES IPEDS Data Center.",
      directoryYearsAvailable: "2002..2024 (use ?mode=directory&year=YYYY)",
      financeYearsAvailable: DEFAULT_FINANCE_YEARS,
      financeFiles: ["F2 (private nonprofit FASB)", "F1A (public FASB)", "F3 (for-profit)"],
      usage:
        "POST with Bearer CRON_SECRET. Optional ?mode=directory|finance, ?year= (directory), " +
        "or ?fyear= and ?file=F2|F1A|F3 (finance).",
    });
    return;
  }

  const auth = req.headers.authorization;
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized -- Bearer CRON_SECRET required" });
    return;
  }

  const mode = (req.query.mode as string | undefined)?.toLowerCase();

  try {
    if (mode === "directory") {
      const yearStr = req.query.year as string | undefined;
      const year = yearStr ? Number(yearStr) : DEFAULT_DIRECTORY_YEAR;
      if (!Number.isFinite(year) || year < 2000 || year > 2030) {
        res.status(400).json({ error: `Invalid year: ${yearStr}` });
        return;
      }
      const result = await ingestDirectory(year);
      res.status(200).json({ ok: true, ...result });
      return;
    }

    const fyearStr = req.query.fyear as string | undefined;
    const fileStr = (req.query.file as string | undefined)?.toUpperCase();

    if (fyearStr && fileStr) {
      const fyear = Number(fyearStr);
      if (!Number.isFinite(fyear) || fyear < 2000 || fyear > 2030) {
        res.status(400).json({ error: `Invalid fyear: ${fyearStr}` });
        return;
      }
      if (fileStr !== "F2" && fileStr !== "F1A" && fileStr !== "F3") {
        res.status(400).json({ error: `Invalid file: ${fileStr}; use F2, F1A, or F3` });
        return;
      }
      const result = await ingestFinance(fyear, fileStr as IpedsFinanceFile);
      res.status(200).json({ ok: true, ...result });
      return;
    }

    // Default: pick next backfill step. If directory hasn't been ingested
    // yet, do that first; otherwise next finance file.
    if (await isDirectoryNeeded()) {
      const result = await ingestDirectory(DEFAULT_DIRECTORY_YEAR);
      res.status(200).json({ ok: true, stage: "directory", ...result });
      return;
    }

    const next = await pickNextFinance();
    if (!next) {
      res.status(200).json({
        ok: true,
        stage: "finance",
        skipped: "backfill complete; nothing to ingest",
      });
      return;
    }
    const result = await ingestFinance(next.fyear, next.fileType);
    res.status(200).json({ ok: true, stage: "finance", ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
