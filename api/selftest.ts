/**
 * GET /api/selftest — read-only diagnostic battery across every dataset.
 *
 * Runs a fixed set of representative tool calls server-side (in parallel,
 * each with its own timeout) and returns pass/fail + a truncated summary of
 * each result. Purpose: verify what actually WORKS end to end, without
 * needing an MCP client.
 *
 * Deliberately unauthenticated: GET only, fixed queries against public-source
 * data, summaries truncated to ~450 chars, no arguments accepted except
 *   ?only=<substring[,substring]>  — run a subset (matches check/tool name)
 *   ?t=<ms>                        — per-check timeout (1000–9000, default 7000)
 * Remove or gate this endpoint once validation is done if desired.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { TOOL_BY_NAME } from "../lib/mcp/tools";

interface Check {
  name: string;
  tool: string;
  args: any;
  note?: string;
}

const CHECKS: Check[] = [
  { name: "db-status", tool: "database_status", args: {} },
  { name: "adv-search", tool: "search_rias", args: { state: "IL", minAum: 100000000, limit: 2 } },
  { name: "adv-top", tool: "top_rias_by", args: { metric: "aum", state: "IL", limit: 3 } },
  { name: "irs-bmf", tool: "irs_eo_search", args: { state: "IL", subsection: 3, minAssetAmt: 25000000, limit: 2 } },
  { name: "propublica", tool: "propublica_org_search", args: { q: "community foundation", state: "IL" } },
  { name: "endowment-search", tool: "endowment_search", args: { state: "IL", minEndowment: 25000000, maxEndowment: 250000000, limit: 2 } },
  { name: "endowment-rank", tool: "endowment_percentile_rank", args: { instnm: "University of Chicago" } },
  { name: "nacubo", tool: "nacubo_benchmark_lookup", args: { fyear: 2024, cohort: "all" } },
  { name: "dol-5500", tool: "dol_plan_search", args: { state: "IL", is401k: true, minAssetsEoy: 50000000, limit: 2 } },
  { name: "fred-curve", tool: "fred_yield_curve", args: {} },
  { name: "treasury", tool: "treasury_avg_rates", args: {} },
  { name: "fdic", tool: "fdic_bank_search", args: { state: "IL", communityBankOnly: true, limit: 2 } },
  { name: "ofr-fsi", tool: "ofr_financial_stress_index", args: { lookback: 5 } },
  { name: "edgar-lookup", tool: "edgar_company_lookup", args: { query: "Apple", limit: 1 } },
  { name: "edgar-concept", tool: "edgar_financial_concept", args: { ticker: "AAPL", concept: "Revenues", annualOnly: true, limit: 2 } },
  { name: "bdc-list", tool: "bdc_list", args: { limit: 5 } },
  { name: "bdc-profile", tool: "bdc_profile", args: { ticker: "ARCC" } },
  { name: "ppp-empty", tool: "ppp_search", args: { state: "IL", limit: 2 }, note: "expected EMPTY (never ingested) — pass = clean empty result, not an error" },
  { name: "13f-empty", tool: "holdings_by_manager", args: { managerName: "Ares" }, note: "expected EMPTY (never ingested) — pass = clean empty result, not an error" },
];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`selftest timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }
  const onlyRaw = typeof req.query.only === "string" ? req.query.only.trim() : "";
  const only = onlyRaw ? onlyRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  const tRaw = typeof req.query.t === "string" ? Number(req.query.t) : NaN;
  const perCheckMs = Math.min(Math.max(Number.isFinite(tRaw) ? tRaw : 7000, 1000), 9000);

  const selected = CHECKS.filter(
    (c) => !only || only.some((o) => c.name.toLowerCase().includes(o) || c.tool.toLowerCase().includes(o))
  );

  const startedAt = Date.now();
  const checks = await Promise.all(
    selected.map(async (c) => {
      const t0 = Date.now();
      const tool = TOOL_BY_NAME[c.tool];
      if (!tool) {
        return { name: c.name, tool: c.tool, ok: false, ms: 0, error: "tool not registered" };
      }
      try {
        const r = await withTimeout(Promise.resolve(tool.handler(c.args)), perCheckMs);
        const text = JSON.stringify(r);
        const innerError =
          r && typeof r === "object" && (r as any).error ? String((r as any).error) : null;
        return {
          name: c.name,
          tool: c.tool,
          ok: !innerError,
          ms: Date.now() - t0,
          ...(c.note ? { note: c.note } : {}),
          ...(innerError ? { error: innerError } : {}),
          summary: text.length > 450 ? text.slice(0, 450) + "…" : text,
        };
      } catch (err) {
        return {
          name: c.name,
          tool: c.tool,
          ok: false,
          ms: Date.now() - t0,
          ...(c.note ? { note: c.note } : {}),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const passed = checks.filter((r) => r.ok).length;
  res.status(200).json({
    endpoint: "selftest",
    server: "vistamark-ria-intel",
    ranAt: new Date(startedAt).toISOString(),
    totalMs: Date.now() - startedAt,
    perCheckTimeoutMs: perCheckMs,
    checksRun: checks.length,
    passed,
    failed: checks.length - passed,
    checks,
  });
}
