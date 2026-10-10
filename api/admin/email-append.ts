import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession, requireCron } from "../../lib/auth";
import { appendProviderReady, runEmailAppend, type AppendProvider } from "../../lib/prospects/append";

/**
 * Email append (v0.24.0) — name + postal address -> email, for prospects.
 *
 *   GET /api/admin/email-append?provider=atdata&minHomeValue=2000000&limit=25&dryRun=1
 *   GET /api/admin/email-append?provider=published&limit=6
 *   GET /api/admin/email-append?status=1          (which providers are configured)
 *
 * Auth: Bearer CRON_SECRET, ACCESS_TOKEN, or a signed-in Vistamark session.
 * Params: provider=atdata|published (required) · zip=60521[,60527] · minHomeValue ·
 * limit (atdata ≤500, published ≤15) · acceptHousehold=1 (atdata; default Individual only) ·
 * trustFirst=1 · dryRun=1 (no external calls, no writes).
 *
 * Never scheduled: every paid lookup is a deliberate run.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    const auth = await requireAccessOrSession(req);
    if (!auth.ok) {
      res.status(401).json({ ok: false, error: auth.reason });
      return;
    }
  }
  const q = (k: string) => (Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]) as string | undefined;
  const flag = (k: string) => ["1", "true", "yes"].includes((q(k) ?? "").toLowerCase());

  if (flag("status")) {
    res.status(200).json({
      ok: true,
      providers: {
        atdata: appendProviderReady("atdata") ?? "ready",
        published: appendProviderReady("published") ?? "ready",
      },
    });
    return;
  }

  const provider = (q("provider") ?? "").toLowerCase() as AppendProvider;
  if (provider !== "atdata" && provider !== "published") {
    res.status(400).json({ ok: false, error: "provider must be atdata or published" });
    return;
  }

  try {
    const summary = await runEmailAppend({
      provider,
      zips: q("zip") ? q("zip")!.split(",").map((z) => z.trim()).filter(Boolean) : undefined,
      minHomeValue: q("minHomeValue") ? Number(q("minHomeValue")) : undefined,
      limit: q("limit") ? Number(q("limit")) : undefined,
      acceptHousehold: flag("acceptHousehold"),
      trustFirst: flag("trustFirst"),
      dryRun: flag("dryRun"),
      actor: cron.ok ? "email-append:cron-secret" : "email-append:console",
    });
    res.status(summary.ok ? 200 : 400).json(summary);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
