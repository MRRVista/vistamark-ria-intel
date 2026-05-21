import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Diagnostic endpoint — pure no-deps response.
 * If this returns 200, the lambda runtime is healthy and the crash is in our
 * application imports (drizzle, neon, etc).
 * If this also returns FUNCTION_INVOCATION_FAILED, there's a deeper config issue.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    hasDbUrl: Boolean(process.env.DATABASE_URL),
    hasAccessToken: Boolean(process.env.ACCESS_TOKEN),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
  });
}
