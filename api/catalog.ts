import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../lib/mcp/tools";
import { DOMAINS, PROBE_SOURCE, probeSummary, reconcile } from "../lib/mcp/catalog";

/**
 * GET /api/catalog        — grouped manifest + inputSchemas + drift report
 * GET /api/catalog?health=1 — same, plus live ingest pipelineHealth
 *
 * This is the console's bootstrap call. It exists so the UI can render the
 * full 64-tool navigation AND generate input forms from one request, instead
 * of doing tools/list over JSON-RPC and then re-deriving groupings client-side.
 *
 * Auth rides requireAccessOrSession: an Entra session cookie (browser) or an
 * ACCESS_TOKEN header (automation). Same contract as the Query Console.
 */

const HEALTH_TIMEOUT_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms)),
  ]);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ACCESS_TOKEN, access_token");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

  const auth = await requireAccessOrSession(req);
  if (!auth.ok) { res.status(401).json({ error: auth.reason }); return; }

  const registryNames = TOOLS.map((t) => t.name);
  const drift = reconcile(registryNames);

  // Join the taxonomy to the live registry. inputSchema comes from the
  // registry (never duplicated in the catalog) so forms can never drift from
  // what the handler actually accepts.
  const domains = DOMAINS.map((d) => ({
    id: d.id,
    label: d.label,
    source: d.source,
    toolCount: d.tools.length,
    tools: d.tools.map((t) => {
      const live = TOOL_BY_NAME[t.name];
      return {
        name: t.name,
        backing: t.backing,
        probe: t.probe,
        note: t.note ?? null,
        // `registered: false` means the catalog references a tool the server
        // no longer exposes — the console greys it out instead of rendering a
        // form that would 404 on call.
        registered: Boolean(live),
        description: live?.description ?? null,
        inputSchema: live?.inputSchema ?? null,
      };
    }),
  }));

  // Any tool present in the registry but absent from the taxonomy still gets
  // surfaced, in an explicit bucket. Hiding it would be the worse failure.
  if (drift.uncatalogued.length > 0) {
    domains.push({
      id: "uncatalogued",
      label: "Uncatalogued",
      source: "Present in lib/mcp/tools.ts but missing from lib/mcp/catalog.ts",
      toolCount: drift.uncatalogued.length,
      tools: drift.uncatalogued.map((name) => {
        const live = TOOL_BY_NAME[name];
        return {
          name,
          backing: "live-api" as const,
          probe: "unprobed" as const,
          note: "Not yet assigned to a data domain.",
          registered: true,
          description: live?.description ?? null,
          inputSchema: live?.inputSchema ?? null,
        };
      }),
    });
  }

  const payload: Record<string, unknown> = {
    server: "vistamark-ria-intel",
    generatedAt: new Date().toISOString(),
    identity: auth.via === "session" ? { via: "session", email: auth.email, kind: auth.kind } : { via: "token" },
    counts: {
      domains: DOMAINS.length,
      tools: registryNames.length,
      probe: probeSummary(),
    },
    probeSource: PROBE_SOURCE,
    drift,
    domains,
  };

  if (req.query.health === "1") {
    const statusTool = TOOL_BY_NAME["database_status"];
    if (!statusTool) {
      payload.health = { ok: false, error: "database_status tool not registered" };
    } else {
      try {
        const result: any = await withTimeout(
          Promise.resolve(statusTool.handler({})),
          HEALTH_TIMEOUT_MS,
          "database_status"
        );
        payload.health = {
          ok: true,
          dbReady: result?.dbReady ?? null,
          firmCount: result?.firmCount ?? null,
          pipelineHealth: result?.pipelineHealth ?? null,
        };
      } catch (err) {
        // A health-overlay failure must not fail the whole catalog — the
        // console still needs the navigation tree to render.
        payload.health = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  res.setHeader("Cache-Control", "private, max-age=30");
  res.status(200).json(payload);
}
