import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomBytes } from "node:crypto";

const STATE_COOKIE = "vi_state";

/** Starts the Microsoft Entra authorization-code flow (Vistamark tenant). */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  const tenant = process.env.AUTH_MICROSOFT_ENTRA_TENANT_ID;
  const clientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
  if (!tenant || !clientId) {
    res.redirect(302, "/login.html?error=not_configured");
    return;
  }
  const xf = req.headers["x-forwarded-host"];
  const host = (Array.isArray(xf) ? xf[0] : xf) || req.headers.host || "vistaintel.app";
  const redirectUri = `https://${host}/api/auth/callback`;

  const state = randomBytes(16).toString("hex");
  const rawNext = typeof req.query.next === "string" ? req.query.next : "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
  res.setHeader(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}:${encodeURIComponent(next)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
  );

  const authorize = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_mode", "query");
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("prompt", "select_account");
  authorize.searchParams.set("domain_hint", "vistamarkllc.com");
  res.redirect(302, authorize.toString());
}
