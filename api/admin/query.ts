import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccess } from "../../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../../lib/mcp/tools";

/**
 * POST /api/admin/query
 *
 * REST-style wrapper around the MCP tool registry. Every tool defined in
 * lib/mcp/tools.ts is automatically callable here — no per-tool plumbing,
 * no SQL duplication.
 *
 *   POST /api/admin/query
 *   { "tool": "search_rias", "args": { "q": "Vistamark", "limit": 20 } }
 *
 * Returns:
 *   { ok: true, tool, args, result: <whatever the tool returned> }
 *
 * Also supports GET /api/admin/query with no params to list all available
 * tools — that's what the Query Console hits on page load to render its
 * form-per-tool UI.
 *
 * Vistabuilder can call this same endpoint when it ships; the contract is
 * stable so long as tools.ts stays the source of truth.
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, ACCESS_TOKEN, access_token"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const auth = requireAccess(req);
  if (!auth.ok) {
    res.status(401).json({ ok: false, error: auth.reason });
    return;
  }

  // GET = tool catalog. The console hits this on load to build its UI.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "GET or POST only" });
  }

  let body: { tool?: string; args?: Record<string, any> };
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  const toolName = body?.tool;
  const toolArgs = body?.args ?? {};

  if (!toolName || typeof toolName !== "string") {
    return res
      .status(400)
      .json({ ok: false, error: "Missing required field: tool (string)" });
  }

  const tool = TOOL_BY_NAME[toolName];
  if (!tool) {
    return res.status(404).json({
      ok: false,
      error: `Unknown tool: ${toolName}`,
      available: TOOLS.map((t) => t.name),
    });
  }

  const started = Date.now();
  try {
    const result = await tool.handler(toolArgs);
    return res.status(200).json({
      ok: true,
      tool: toolName,
      args: toolArgs,
      duration_ms: Date.now() - started,
      result,
    });
  } catch (err: any) {
    return res.status(200).json({
      ok: false,
      tool: toolName,
      args: toolArgs,
      duration_ms: Date.now() - started,
      error: err?.message ?? String(err),
    });
  }
}
