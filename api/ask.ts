import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../lib/mcp/tools";
import { DOMAINS } from "../lib/mcp/catalog";

/**
 * POST /api/ask — natural-language front door to the 57 VistaIntel tools.
 *
 * WHY A SERVER ENDPOINT AND NOT A BROWSER CALL
 * --------------------------------------------
 * The provider API keys must never reach the browser, and the tool handlers
 * are server-side anyway. So the loop lives here: model proposes tool calls,
 * we execute them in-process against TOOL_BY_NAME, feed results back, repeat
 * until the model answers. Calling our own /api/mcp over HTTP would add a
 * round trip and re-auth for no benefit — the handlers are one import away.
 *
 * PROVIDERS
 * ---------
 *   anthropic  — Messages API, native tool_use blocks       (ANTHROPIC_API_KEY)
 *   openrouter — OpenAI-compatible chat/completions          (OPENROUTER_API_KEY)
 *
 * Both are wired because they fail differently: OpenRouter is the fallback
 * when Anthropic is rate-limited or a specific non-Anthropic model is wanted,
 * and it keeps model choice a config change rather than a code change.
 *
 * REQUEST
 *   { question, provider?, model?, domains?, tools?, maxRounds?, history?, target? }
 *
 * RESPONSE
 *   { answer, provider, model, rounds, toolCalls[], usage, warnings[] }
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_VERSION = "2023-06-01";
const MCP_BETA = "mcp-client-2025-04-04";

// Model ids are env-pinned so they can be rotated without a redeploy.
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const DEFAULT_OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";

const MAX_ROUNDS_CAP = 8;
const DEFAULT_MAX_ROUNDS = 5;
const MAX_TOKENS = 4096;
/** Per-tool-result cap. Tool payloads here run to hundreds of KB (13F, EDGAR
 *  frames); unbounded they blow the context window inside two rounds. */
const TOOL_RESULT_CHAR_CAP = 6000;
const TOOL_TIMEOUT_MS = 20000;

type Provider = "anthropic" | "openrouter";

interface ToolCallLog {
  round: number;
  name: string;
  args: unknown;
  ok: boolean;
  ms: number;
  truncated: boolean;
  error?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ]);
}

/**
 * Build the system prompt from the catalog. The important part is the
 * KNOWN-EMPTY / KNOWN-DEGRADED block: without it the model cheerfully calls
 * ppp_search or holdings_by_manager, gets a clean empty result, and reports
 * "no PPP loans found" — which reads as a factual finding when it is actually
 * an un-ingested table. Telling the model the difference up front is the
 * single highest-value thing in this prompt.
 */
function buildSystemPrompt(): string {
  const domainLines = DOMAINS.map(
    (d) => `- ${d.label} (${d.tools.length} tools) — ${d.source}`
  ).join("\n");

  const empty = DOMAINS.flatMap((d) => d.tools).filter((t) => t.probe === "empty");
  const degraded = DOMAINS.flatMap((d) => d.tools).filter((t) => t.probe === "degraded");
  const slow = DOMAINS.flatMap((d) => d.tools).filter((t) => t.probe === "slow");

  return [
    "You are Randall Stephens, senior associate at Vistamark Investments LLC.",
    "You answer questions using the VistaIntel tool set — 57 tools spanning SEC, IRS, DOL,",
    "Treasury, Federal Reserve and higher-ed data. Vistamark is an RIA; the recurring jobs are",
    "iCIO prospecting (boutique, planning-led, fee-only independent RIAs with no in-house CIO),",
    "nonprofit and endowment intelligence, and pre-market macro reads.",
    "",
    "DATA DOMAINS AVAILABLE:",
    domainLines,
    "",
    "CRITICAL — DISTINGUISH NO DATA FROM NO INGEST:",
    "These tools return clean EMPTY results because their tables were never populated.",
    "An empty result from them is NOT evidence that nothing exists in the real world.",
    "Never report an empty result from these as a finding; say the source is not yet ingested:",
    empty.length ? empty.map((t) => `  - ${t.name}`).join("\n") : "  (none)",
    "",
    "These tools currently return structurally incomplete data — caveat any figure from them:",
    degraded.length ? degraded.map((t) => `  - ${t.name}: ${t.note ?? "degraded"}`).join("\n") : "  (none)",
    "",
    "These tools are slow composites; prefer narrower tools when you only need one series:",
    slow.length ? slow.map((t) => `  - ${t.name}`).join("\n") : "  (none)",
    "",
    "RULES:",
    "- Prefer calling tools over answering from memory. This data is authoritative and current;",
    "  your training data is not.",
    "- All dollar figures from these tools are already whole USD unless a tool says otherwise.",
    "- Cite the CRD, EIN, CIK, UNITID or LEI alongside every named entity so it can be looked up.",
    "- State the as-of date for any figure that has one.",
    "- If a tool errors or times out, say so plainly and name the tool. Do not silently substitute",
    "  an estimate or a remembered number for a failed call.",
    "- Be terse. Lead with the answer, then the supporting figures.",
  ].join("\n");
}

/** Select which tools to expose. Narrowing cuts prompt cost and stops the
 *  model wandering into unrelated domains on a focused question. */
function selectTools(body: any): { tools: typeof TOOLS; warnings: string[] } {
  const warnings: string[] = [];

  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    const picked = body.tools.filter((n: string) => {
      if (TOOL_BY_NAME[n]) return true;
      warnings.push(`Unknown tool ignored: ${n}`);
      return false;
    });
    if (picked.length > 0) return { tools: picked.map((n: string) => TOOL_BY_NAME[n]), warnings };
    warnings.push("No valid tools in `tools`; falling back to full tool set.");
  }

  if (Array.isArray(body?.domains) && body.domains.length > 0) {
    const wanted = new Set(body.domains);
    const names = new Set(
      DOMAINS.filter((d) => wanted.has(d.id)).flatMap((d) => d.tools.map((t) => t.name))
    );
    for (const id of body.domains) {
      if (!DOMAINS.some((d) => d.id === id)) warnings.push(`Unknown domain ignored: ${id}`);
    }
    const picked = TOOLS.filter((t) => names.has(t.name));
    if (picked.length > 0) return { tools: picked, warnings };
    warnings.push("No tools matched `domains`; falling back to full tool set.");
  }

  return { tools: TOOLS, warnings };
}

async function runTool(name: string, args: any, round: number): Promise<{ text: string; log: ToolCallLog }> {
  const tool = TOOL_BY_NAME[name];
  const started = Date.now();
  if (!tool) {
    return {
      text: `Error: unknown tool "${name}".`,
      log: { round, name, args, ok: false, ms: 0, truncated: false, error: "unknown tool" },
    };
  }
  try {
    const result = await withTimeout(Promise.resolve(tool.handler(args ?? {})), TOOL_TIMEOUT_MS, name);
    let text = JSON.stringify(result, null, 2);
    const truncated = text.length > TOOL_RESULT_CHAR_CAP;
    if (truncated) {
      text =
        text.slice(0, TOOL_RESULT_CHAR_CAP) +
        `\n\n[truncated at ${TOOL_RESULT_CHAR_CAP} chars — narrow the query or request fewer rows]`;
    }
    return {
      text,
      log: { round, name, args, ok: true, ms: Date.now() - started, truncated },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: `Tool error: ${message}`,
      log: { round, name, args, ok: false, ms: Date.now() - started, truncated: false, error: message },
    };
  }
}

/* ------------------------------- Anthropic ------------------------------- */

async function askAnthropic(opts: {
  system: string;
  messages: any[];
  tools: typeof TOOLS;
  model: string;
  maxRounds: number;
  attachRandall: boolean;
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error("ANTHROPIC_API_KEY is not configured"), { status: 503 });

  const toolDefs = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };

  let mcpServers: any[] | undefined;
  if (opts.attachRandall) {
    const url = process.env.RANDALL_MCP_URL;
    if (!url) throw Object.assign(new Error("RANDALL_MCP_URL is not configured"), { status: 503 });
    mcpServers = [
      {
        type: "url",
        url,
        name: "randall",
        ...(process.env.RANDALL_MCP_TOKEN ? { authorization_token: process.env.RANDALL_MCP_TOKEN } : {}),
      },
    ];
    headers["anthropic-beta"] = MCP_BETA;
  }

  const messages = [...opts.messages];
  const toolCalls: ToolCallLog[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let rounds = 0;

  for (let round = 1; round <= opts.maxRounds; round++) {
    rounds = round;
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        system: opts.system,
        messages,
        tools: toolDefs,
        ...(mcpServers ? { mcp_servers: mcpServers } : {}),
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw Object.assign(new Error(`Anthropic API ${resp.status}: ${detail.slice(0, 600)}`), {
        status: resp.status === 429 ? 429 : 502,
      });
    }

    const data: any = await resp.json();
    usage.inputTokens += data?.usage?.input_tokens ?? 0;
    usage.outputTokens += data?.usage?.output_tokens ?? 0;

    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const toolUses = blocks.filter((b) => b?.type === "tool_use");

    if (data?.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { answer, toolCalls, rounds, usage };
    }

    messages.push({ role: "assistant", content: blocks });

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const { text, log } = await runTool(tu.name, tu.input, round);
        toolCalls.push(log);
        return { type: "tool_result", tool_use_id: tu.id, content: text, ...(log.ok ? {} : { is_error: true }) };
      })
    );
    messages.push({ role: "user", content: results });
  }

  return {
    answer:
      `Stopped after ${opts.maxRounds} tool rounds without a final answer. ` +
      `Tools called: ${toolCalls.map((c) => c.name).join(", ") || "none"}. ` +
      `Raise maxRounds or narrow the question.`,
    toolCalls,
    rounds,
    usage,
  };
}

/* ------------------------------- OpenRouter ------------------------------ */

async function askOpenRouter(opts: {
  system: string;
  messages: any[];
  tools: typeof TOOLS;
  model: string;
  maxRounds: number;
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw Object.assign(new Error("OPENROUTER_API_KEY is not configured"), { status: 503 });

  const toolDefs = opts.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));

  // OpenRouter is OpenAI-shaped: the system prompt is the first message
  // rather than a separate top-level field.
  const messages: any[] = [{ role: "system", content: opts.system }, ...opts.messages];
  const toolCalls: ToolCallLog[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let rounds = 0;

  for (let round = 1; round <= opts.maxRounds; round++) {
    rounds = round;
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://vistaintel.app",
        "X-Title": "VistaIntel",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        messages,
        tools: toolDefs,
        tool_choice: "auto",
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw Object.assign(new Error(`OpenRouter API ${resp.status}: ${detail.slice(0, 600)}`), {
        status: resp.status === 429 ? 429 : 502,
      });
    }

    const data: any = await resp.json();
    usage.inputTokens += data?.usage?.prompt_tokens ?? 0;
    usage.outputTokens += data?.usage?.completion_tokens ?? 0;

    const message = data?.choices?.[0]?.message;
    const requested: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

    if (requested.length === 0) {
      return { answer: (message?.content ?? "").trim(), toolCalls, rounds, usage };
    }

    messages.push(message);

    for (const call of requested) {
      let args: any = {};
      let parseError: string | null = null;
      try {
        args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        // Malformed tool arguments are a model error, not a tool error —
        // hand the parse failure back so it can retry with valid JSON.
        parseError = err instanceof Error ? err.message : String(err);
      }

      if (parseError) {
        toolCalls.push({
          round,
          name: call?.function?.name ?? "unknown",
          args: call?.function?.arguments,
          ok: false,
          ms: 0,
          truncated: false,
          error: `argument JSON parse failed: ${parseError}`,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Error: arguments were not valid JSON (${parseError}). Retry with valid JSON.`,
        });
        continue;
      }

      const { text, log } = await runTool(call?.function?.name, args, round);
      toolCalls.push(log);
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }

  return {
    answer:
      `Stopped after ${opts.maxRounds} tool rounds without a final answer. ` +
      `Tools called: ${toolCalls.map((c) => c.name).join(", ") || "none"}. ` +
      `Raise maxRounds or narrow the question.`,
    toolCalls,
    rounds,
    usage,
  };
}

/* -------------------------------- handler -------------------------------- */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ACCESS_TOKEN, access_token");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // GET is a capability probe so the console can grey out the Ask panel with a
  // specific reason instead of letting the user type a question into a dead box.
  if (req.method === "GET") {
    res.status(200).json({
      endpoint: "ask",
      providers: {
        anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY), model: DEFAULT_ANTHROPIC_MODEL },
        openrouter: { configured: Boolean(process.env.OPENROUTER_API_KEY), model: DEFAULT_OPENROUTER_MODEL },
      },
      randallRelay: { configured: Boolean(process.env.RANDALL_MCP_URL) },
      toolCount: TOOLS.length,
      domains: DOMAINS.map((d) => ({ id: d.id, label: d.label, toolCount: d.tools.length })),
    });
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  const auth = await requireAccessOrSession(req);
  if (!auth.ok) { res.status(401).json({ error: auth.reason }); return; }

  let body: any;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
  } catch {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) { res.status(400).json({ error: "`question` is required" }); return; }

  const anthropicReady = Boolean(process.env.ANTHROPIC_API_KEY);
  const openrouterReady = Boolean(process.env.OPENROUTER_API_KEY);

  let provider: Provider =
    body.provider === "openrouter" || body.provider === "anthropic"
      ? body.provider
      : (process.env.DEFAULT_ASK_PROVIDER as Provider) || "anthropic";

  const warnings: string[] = [];

  // Fall back rather than fail when the requested provider has no key but the
  // other one does — a missing key is a config gap, not a reason to 503 a
  // question we can still answer.
  if (provider === "anthropic" && !anthropicReady && openrouterReady) {
    provider = "openrouter";
    warnings.push("ANTHROPIC_API_KEY not set — fell back to OpenRouter.");
  } else if (provider === "openrouter" && !openrouterReady && anthropicReady) {
    provider = "anthropic";
    warnings.push("OPENROUTER_API_KEY not set — fell back to Anthropic.");
  }

  if (!anthropicReady && !openrouterReady) {
    res.status(503).json({
      error: "No LLM provider configured.",
      remedy: "Set ANTHROPIC_API_KEY and/or OPENROUTER_API_KEY in the Vercel project env, then redeploy.",
      providers: { anthropic: false, openrouter: false },
    });
    return;
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : provider === "anthropic"
      ? DEFAULT_ANTHROPIC_MODEL
      : DEFAULT_OPENROUTER_MODEL;

  const maxRounds = Math.min(
    Math.max(Number.isFinite(body.maxRounds) ? Number(body.maxRounds) : DEFAULT_MAX_ROUNDS, 1),
    MAX_ROUNDS_CAP
  );

  const { tools, warnings: toolWarnings } = selectTools(body);
  warnings.push(...toolWarnings);

  const attachRandall = body.target === "randall";
  if (attachRandall && provider !== "anthropic") {
    warnings.push("Randall MCP relay requires the Anthropic provider — relay not attached.");
  }

  // Prior turns arrive as {role, content} and are passed through verbatim so
  // multi-turn context survives; this endpoint holds no state of its own.
  const history = Array.isArray(body.history)
    ? body.history
        .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
        .slice(-12)
    : [];

  const messages = [...history, { role: "user", content: question }];
  const system = buildSystemPrompt();
  const startedAt = Date.now();

  try {
    const result =
      provider === "anthropic"
        ? await askAnthropic({
            system,
            messages,
            tools,
            model,
            maxRounds,
            attachRandall: attachRandall && provider === "anthropic",
          })
        : await askOpenRouter({ system, messages, tools, model, maxRounds });

    res.status(200).json({
      answer: result.answer,
      provider,
      model,
      rounds: result.rounds,
      toolsExposed: tools.length,
      toolCalls: result.toolCalls,
      usage: result.usage,
      totalMs: Date.now() - startedAt,
      randallRelay: attachRandall && provider === "anthropic",
      warnings,
    });
  } catch (err: any) {
    const status = typeof err?.status === "number" ? err.status : 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : String(err),
      provider,
      model,
      totalMs: Date.now() - startedAt,
      warnings,
    });
  }
}
