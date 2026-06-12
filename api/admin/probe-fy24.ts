import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Probe NCES IPEDS for FY2023-24 finance file URL variants.
 *
 * The hard-coded URL https://nces.ed.gov/ipeds/datacenter/data/F2324_F2.zip
 * returns HTTP 404 from the every-15-min cron. This endpoint HEAD-checks a
 * battery of plausible variants to determine whether (a) NCES has not yet
 * published FY24 finance data, or (b) the URL convention has changed.
 *
 * Auth: Vercel SSO (canary deployment URLs).
 */
const VARIANTS = [
  // Standard naming we currently use
  "https://nces.ed.gov/ipeds/datacenter/data/F2324_F2.zip",
  "https://nces.ed.gov/ipeds/datacenter/data/F2324_F1A.zip",
  "https://nces.ed.gov/ipeds/datacenter/data/F2324_F3.zip",

  // Revised-suffix variants (final-data style NCES sometimes uses)
  "https://nces.ed.gov/ipeds/datacenter/data/F2324_F2_RV.zip",
  "https://nces.ed.gov/ipeds/datacenter/data/F2324_F1A_RV.zip",

  // Lowercase variants
  "https://nces.ed.gov/ipeds/datacenter/data/f2324_f2.zip",
  "https://nces.ed.gov/ipeds/datacenter/data/f2324_F2.zip",

  // No-underscore variants
  "https://nces.ed.gov/ipeds/datacenter/data/F2324F2.zip",
  "https://nces.ed.gov/ipeds/datacenter/data/F23_24_F2.zip",

  // Provisional-suffix variants
  "https://nces.ed.gov/ipeds/datacenter/data/F2324_F2_PV.zip",
  "https://nces.ed.gov/ipeds/datacenter/data/F2324_F2P.zip",

  // Known-working baseline (FY22-23) — sanity check that NCES is reachable
  "https://nces.ed.gov/ipeds/datacenter/data/F2223_F2.zip",

  // Next year — see whether even more recent data exists
  "https://nces.ed.gov/ipeds/datacenter/data/F2425_F2.zip",

  // DataFiles listing page (HTML)
  "https://nces.ed.gov/ipeds/datacenter/DataFiles.aspx?gotoReportId=7",
];

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const start = Date.now();

  const results = await Promise.all(
    VARIANTS.map(async (url) => {
      try {
        const r = await fetch(url, {
          method: url.endsWith(".zip") ? "HEAD" : "GET",
          headers: { "User-Agent": "vistamark-ria-intel/0.4.8 probe" },
          signal: AbortSignal.timeout(15_000),
        });
        let snippet: string | undefined;
        if (!url.endsWith(".zip") && r.ok) {
          const text = await r.text();
          // Pull any mention of F2324 or 2023-24 from the listing page so
          // we can see what NCES actually advertises.
          const hits = text.match(/F2324[A-Z0-9_-]*\.zip|2023-?24[^<>"\n]{0,80}/gi);
          snippet = hits ? hits.slice(0, 15).join(" | ") : text.slice(0, 500);
        }
        return {
          url,
          status: r.status,
          ok: r.ok,
          contentLength: r.headers.get("content-length"),
          contentType: r.headers.get("content-type"),
          snippet,
        };
      } catch (err) {
        return {
          url,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  res.status(200).json({
    ok: true,
    durationMs: Date.now() - start,
    results,
  });
}
