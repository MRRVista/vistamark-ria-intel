import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SESSION_COOKIE } from "../../lib/session";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
  res.redirect(302, "/login.html?signedout=1");
}
