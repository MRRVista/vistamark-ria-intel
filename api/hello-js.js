// Plain JavaScript — no TypeScript, no compilation step.
// If this returns 200 and api/hello.ts does not, the issue is TypeScript-specific.
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    runtime: "js",
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    hasDbUrl: Boolean(process.env.DATABASE_URL),
    hasAccessToken: Boolean(process.env.ACCESS_TOKEN),
    hasCronSecret: Boolean(process.env.CRON_SECRET),
  });
};
