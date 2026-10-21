/**
 * Market Structure family — FINRA Reg SHO short-sale volume, FINRA short
 * interest, FINRA TRACE market aggregates, SEC fails-to-deliver.
 *
 * MSRB EMMA (municipal bonds) is intentionally NOT included: MSRB offers no
 * free programmatic access — EMMA's free tier is item-by-item web access for
 * individual investors, and machine-readable feeds (RTRS trade data, SHORT,
 * continuing disclosure) are paid MSRB subscriptions (or via ICE as a vendor).
 * Per policy we do not scrape EMMA.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { FINRA_TOOL_DEFS } from "./finra";
import { SEC_FTD_TOOL_DEFS } from "./sec-ftd";

export const MKTSTRUCT_TOOLS: ToolDef[] = [...FINRA_TOOL_DEFS, ...SEC_FTD_TOOL_DEFS];

export const MKTSTRUCT_DOMAIN: CatalogDomain = {
  id: "marketstructure",
  label: "Market Structure (FINRA · SEC FTD · MSRB)",
  source:
    "FINRA Reg SHO daily files (cdn.finra.org) + FINRA Query API (api.finra.org: public short interest; TRACE aggregates keyed) + SEC fails-to-deliver zips. MSRB EMMA: no free API (not wired).",
  tools: [
    { name: "finra_short_volume", backing: "live-api", probe: "unprobed" },
    { name: "finra_short_interest", backing: "live-api", probe: "unprobed" },
    {
      name: "finra_trace_aggregates",
      backing: "live-api",
      probe: "unprobed",
      note: "Requires FINRA_API_CLIENT_ID / FINRA_API_CLIENT_SECRET (free FINRA API credentials)",
    },
    { name: "sec_fails_to_deliver", backing: "live-api", probe: "unprobed" },
  ],
};

export const MKTSTRUCT_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "finra short volume AAPL 2d", tool: "finra_short_volume", args: { symbols: ["AAPL"], days: 2 } },
  { name: "finra short interest AAPL", tool: "finra_short_interest", args: { symbols: ["AAPL"], months: 1 } },
  { name: "sec FTD AAPL latest file", tool: "sec_fails_to_deliver", args: { symbols: ["AAPL"], periods: 1 } },
];
