/**
 * Re-sync the catalog's probe snapshot from a full selftest run.
 *
 *   curl -s https://vistaintel.app/api/selftest > selftest.json
 *   npx tsx scripts/sync-probes.ts selftest.json
 *
 * Writes lib/mcp/probe-snapshot.json, which lib/mcp/catalog.ts overlays on the
 * hand-written probe values. Per tool, the worst result across its checks
 * wins: any error -> degraded (with the error as the note), a selftest
 * timeout -> slow, otherwise live. Tools no check covers are left out and keep
 * whatever the catalog says (usually "unprobed").
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface Check { name: string; tool: string; ok: boolean; ms: number; error?: string }
type Probe = "live" | "slow" | "degraded";
const RANK: Record<Probe, number> = { live: 0, slow: 1, degraded: 2 };

const file = process.argv[2];
if (!file) { console.error("usage: tsx scripts/sync-probes.ts <selftest.json>"); process.exit(1); }
const run = JSON.parse(readFileSync(file, "utf-8")) as { ranAt: string; checksRun: number; passed: number; failed: number; concurrency?: number; checks: Check[] };

const tools: Record<string, { probe: Probe; note?: string }> = {};
for (const c of run.checks) {
  const timedOut = !c.ok && /selftest timeout/i.test(c.error ?? "");
  const probe: Probe = c.ok ? "live" : timedOut ? "slow" : "degraded";
  const note = c.ok ? undefined
    : timedOut ? `Exceeded the selftest per-check budget (${c.ms}ms) in check "${c.name}".`
    : `Check "${c.name}" failed: ${(c.error ?? "unknown error").replace(/\s+/g, " ").slice(0, 200)}`;
  const prev = tools[c.tool];
  if (!prev || RANK[probe] > RANK[prev.probe]) tools[c.tool] = note ? { probe, note } : { probe };
}

const out = {
  endpoint: "/api/selftest",
  ranAt: run.ranAt,
  checksRun: run.checksRun,
  passed: run.passed,
  failed: run.failed,
  concurrency: run.concurrency ?? null,
  tools: Object.fromEntries(Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(join(__dirname, "..", "lib", "mcp", "probe-snapshot.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`probe-snapshot.json: ${Object.keys(tools).length} tools from ${run.checksRun} checks (${run.passed} passed, ${run.failed} failed)`);
