import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccess } from "../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../lib/mcp/tools";
import { DOMAINS } from "../lib/mcp/catalog";
import { VERSION } from "../lib/version";

const SERVER_INFO = {
  name: "vistamark-ria-intel",
  version: VERSION,
};

/**
 * initialize.instructions, built from the catalog so it cannot fall behind the
 * registry (the hand-written paragraph it replaces still described the 64
 * tools of v0.17 when the server exposed 234). It names each data domain and
 * its tool count; per-tool detail is in tools/list.
 */
const INSTRUCTIONS =
  `Vistamark Intel v${VERSION} \u2014 ${TOOLS.length} tools across ${DOMAINS.length} data domains: RIA / nonprofit / ` +
  "endowment / retirement-plan / public-pension prospecting, filings and people, markets and macro, local wealth " +
  "signals, and the first-party prospect database. Start broad questions with the synthesis composites " +
  "(prospect_360, org_360, liquidity_event_radar, relationship_graph, market_regime_brief); morning_market_brief " +
  "is the one-call pre-market composite; database_status reports ingest freshness for the Postgres-backed " +
  "sources. Tools marked as writing or spending credits in their description (prospects_*, apollo_* enrich) " +
  "change data or cost money \u2014 read the description first. Domains: " +
  DOMAINS.map((d) => `${d.label} (${d.tools.length})`).join(", ") +
  ". tools/list carries every tool's name, description and input schema.";

// Newest first. initialize echoes the client's version when we support it,
// otherwise offers our newest (MCP version negotiation).
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

const SERVER_CAPABILITIES = {
  tools: {},
  logging: {},
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function rpcResult(id: any, result: any) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: any, code: number, message: string, data?: any) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data ? { data } : {}) } };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, ACCESS_TOKEN, access_token, MCP-Protocol-Version, Mcp-Session-Id"
  );

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (req.method === "GET") {
    // Streamable HTTP: a client opening the server->client SSE stream sends
    // Accept: text/event-stream. We don't offer one, and the spec requires 405
    // in that case (a 200 JSON body makes Claude reject the server).
    const accept = String(req.headers.accept ?? "");
    if (accept.includes("text/event-stream")) {
      res.setHeader("Allow", "POST, OPTIONS");
      res.status(405).json(rpcError(null, -32600, "Server-initiated SSE stream not supported; use POST"));
      return;
    }
    res.status(200).json({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocol: PROTOCOL_VERSION,
      transport: "streamable-http",
      tools: TOOLS.map((t) => t.name),
      note: "POST JSON-RPC 2.0 requests with an ACCESS_TOKEN header or Authorization: Bearer <ACCESS_TOKEN>. See README for connection instructions.",
    });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).json(rpcError(null, -32600, "Method not allowed"));
    return;
  }

  const auth = requireAccess(req);
  if (!auth.ok) {
    res.status(401).json(rpcError(null, -32001, `Unauthorized: ${auth.reason}`));
    return;
  }

  let body: JsonRpcRequest;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json(rpcError(null, -32700, "Parse error"));
    return;
  }

  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json(rpcError(body?.id ?? null, -32600, "Invalid Request"));
    return;
  }

  // JSON-RPC notifications carry no id and get no response body: 202 Accepted.
  if (body.id === undefined || body.method.startsWith("notifications/")) {
    res.status(202).end();
    return;
  }

  const { id = null, method, params = {} } = body;

  try {
    switch (method) {
      case "initialize":
        return res.status(200).json(rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        }));

      case "ping":
        return res.status(200).json(rpcResult(id, {}));

      case "tools/list":
        return res.status(200).json(rpcResult(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        }));

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        const tool = TOOL_BY_NAME[toolName];
        if (!tool) return res.status(200).json(rpcError(id, -32602, `Unknown tool: ${toolName}`));
        try {
          const result = await tool.handler(toolArgs);
          return res.status(200).json(rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            // MCP structuredContent must be a JSON object; omit it for arrays/primitives.
            ...(result && typeof result === "object" && !Array.isArray(result) ? { structuredContent: result } : {}),
            isError: false,
          }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(200).json(rpcResult(id, {
            content: [{ type: "text", text: `Tool error: ${message}` }],
            isError: true,
          }));
        }
      }

      default:
        return res.status(200).json(rpcError(id, -32601, `Method not found: ${method}`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json(rpcError(id, -32603, `Internal error: ${message}`));
  }
}
