import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccess } from "../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../lib/mcp/tools";

const SERVER_INFO = {
  name: "vistamark-ria-intel",
  version: "0.1.0",
};

const PROTOCOL_VERSION = "2024-11-05";

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
  // CORS for browser-based MCP clients
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, ACCESS_TOKEN, access_token, MCP-Protocol-Version"
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // GET serves a basic health/info page so the URL isn't a 405 in a browser
  if (req.method === "GET") {
    res.status(200).json({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocol: PROTOCOL_VERSION,
      transport: "streamable-http",
      tools: TOOLS.map((t) => t.name),
      note: "POST JSON-RPC 2.0 requests with an ACCESS_TOKEN header. See README for connection instructions.",
    });
    return;
  }

  if (req.method !== "POST") {
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

  const { id = null, method, params = {} } = body;

  try {
    switch (method) {
      case "initialize": {
        return res.status(200).json(
          rpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: SERVER_CAPABILITIES,
            serverInfo: SERVER_INFO,
            instructions:
              "Vistamark RIA Intelligence — query SEC-registered investment advisers by AUM, state, services, client mix, and custodian. Track advisor moves with find_alumni. Use database_status to check freshness.",
          })
        );
      }

      case "notifications/initialized":
      case "initialized":
        // Acknowledgment notification — no response required
        return res.status(204).end();

      case "ping":
        return res.status(200).json(rpcResult(id, {}));

      case "tools/list": {
        return res.status(200).json(
          rpcResult(id, {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          })
        );
      }

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        const tool = TOOL_BY_NAME[toolName];
        if (!tool) {
          return res.status(200).json(rpcError(id, -32602, `Unknown tool: ${toolName}`));
        }

        try {
          const result = await tool.handler(toolArgs);
          return res.status(200).json(
            rpcResult(id, {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              structuredContent: result,
              isError: false,
            })
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(200).json(
            rpcResult(id, {
              content: [{ type: "text", text: `Tool error: ${message}` }],
              isError: true,
            })
          );
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
