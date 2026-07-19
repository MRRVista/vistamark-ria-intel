import type { VercelRequest, VercelResponse } from "@vercel/node";
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE } from "../../lib/session";
import { resolvePrincipal } from "../../lib/crm";

const STATE_COOKIE = "vi_state";
const ALLOWED_DOMAIN = "@vistamarkllc.com";

function fail(res: VercelResponse, code: string): void {
  res.redirect(302, `/login.html?error=${encodeURIComponent(code)}`);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Completes the Entra code flow, then authorizes the caller through
 * VistaCRM — the Vistamark identity hub — per vistamark-crm/docs/ACCESS.md:
 * the oid/UPN claim must resolve to an active, can_read principal.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const tenant = process.env.AUTH_MICROSOFT_ENTRA_TENANT_ID;
  const clientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
  const clientSecret = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!tenant || !clientId || !clientSecret || !sessionSecret) return fail(res, "not_configured");

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  if (!code || !state) {
    const aadError = typeof req.query.error === "string" ? req.query.error : "missing_code";
    return fail(res, aadError);
  }

  const cookies = parseCookies(req.headers.cookie);
  const stateCookie = cookies[STATE_COOKIE] || "";
  const sep = stateCookie.indexOf(":");
  const expectedState = sep === -1 ? stateCookie : stateCookie.slice(0, sep);
  const nextRaw = sep === -1 ? "/" : decodeURIComponent(stateCookie.slice(sep + 1));
  if (!expectedState || expectedState !== state) return fail(res, "state_mismatch");

  const xf = req.headers["x-forwarded-host"];
  const host = (Array.isArray(xf) ? xf[0] : xf) || req.headers.host || "vistaintel.app";
  const redirectUri = `https://${host}/api/auth/callback`;

  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      scope: "openid profile email",
    }),
  });
  const tokens = (await tokenRes.json()) as { id_token?: string; error?: string };
  if (!tokenRes.ok || !tokens.id_token) return fail(res, tokens.error || "token_exchange_failed");

  // The id_token arrives server-to-server from Microsoft's token endpoint
  // over TLS in a confidential-client exchange; validate its claims.
  const segments = tokens.id_token.split(".");
  if (segments.length !== 3) return fail(res, "bad_id_token");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return fail(res, "bad_id_token");
  }
  const now = Math.floor(Date.now() / 1000);
  const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
  const oid = String(claims.oid ?? "");
  if (
    claims.iss !== `https://login.microsoftonline.com/${tenant}/v2.0` ||
    claims.aud !== clientId ||
    claims.tid !== tenant ||
    typeof claims.exp !== "number" ||
    claims.exp <= now - 60
  ) {
    return fail(res, "claims_invalid");
  }
  if (!email.endsWith(ALLOWED_DOMAIN)) return fail(res, "domain_not_allowed");

  // ── VistaCRM principals: the authorization source of truth ──
  let principal: Awaited<ReturnType<typeof resolvePrincipal>>;
  try {
    principal = await resolvePrincipal(oid, email);
  } catch {
    return fail(res, "crm_unreachable");
  }
  if (!principal) return fail(res, "not_a_principal");
  if (!principal.active) return fail(res, "principal_inactive");
  if (!principal.canRead) return fail(res, "principal_no_read");

  const session = await signSession(
    {
      sub: oid || String(claims.sub ?? ""),
      email,
      name: String(claims.name ?? principal.displayName),
      principalId: principal.id,
      kind: principal.kind,
      canWrite: principal.canWrite,
      src: principal.source,
    },
    sessionSecret
  );
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=${session}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    `${STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
  ]);
  const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";
  res.redirect(302, next);
}
