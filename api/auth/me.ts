import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifySession, readCookie, SESSION_COOKIE } from "../../lib/session";

/** Session info for the signed-in caller — identity as resolved through VistaCRM. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env.SESSION_SECRET;
  const session = secret
    ? await verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), secret)
    : null;
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }
  res.status(200).json({
    authenticated: true,
    email: session.email,
    name: session.name,
    principal: {
      id: session.principalId,
      kind: session.kind,
      canWrite: session.canWrite,
      source: session.src,
    },
  });
}
