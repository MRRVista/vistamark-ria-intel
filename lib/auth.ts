import type { VercelRequest } from "@vercel/node";

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Validate the inbound request carries either:
 *   - ACCESS_TOKEN header (matching env var) — MCP client auth
 *   - Authorization: Bearer ACCESS_TOKEN — alt form
 *   - Standard Vercel cron header (for cron endpoints, validated separately)
 */
export function requireAccess(req: VercelRequest): { ok: true } | { ok: false; reason: string } {
  if (!ACCESS_TOKEN) {
    // In development, allow if no token configured (warned at startup)
    if (process.env.NODE_ENV !== "production") return { ok: true };
    return { ok: false, reason: "Server is missing ACCESS_TOKEN env var" };
  }

  const headerToken =
    (req.headers["access_token"] as string | undefined) ??
    (req.headers["access-token"] as string | undefined);
  if (headerToken && headerToken === ACCESS_TOKEN) return { ok: true };

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && auth.slice(7) === ACCESS_TOKEN) return { ok: true };

  return { ok: false, reason: "Missing or invalid ACCESS_TOKEN" };
}

export function requireCron(req: VercelRequest): { ok: true } | { ok: false; reason: string } {
  // Vercel injects this header automatically on scheduled cron invocations
  const cronHeader = req.headers["x-vercel-cron"];
  if (cronHeader) return { ok: true };

  // Allow manual trigger with CRON_SECRET (for backfills)
  if (CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${CRON_SECRET}`) return { ok: true };
  }

  return { ok: false, reason: "Not a valid cron invocation" };
}
