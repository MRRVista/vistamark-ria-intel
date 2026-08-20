/**
 * Vercel Edge Middleware — gates the human-facing pages behind the
 * Microsoft Entra sign-in (session minted by /api/auth/callback after the
 * caller has been resolved against VistaCRM principals).
 *
 * Deliberately matcher-scoped to the app pages only: /api/mcp,
 * /api/admin/* and /api/cron/* keep their existing token auth (Randall's
 * MCP client and the Vercel crons are unaffected), and /login.html plus
 * /api/auth/* stay public.
 *
 * Anonymous-surface posture (Safe Browsing remediation, 07.20.2026): the
 * domain was flagged as deceptive the day SSO shipped — a day-old domain
 * whose every path 302s to a sign-in screen is the classic phishing-kit
 * signature. Anonymous requests to '/' therefore get the branded
 * landing/sign-in page served IN PLACE with a 200 (no redirect hop), so
 * the homepage is real first-party content. The app pages keep the 302 +
 * ?next= round-trip so post-login returns still work. Data exposure is
 * unchanged: query/schema and every token-gated API stay locked exactly
 * as before.
 *
 * Topology (08.20.2026): '/' now rewrites to /console.html — the dark/gold
 * console is the front door. The former light-palette landing card lives
 * at /overview.html, rebranded, reachable from the console's Overview tab.
 * /index.html 301s to '/' for anything still holding the old URL.
 */
import { verifySession, readCookie, SESSION_COOKIE } from "./lib/session";

export const config = {
  matcher: ["/", "/console.html", "/overview.html", "/query.html", "/schema.html"],
};

export default async function middleware(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url);
  const secret = process.env.SESSION_SECRET;
  const session = secret
    ? await verifySession(readCookie(request.headers.get("cookie"), SESSION_COOKIE), secret)
    : null; // no secret configured -> fail closed
  if (session) return undefined; // authenticated: continue to the page

  // Homepage for anonymous visitors: serve the landing/sign-in page as a
  // 200 at the requested path instead of redirecting to a login URL.
  if (url.pathname === "/") {
    try {
      const landing = await fetch(new URL("/login.html", url));
      if (landing.ok) {
        return new Response(landing.body, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
    } catch {
      // self-fetch failed -> fall through to the redirect below
    }
  }

  // App pages (and homepage fallback): redirect with a return path.
  const login = new URL("/login.html", url);
  const next = url.pathname === "/console.html" ? "/" : url.pathname;
  if (next !== "/login.html") login.searchParams.set("next", next);
  return Response.redirect(login, 302);
}
