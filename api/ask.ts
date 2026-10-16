import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../lib/mcp/tools";
import { DOMAINS } from "../lib/mcp/catalog";
import { LOCAL_TOOLS, LOCAL_TOOL_BY_NAME, type AskContext } from "../lib/ask/local-tools";
import {
  anthropicModels,
  openRouterModels,
  modelChain,
  isModelUnavailable,
  HARD_DEFAULT_ANTHROPIC,
  HARD_DEFAULT_OPENROUTER,
} from "../lib/ask/models";

/**
 * POST /api/ask — natural-language front door to the VistaIntel tools.
 *
 * WHY A SERVER ENDPOINT AND NOT A BROWSER CALL
 * --------------------------------------------
 * The provider API keys must never reach the browser, and the tool handlers
 * are server-side anyway. So the loop lives here: model proposes tool calls,
 * we execute them in-process against TOOL_BY_NAME, feed results back, repeat
 * until the model answers. Calling our own /api/mcp over HTTP would add a
 * round trip and re-auth for no benefit — the handlers are one import away.
 *
 * THREE KINDS OF TOOL IN THE LOOP (v0.26)
 * ---------------------------------------
 *   MCP tools      — lib/mcp/tools.ts, the 70-odd data tools. Run here in-process.
 *   Local tools    — lib/ask/local-tools.ts (export_excel). Ask-only; produce a
 *                    download that rides back to the browser as `attachments`.
 *   Web search     — the provider's hosted search. Anthropic runs it server-side
 *                    (web_search_20250305 — the same tool the prospect engine
 *                    uses for research); OpenRouter via its `web` plugin. Nothing
 *                    to execute on our side; we log the queries and surface the
 *                    citations the model attached to its text.
 *
 * PROVIDERS
 * ---------
 *   anthropic  — Messages API, native tool_use blocks       (ANTHROPIC_API_KEY)
 *   openrouter — OpenAI-compatible chat/completions          (OPENROUTER_API_KEY)
 *
 * Both are wired because they fail differently: OpenRouter is the fallback
 * when Anthropic is rate-limited or a specific non-Anthropic model is wanted,
 * and it keeps model choice a config change rather than a code change. The
 * model roster itself lives in lib/ask/models.ts; any id in `body.model` is
 * accepted, the roster is what the console offers.
 *
 * REQUEST
 *   { question, provider?, model?, domains?, tools?, maxRounds?, history?, target?, webSearch? }
 *
 * RESPONSE
 *   { answer, provider, model, modelUsed, rounds, toolCalls[], webSearches, sources[], attachments[], usage, warnings[] }
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_VERSION = "2023-06-01";
const MCP_BETA = "mcp-client-2025-04-04";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

// Model ids are env-pinned so they can be rotated without a redeploy.
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || HARD_DEFAULT_ANTHROPIC;
const DEFAULT_OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || HARD_DEFAULT_OPENROUTER;

const MAX_ROUNDS_CAP = 8;
const DEFAULT_MAX_ROUNDS = 5;
const MAX_TOKENS = 8192;
/** Per-tool-result cap. Tool payloads here run to hundreds of KB (13F, EDGAR
 *  frames); unbounded they blow the context window inside two rounds. */
const TOOL_RESULT_CHAR_CAP = 6000;
const TOOL_TIMEOUT_MS = 20000;
/** Web searches per request. Research-grade questions need several; the
 *  prospect engine budgets 6 per person and that has proven enough. */
const WEB_SEARCH_MAX_USES = Number(process.env.ASK_WEB_SEARCH_MAX_USES) || 8;
const WEB_SEARCH_DEFAULT = process.env.ASK_WEB_SEARCH !== "0";

type Provider = "anthropic" | "openrouter";

interface ToolCallLog {
  round: number;
  name: string;
  args: unknown;
  ok: boolean;
  ms: number;
  truncated: boolean;
  error?: string;
  /** true for the provider's hosted web search — nothing ran on our side */
  hosted?: boolean;
}

interface Source {
  url: string;
  title?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ]);
}

function addSource(list: Source[], url: unknown, title?: unknown) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
  if (list.some((s) => s.url === url)) return;
  list.push({ url, ...(typeof title === "string" && title.trim() ? { title: title.trim().slice(0, 160) } : {}) });
}

/**
 * Build the system prompt from the catalog. The important part is the
 * KNOWN-EMPTY / KNOWN-DEGRADED block: without it the model cheerfully calls
 * ppp_search or holdings_by_manager, gets a clean empty result, and reports
 * "no PPP loans found" — which reads as a factual finding when it is actually
 * an un-ingested table. Telling the model the difference up front is the
 * single highest-value thing in this prompt.
 */
function buildSystemPrompt(opts: { webSearch: boolean; excel: boolean }): string {
  const domainLines = DOMAINS.map(
    (d) => `- ${d.label} (${d.tools.length} tools) — ${d.source}`
  ).join("\n");

  const empty = DOMAINS.flatMap((d) => d.tools).filter((t) => t.probe === "empty");
  const degraded = DOMAINS.flatMap((d) => d.tools).filter((t) => t.probe === "degraded");
  const slow = DOMAINS.flatMap((d) => d.tools).filter((t) => t.probe === "slow");

  const capabilities: string[] = [];
  if (opts.webSearch) {
    capabilities.push(
      "WEB SEARCH is available (the `web_search` tool). Use it for what the structured tools cannot answer:",
      "  named people at a firm and their roles, a firm's website and service menu, recent news, press releases,",
      "  conference appearances, LinkedIn-visible titles, and anything that happened after the data cut.",
      "  The structured tools stay primary for AUM, filings, registrations and dollar figures — search complements",
      "  them, it does not replace them. When you use a web result, name the site and give the URL in your answer.",
      "  Never present an unverified web claim as a filing fact."
    );
  } else {
    capabilities.push("Web search is OFF for this request. If a question needs it, say so rather than guessing.");
  }
  if (opts.excel) {
    capabilities.push(
      "EXCEL EXPORT is available (the `export_excel` tool). When the user asks for a spreadsheet, Excel, xlsx or",
      "  export — or when a result has more than about fifteen rows — build the workbook from the real tool results,",
      "  typed columns included, then describe the file in a few lines instead of pasting the table. Never invent rows."
    );
  }

  return [
    "You are Randall Stephens, senior associate at Vistamark Investments LLC.",
    `You answer questions using the VistaIntel tool set — ${TOOLS.length} tools spanning SEC, IRS, DOL,`,
    "Treasury, Federal Reserve, EODHD market data, higher-ed data and Vistamark's own prospect database.",
    "Vistamark is an RIA; the recurring jobs are",
    "iCIO prospecting (boutique, planning-led, fee-only independent RIAs with no in-house CIO),",
    "nonprofit and endowment intelligence, local (Hinsdale, IL) prospect research, and pre-market macro reads.",
    "",
    "DATA DOMAINS AVAILABLE:",
    domainLines,
    "",
    "CAPABILITIES BEYOND THE DATA TOOLS:",
    ...capabilities,
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
    "- Format with Markdown: headings, bullet lists and pipe tables render; keep tables under ~15 rows",
    "  and move anything larger to an Excel export.",
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

async function runTool(name: string, args: any, round: number, ctx: AskContext): Promise<{ text: string; log: ToolCallLog }> {
  const local = LOCAL_TOOL_BY_NAME[name];
  const tool = TOOL_BY_NAME[name];
  const started = Date.now();
  if (!local && !tool) {
    return {
      text: `Error: unknown tool "${name}".`,
      log: { round, name, args, ok: false, ms: 0, truncated: false, error: "unknown tool" },
    };
  }
  try {
    const result = await withTimeout(
      Promise.resolve(local ? local.handler(args ?? {}, ctx) : tool.handler(args ?? {})),
      TOOL_TIMEOUT_MS,
      name
    );
    let text = JSON.stringify(result, null, 2);
    const truncated = text.length > TOOL_RESULT_CHAR_CAP;
    if (truncated) {
      text =
        text.slice(0, TOOL_RESULT_CHAR_CAP) +
        `\n\n[truncated at ${TOOL_RESULT_CHAR_CAP} chars — narrow the query or request fewer rows]`;
    }
    // Attachments are logged with their size, never their payload — a 2 MB
    // base64 blob in `args` would make the trace unreadable.
    const logArgs = local ? summariseArgs(args) : args;
    return {
      text,
      log: { round, name, args: logArgs, ok: true, ms: Date.now() - started, truncated },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: `Tool error: ${message}`,
      log: { round, name, args: local ? summariseArgs(args) : args, ok: false, ms: Date.now() - started, truncated: false, error: message },
    };
  }
}

function summariseArgs(args: any): unknown {
  if (!args || typeof args !== "object") return args;
  const sheets = Array.isArray(args.sheets) ? args.sheets : [];
  return {
    filename: args.filename,
    sheets: sheets.map((s: any) => ({
      name: s?.name,
      columns: Array.isArray(s?.columns) ? s.columns.length : 0,
      rows: Array.isArray(s?.rows) ? s.rows.length : 0,
    })),
  };
}

/* ------------------------------- Anthropic ------------------------------- */

async function askAnthropic(opts: {
  system: string;
  messages: any[];
  tools: typeof TOOLS;
  model: string;
  maxRounds: number;
  attachRandall: boolean;
  webSearch: boolean;
  ctx: AskContext;
  warnings: string[];
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error("ANTHROPIC_API_KEY is not configured"), { status: 503 });

  const toolDefs: any[] = [
    ...opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    ...LOCAL_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  ];
  if (opts.webSearch) toolDefs.push({ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: WEB_SEARCH_MAX_USES });

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
  const sources: Source[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
  let rounds = 0;

  // Failover chain (lib/ask/models.ts): a Mythos-class primary falls back to
  // the Opus line when overloaded or not served on this key. Only availability
  // failures move the pointer; a 400/401/403 would fail identically downstream.
  const chain = modelChain(opts.model);
  let modelIdx = 0;

  async function callOnce(body: any): Promise<any> {
    for (;;) {
      const model = chain[modelIdx];
      const resp = await fetch(ANTHROPIC_URL, { method: "POST", headers, body: JSON.stringify({ ...body, model }) });
      if (resp.ok) return resp.json();
      const detail = await resp.text().catch(() => "");
      if (modelIdx < chain.length - 1 && isModelUnavailable(resp.status, detail)) {
        opts.warnings.push(`${model} unavailable (${resp.status}) — failed over to ${chain[modelIdx + 1]}.`);
        modelIdx++;
        continue;
      }
      throw Object.assign(new Error(`Anthropic API ${resp.status}: ${detail.slice(0, 600)}`), {
        status: resp.status === 429 ? 429 : 502,
      });
    }
  }

  for (let round = 1; round <= opts.maxRounds; round++) {
    rounds = round;
    const data: any = await callOnce({
      max_tokens: MAX_TOKENS,
      system: opts.system,
      messages,
      tools: toolDefs,
      ...(mcpServers ? { mcp_servers: mcpServers } : {}),
    });

    usage.inputTokens += data?.usage?.input_tokens ?? 0;
    usage.outputTokens += data?.usage?.output_tokens ?? 0;
    usage.webSearches += data?.usage?.server_tool_use?.web_search_requests ?? 0;

    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];

    // Hosted web search ran inside the provider: log each query so the trace
    // shows it, and harvest the citations attached to the prose.
    for (const b of blocks) {
      if (b?.type === "server_tool_use") {
        toolCalls.push({ round, name: b.name || "web_search", args: b.input, ok: true, ms: 0, truncated: false, hosted: true });
      } else if (b?.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r?.type === "web_search_result") addSource(sources, r.url, r.title);
      } else if (b?.type === "text" && Array.isArray(b.citations)) {
        for (const c of b.citations) addSource(sources, c?.url, c?.title);
      }
    }

    const toolUses = blocks.filter((b) => b?.type === "tool_use");

    // pause_turn: the server-side tool loop hit its budget mid-turn and wants
    // us to send the partial turn back so it can continue. No client tools to
    // run, just resume.
    if (data?.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    if (data?.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { answer, toolCalls, rounds, usage, sources, modelUsed: chain[modelIdx] };
    }

    messages.push({ role: "assistant", content: blocks });

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const { text, log } = await runTool(tu.name, tu.input, round, opts.ctx);
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
    sources,
    modelUsed: chain[modelIdx],
  };
}

/* ------------------------------- OpenRouter ------------------------------ */

async function askOpenRouter(opts: {
  system: string;
  messages: any[];
  tools: typeof TOOLS;
  model: string;
  maxRounds: number;
  webSearch: boolean;
  ctx: AskContext;
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw Object.assign(new Error("OPENROUTER_API_KEY is not configured"), { status: 503 });

  const toolDefs = [...opts.tools, ...LOCAL_TOOLS].map((t) => ({
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
  const sources: Source[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, webSearches: 0 };
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
        // OpenRouter's hosted web search: results are injected into the prompt
        // and come back as url_citation annotations on the message.
        ...(opts.webSearch ? { plugins: [{ id: "web", max_results: 5 }] } : {}),
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
    const annotations: any[] = Array.isArray(message?.annotations) ? message.annotations : [];
    if (annotations.length) {
      usage.webSearches += 1;
      toolCalls.push({ round, name: "web_search", args: { results: annotations.length }, ok: true, ms: 0, truncated: false, hosted: true });
      for (const a of annotations) {
        const u = a?.url_citation ?? a;
        addSource(sources, u?.url, u?.title);
      }
    }
    const requested: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

    if (requested.length === 0) {
      return { answer: (message?.content ?? "").trim(), toolCalls, rounds, usage, sources, modelUsed: opts.model };
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

      const { text, log } = await runTool(call?.function?.name, args, round, opts.ctx);
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
    sources,
    modelUsed: opts.model,
  };
}

/* -------------------------------- handler -------------------------------- */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, ACCESS_TOKEN, access_token");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // GET is a capability probe so the console can grey out the Ask panel with a
  // specific reason instead of letting the user type a question into a dead
  // box — and, since v0.26, the model roster the picker is built from.
  if (req.method === "GET") {
    const or = await openRouterModels();
    res.status(200).json({
      endpoint: "ask",
      providers: {
        anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY), model: DEFAULT_ANTHROPIC_MODEL },
        openrouter: { configured: Boolean(process.env.OPENROUTER_API_KEY), model: DEFAULT_OPENROUTER_MODEL },
      },
      models: {
        anthropic: anthropicModels(),
        openrouter: or.models,
        openrouterLive: or.live,
      },
      webSearch: { available: true, default: WEB_SEARCH_DEFAULT, maxUses: WEB_SEARCH_MAX_USES },
      localTools: LOCAL_TOOLS.map((t) => t.name),
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
      ? body.model.trim().slice(0, 120)
      : provider === "anthropic"
      ? DEFAULT_ANTHROPIC_MODEL
      : DEFAULT_OPENROUTER_MODEL;

  const maxRounds = Math.min(
    Math.max(Number.isFinite(body.maxRounds) ? Number(body.maxRounds) : DEFAULT_MAX_ROUNDS, 1),
    MAX_ROUNDS_CAP
  );

  const webSearch = typeof body.webSearch === "boolean" ? body.webSearch : WEB_SEARCH_DEFAULT;

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
  const system = buildSystemPrompt({ webSearch, excel: true });
  const ctx: AskContext = { attachments: [] };
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
            webSearch,
            ctx,
            warnings,
          })
        : await askOpenRouter({ system, messages, tools, model, maxRounds, webSearch, ctx });

    res.status(200).json({
      answer: result.answer,
      provider,
      model,
      modelUsed: result.modelUsed,
      rounds: result.rounds,
      toolsExposed: tools.length + LOCAL_TOOLS.length,
      toolCalls: result.toolCalls,
      webSearch,
      webSearches: result.usage.webSearches,
      sources: result.sources,
      attachments: ctx.attachments,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
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
