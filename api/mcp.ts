import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccess } from "../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../lib/mcp/tools";

const SERVER_INFO = {
  name: "vistamark-ria-intel",
  version: "0.17.0",
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, ACCESS_TOKEN, access_token, MCP-Protocol-Version"
  );

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

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
      case "initialize":
        return res.status(200).json(rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: "Vistamark Intel — query SEC RIAs (Form ADV), tax-exempt orgs (IRS BMF + ProPublica 990s), ERISA retirement plans (DOL Form 5500), U.S. higher-ed endowments (IPEDS Finance Survey Part H), NACUBO public benchmarks, SBA PPP loans, USAspending federal awards, SEC Form 13F institutional holdings, FDIC-insured banks, OFR systemic-risk/funding data, SEC EDGAR public-company intelligence (incl. full-text search, Form D exempt offerings, and cross-market XBRL frames), GLEIF LEI entity resolution and corporate family trees, listed Business Development Companies (BDCs, EDGAR-backed), U.S. state & local public pension plans (Public Plans Database), and macro/rate data (FRED, Treasury) including a curated MACRO MARKET-SIGNALS layer, the Daily Treasury Statement, and a one-call MORNING MARKET BRIEF. RIA tools: search_rias, get_ria_profile, find_alumni, get_aum_history, firms_using_custodian, top_rias_by. Nonprofit tools: irs_eo_search, irs_eo_lookup, propublica_org_search, propublica_org_990. Retirement plan tools: dol_plan_search, dol_plan_lookup. Endowment tools: endowment_search, endowment_lookup, endowment_peer_set, endowment_percentile_rank, endowment_growth_history, endowment_decade_comparison (~6,400 Title IV institutions, FY2003-04 to FY2022-23). NACUBO tools: nacubo_benchmark_lookup (FY2020-FY2025 public aggregates). PPP tools: ppp_search, ppp_lookup (SBA Paycheck Protection Program FOIA loan-level data). USAspending tools: usaspending_awards_search (award-level federal grants/contracts/loans/direct payments; obligations in whole USD; default 3-year window), usaspending_top_recipients (aggregated top recipients by state/type/period — pairs with irs_eo_search for nonprofit prospecting). 13F tools: holdings_by_manager, holders_of_security (ingested managers only; 13(f) securities over the $100M threshold). FDIC tools: fdic_bank_search, fdic_bank_financials, fdic_failed_banks (BankFind Suite API, live). OFR tools: ofr_financial_stress_index (daily systemic-stress gauge), ofr_series_search, ofr_series (repo, MMF, commercial paper). EDGAR tools: edgar_company_lookup, edgar_company_filings, edgar_financial_concept (XBRL time series with freshness-aware tag fallback), edgar_concept_frame (rank ALL SEC filers by one concept for one period — duration vs instantaneous frame mismatches retried automatically), edgar_fulltext_search (text search across ALL filings 2001+; date-bounded it doubles as a near-real-time filing monitor), formd_search (Form D / Reg D exempt-offering lens — who's raising; velocity doubles as a private-market risk-appetite gauge). GLEIF tools: gleif_entity_search (any legal entity worldwide to its LEI; legal-name matches ranked first), gleif_entity_profile (LEI record + accounting-consolidation parents and children — corporate family trees). BDC tools: bdc_list, bdc_profile, bdc_screen (curated BIZD-style universe on live EDGAR XBRL — the listed private-credit vehicles). Public pension tools: ppd_plan_search, ppd_plan_profile, ppd_list_variables (Public Plans Database, live — the ~230 largest state/local plans; ERISA-exempt so NOT in DOL 5500). Macro tools: morning_market_brief (THE one-call pre-market composite — signals board + net liquidity + daily TGA + withheld-tax payroll tape + full curve + OFR FSI, with briefMarkdown ready for the morning note; also served unauthenticated at GET /api/market-brief for cron consumption), macro_market_signals (21 indicators across curve/credit/liquidity/growth/inflation/sentiment pillars with inversion flags, Sahm trigger, HY OAS stress tiers, VIX regimes, and computed Fed NET LIQUIDITY = WALCL − RRP − TGA; firing signals roll into highlights; indicators not predictions), fred_batch_latest (latest + 1m/3m priors for any list of up to 15 FRED series), fred_series_search, fred_get_series, fred_yield_curve, treasury_avg_rates, treasury_debt_outstanding, treasury_daily_cash (daily TGA balance from the Daily Treasury Statement — the daily liquidity read), treasury_daily_flows (daily deposits/withdrawals by category incl. the withheld individual/FICA tax deposits that track payrolls with ~1-day lag). database_status reports ingest freshness across DB-backed sources (FDIC/OFR/EDGAR/GLEIF/BDC/PPD/USAspending/Treasury-DTS/macro-signals/morning-brief are live-API and not tracked there).",
        }));

      case "notifications/initialized":
      case "initialized":
        return res.status(204).end();

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
            structuredContent: result,
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
