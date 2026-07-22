import type { VercelRequest } from "@vercel/node";
import { verifySession, readCookie, SESSION_COOKIE } from "./session";

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

/**
 * Accept EITHER the automation credential (ACCESS_TOKEN / Bearer header —
 * Randall, VistaBuilder, scripts) OR a live Vistamark Entra session cookie
 * (minted by /api/auth/callback after VistaCRM authorization). This is what
 * lets the Query Console and Schema Atlas ride the Microsoft sign-in with
 * no pasted token, while headless callers keep the same token contract.
 *
 * The cookie path is same-origin only by construction: vi_session is
 * SameSite=Lax (cross-site POSTs never carry it) and browsers refuse to
 * pair credentials with the wildcard CORS header these endpoints set.
 */
export async function requireAccessOrSession(
  req: VercelRequest
): Promise<{ ok: true; via: "token" | "session"; email?: string; kind?: string } | { ok: false; reason: string }> {
  const viaToken = requireAccess(req);
  if (viaToken.ok) return { ok: true, via: "token" };

  const secret = process.env.SESSION_SECRET;
  if (secret) {
    const session = await verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), secret);
    if (session) return { ok: true, via: "session", email: session.email, kind: session.kind };
  }
  return { ok: false, reason: "Sign in with your Vistamark account or provide ACCESS_TOKEN" };
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
