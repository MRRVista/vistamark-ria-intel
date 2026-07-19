/**
 * Vercel Edge Middleware — gates the human-facing pages behind the
 * Microsoft Entra sign-in (session minted by /api/auth/callback after the
 * caller has been resolved against VistaCRM principals).
 *
 * Deliberately matcher-scoped to the three pages only: /api/mcp,
 * /api/admin/* and /api/cron/* keep their existing token auth (Randall's
 * MCP client and the Vercel crons are unaffected), and /login.html plus
 * /api/auth/* stay public.
 */
import { verifySession, readCookie, SESSION_COOKIE } from "./lib/session";

export const config = {
  matcher: ["/", "/index.html", "/query.html", "/schema.html"],
};

export default async function middleware(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const secret = process.env.SESSION_SECRET;
  const session = secret
    ? await verifySession(readCookie(request.headers.get("cookie"), SESSION_COOKIE), secret)
    : null; // no secret configured -> fail closed
  if (session) return undefined; // authenticated: continue to the page
  const login = new URL("/login.html", url);
  const next = url.pathname === "/index.html" ? "/" : url.pathname;
  if (next !== "/login.html") login.searchParams.set("next", next);
  return Response.redirect(login, 302);
}
