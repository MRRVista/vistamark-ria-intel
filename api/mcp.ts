import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccess } from "../lib/auth";
import { TOOLS, TOOL_BY_NAME } from "../lib/mcp/tools";

const SERVER_INFO = {
  name: "vistamark-ria-intel",
  version: "0.13.0",
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
          instructions: "Vistamark Intel — query SEC RIAs (Form ADV), tax-exempt orgs (IRS BMF + ProPublica 990s), ERISA retirement plans (DOL Form 5500), U.S. higher-ed endowments (IPEDS Finance Survey Part H), NACUBO public benchmarks, SBA PPP loans, USAspending federal awards, SEC Form 13F institutional holdings, FDIC-insured banks, OFR systemic-risk/funding data, SEC EDGAR public-company intelligence (incl. full-text search and Form D exempt offerings), GLEIF LEI entity resolution and corporate family trees, listed Business Development Companies (BDCs, EDGAR-backed), U.S. state & local public pension plans (Public Plans Database), and macro/rate data (FRED, Treasury). RIA tools: search_rias, get_ria_profile, find_alumni, get_aum_history, firms_using_custodian, top_rias_by. Nonprofit tools: irs_eo_search, irs_eo_lookup, propublica_org_search, propublica_org_990. Retirement plan tools: dol_plan_search, dol_plan_lookup. Endowment tools: endowment_search, endowment_lookup, endowment_peer_set, endowment_percentile_rank, endowment_growth_history, endowment_decade_comparison (~6,400 Title IV institutions, FY2003-04 to FY2022-23). NACUBO tools: nacubo_benchmark_lookup (FY2020-FY2025 public aggregates). PPP tools: ppp_search, ppp_lookup (SBA Paycheck Protection Program FOIA loan-level data). USAspending tools: usaspending_awards_search (award-level federal grants/contracts/loans/direct payments for a recipient, keyword, or state — obligations in whole USD with USAspending links; award-type groups cannot be mixed per request; default 3-year window — use top_recipients for long-window totals), usaspending_top_recipients (aggregated top recipients by state/type/period — the screening view; pairs with irs_eo_search for nonprofit prospecting). 13F tools: holdings_by_manager (what an institutional manager holds), holders_of_security (which managers hold a given CUSIP/issuer — crowding view); both cover only managers ingested into the DB and only 13(f) securities over the $100M threshold. FDIC tools: fdic_bank_search, fdic_bank_financials, fdic_failed_banks (FDIC BankFind Suite API, live; bank/trust prospecting + diligence). OFR tools: ofr_financial_stress_index (daily systemic-stress gauge), ofr_series_search, ofr_series (OFR Short-Term Funding Monitor: repo, MMF, commercial paper). EDGAR tools: edgar_company_lookup (ticker/name -> CIK), edgar_company_filings (filing history + EDGAR doc URLs), edgar_financial_concept (XBRL financials time series), edgar_fulltext_search (keyword search across the text of ALL filings 2001+ — the only cross-filer search, reaching private funds with no ticker; 10 hits/page, offset paginates), formd_search (Form D / Reg D exempt-offering lens — which GPs, private funds, and issuers are raising; date-boundable, includes D/A amendments by default). GLEIF tools: gleif_entity_search (resolve any legal entity worldwide to its LEI — funds, GPs, banks, insurers, private companies beyond ticker-based lookups), gleif_entity_profile (one entity's LEI record plus direct/ultimate accounting-consolidation parents and direct children — corporate family trees for manager diligence and M&A buyer research; null parents are valid reporting exceptions). BDC tools: bdc_list (tracked listed-BDC universe with live CIK resolution), bdc_profile (one BDC's key financials + recent filings), bdc_screen (rank the universe by a financial metric) — a curated BIZD / MVIS-US-BDC-style universe layered on live EDGAR XBRL; the listed private-credit vehicles (Ares, Blue Owl, FS KKR, Blackstone, Main Street, etc.). Public pension tools: ppd_plan_search (screen the ~230 largest U.S. state & local pension plans by state, size, GASB funded ratio, return assumption), ppd_plan_profile (one plan's FY2001+ funding time series), ppd_list_variables (the PPD's own 1,100+ variable catalog) — Public Plans Database live API; public/governmental plans are ERISA-exempt and NOT in the DOL 5500 dataset, so this is the public-fund OCIO prospecting universe. Macro tools: fred_series_search, fred_get_series, fred_yield_curve, treasury_avg_rates, treasury_debt_outstanding. database_status reports ingest freshness across DB-backed sources (FDIC/OFR/EDGAR/GLEIF/BDC/PPD/USAspending are live-API and not tracked there).",
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
