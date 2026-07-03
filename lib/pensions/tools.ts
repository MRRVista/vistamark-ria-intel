/**
 * MCP tool handlers for U.S. state & local public pension plans
 * (Public Plans Database, live API — no local ingest).
 *
 * Public pension systems are prime OCIO/iCIO targets and are NOT covered by
 * the DOL Form 5500 dataset (governmental plans are ERISA-exempt), so this
 * fills a real gap next to the corporate-plan (5500) and endowment (IPEDS)
 * datasets.
 *
 * Tools:
 *   ppd_plan_search  — screen/rank the plan universe (state, size, funded ratio)
 *   ppd_plan_profile — one plan's multi-year funding time series
 *
 * Honest-data conventions: values are passed through as reported (with unit
 * conversion flagged explicitly in the output); fields a plan didn't report
 * come back null; if the primary variable set fails, a minimal core set is
 * retried and the output says so (degraded: true). Nothing is fabricated.
 */
import { ppdQVariables, type PpdRow } from "./client";

// Primary variable set (PPD variable names). If the API rejects the set or
// returns nothing, we fall back to CORE_VARS and mark the response degraded.
const FULL_VARS = [
  "fy",
  "ppd_id",
  "PlanName",
  "StateAbbrev",
  "AdministeringGovt",
  "MktAssets_net",
  "ActAssets_GASB",
  "ActLiabilities_GASB",
  "ActFundedRatio_GASB",
  "InvestmentReturnAssumption_GASB",
  "actives_tot",
  "beneficiaries_tot",
];
const CORE_VARS = ["fy", "ppd_id", "PlanName", "MktAssets_net", "ActFundedRatio_GASB"];

/** Case-insensitive field getter (the API's key casing is not guaranteed). */
function field(row: PpdRow, ...names: string[]): any {
  for (const n of names) {
    if (row[n] !== undefined) return row[n];
  }
  const lower: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined) return v;
  }
  return undefined;
}

function num(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** PPD reports dollar amounts in THOUSANDS; convert to whole USD. */
function usdFromThousands(v: any): number | null {
  const n = num(v);
  return n == null ? null : n * 1000;
}

/** Ratios may arrive as fractions (0.72) or percents (72.0); normalize to percent. */
function toPercent(v: any): number | null {
  const n = num(v);
  if (n == null) return null;
  return Math.abs(n) <= 2 ? n * 100 : n;
}

function mapRow(row: PpdRow) {
  return {
    ppdId: num(field(row, "ppd_id")),
    planName: field(row, "PlanName") ?? null,
    state: field(row, "StateAbbrev", "StateName") ?? null,
    administeringGovtCode: num(field(row, "AdministeringGovt")),
    fy: num(field(row, "fy")),
    marketAssetsUsd: usdFromThousands(field(row, "MktAssets_net")),
    actuarialAssetsUsd: usdFromThousands(field(row, "ActAssets_GASB")),
    actuarialLiabilitiesUsd: usdFromThousands(field(row, "ActLiabilities_GASB")),
    fundedRatioPct: toPercent(field(row, "ActFundedRatio_GASB")),
    returnAssumptionPct: toPercent(field(row, "InvestmentReturnAssumption_GASB")),
    activeMembers: num(field(row, "actives_tot")),
    beneficiaries: num(field(row, "beneficiaries_tot")),
  };
}

async function fetchRecent(): Promise<{ rows: PpdRow[]; degraded: boolean; varsUsed: string[] }> {
  const fyStart = new Date().getFullYear() - 4;
  try {
    const { rows } = await ppdQVariables(FULL_VARS, { fyStart });
    if (rows.length) return { rows, degraded: false, varsUsed: FULL_VARS };
  } catch {
    // fall through to core set
  }
  const { rows } = await ppdQVariables(CORE_VARS, { fyStart });
  return { rows, degraded: true, varsUsed: CORE_VARS };
}

/** Keep only each plan's most recent fiscal year. */
function latestPerPlan(rows: PpdRow[]): PpdRow[] {
  const byPlan = new Map<string, PpdRow>();
  for (const row of rows) {
    const id = String(field(row, "ppd_id") ?? field(row, "PlanName") ?? "");
    if (!id) continue;
    const fy = num(field(row, "fy")) ?? -1;
    const prev = byPlan.get(id);
    const prevFy = prev ? num(field(prev, "fy")) ?? -1 : -2;
    if (!prev || fy > prevFy) byPlan.set(id, row);
  }
  return [...byPlan.values()];
}

const UNIT_NOTE =
  "PPD reports dollar amounts in thousands; this tool converts to whole USD (unitAssumption: 'PPD thousands \u00d7 1000'). Funded ratio and return assumption are normalized to percent. Fields a plan did not report are null \u2014 nothing is imputed.";

export interface PpdPlanSearchArgs {
  state?: string;
  nameContains?: string;
  minAssetsUsd?: number;
  maxAssetsUsd?: number;
  minFundedRatioPct?: number;
  maxFundedRatioPct?: number;
  sortBy?: "assets" | "funded_ratio" | "return_assumption" | "name";
  sortDir?: "asc" | "desc";
  limit?: number;
}

export async function ppdPlanSearch(args: PpdPlanSearchArgs) {
  const { rows, degraded, varsUsed } = await fetchRecent();
  let mapped = latestPerPlan(rows).map(mapRow);

  if (args.state) {
    const s = args.state.trim().toUpperCase();
    mapped = mapped.filter(
      (p) => p.state != null && String(p.state).trim().toUpperCase().startsWith(s)
    );
  }
  if (args.nameContains) {
    const n = args.nameContains.trim().toLowerCase();
    mapped = mapped.filter((p) => p.planName && String(p.planName).toLowerCase().includes(n));
  }
  if (args.minAssetsUsd != null) mapped = mapped.filter((p) => (p.marketAssetsUsd ?? -1) >= args.minAssetsUsd!);
  if (args.maxAssetsUsd != null) mapped = mapped.filter((p) => p.marketAssetsUsd != null && p.marketAssetsUsd <= args.maxAssetsUsd!);
  if (args.minFundedRatioPct != null) mapped = mapped.filter((p) => (p.fundedRatioPct ?? -1) >= args.minFundedRatioPct!);
  if (args.maxFundedRatioPct != null) mapped = mapped.filter((p) => p.fundedRatioPct != null && p.fundedRatioPct <= args.maxFundedRatioPct!);

  const dir = args.sortDir === "asc" ? 1 : -1;
  const key = args.sortBy ?? "assets";
  mapped.sort((a, b) => {
    if (key === "name") return dir * String(a.planName ?? "").localeCompare(String(b.planName ?? ""));
    const av =
      key === "funded_ratio" ? a.fundedRatioPct : key === "return_assumption" ? a.returnAssumptionPct : a.marketAssetsUsd;
    const bv =
      key === "funded_ratio" ? b.fundedRatioPct : key === "return_assumption" ? b.returnAssumptionPct : b.marketAssetsUsd;
    return dir * ((bv ?? -Infinity) < (av ?? -Infinity) ? -1 : (bv ?? -Infinity) > (av ?? -Infinity) ? 1 : 0) * -1;
  });

  const limit = Math.min(args.limit ?? 25, 250);
  const out = mapped.slice(0, limit);
  // NOTE: plans/matchCount lead the object deliberately — downstream summaries
  // truncate, and the data should surface before the boilerplate.
  return {
    matchCount: mapped.length,
    returned: out.length,
    plans: out,
    dataSource: "Public Plans Database (publicplansdata.org, live API)",
    unitAssumption: "PPD thousands \u00d7 1000",
    degraded,
    variablesUsed: varsUsed,
    universe:
      "~230 largest U.S. state & local public pension plans (CRR/MissionSquare/NASRA/GFOA panel), latest reported FY per plan",
    note:
      UNIT_NOTE +
      (degraded
        ? " NOTE: primary variable set failed; results use a reduced core set (some fields null)."
        : "") +
      " Public/governmental plans are ERISA-exempt and therefore NOT in the DOL 5500 dataset \u2014 this is the asset-owner universe for public-fund OCIO prospecting.",
  };
}

export interface PpdPlanProfileArgs {
  ppdId?: number;
  name?: string;
  limit?: number;
}

export async function ppdPlanProfile(args: PpdPlanProfileArgs) {
  let ppdId = args.ppdId ?? null;
  let resolvedName: string | null = null;

  if (ppdId == null) {
    if (!args.name) {
      return {
        dataSource: "Public Plans Database (publicplansdata.org, live API)",
        error: "ppd_plan_profile requires ppdId or name. Use ppd_plan_search to find a plan.",
        series: [],
      };
    }
    const { rows } = await fetchRecent();
    const n = args.name.trim().toLowerCase();
    const latest = latestPerPlan(rows);
    const names = latest.map((r) => String(field(r, "PlanName") ?? ""));
    const exactIdx = names.findIndex((nm) => nm.toLowerCase() === n);
    // Fuzzy fallback 1: plan name contains the query. Fallback 2: every word of
    // the query appears in the plan name (handles 'California PERS' vs
    // 'California Public Employees\u2019 Retirement System' style differences).
    const containsIdx = exactIdx >= 0 ? exactIdx : names.findIndex((nm) => nm.toLowerCase().includes(n));
    let idx = containsIdx;
    if (idx < 0) {
      const words = n.split(/\s+/).filter(Boolean);
      idx = names.findIndex((nm) => {
        const nl = nm.toLowerCase();
        return words.every((w) => nl.includes(w));
      });
    }
    if (idx < 0) {
      const sample = names.slice(0, 8);
      return {
        dataSource: "Public Plans Database (publicplansdata.org, live API)",
        error: `No plan matched \"${args.name}\". Use ppd_plan_search to browse the universe.`,
        sampleOfPlanNames: sample,
        series: [],
      };
    }
    const hit = latest[idx]!;
    ppdId = num(field(hit, "ppd_id"));
    resolvedName = field(hit, "PlanName") ?? null;
  }

  let history: PpdRow[] = [];
  let degraded = false;
  try {
    const res = await ppdQVariables(FULL_VARS, { fyStart: 2001, ppdId: ppdId ?? undefined });
    history = res.rows;
  } catch {
    const res = await ppdQVariables(CORE_VARS, { fyStart: 2001, ppdId: ppdId ?? undefined });
    history = res.rows;
    degraded = true;
  }
  // Defensive: filter to the target plan client-side even if the server-side
  // ppdid filter was ignored, so a filter-param mismatch can't return the
  // wrong plan's data.
  if (ppdId != null) {
    history = history.filter((r) => num(field(r, "ppd_id")) === ppdId);
  }

  const series = history
    .map(mapRow)
    .filter((r) => r.fy != null)
    .sort((a, b) => (a.fy! < b.fy! ? -1 : 1));
  const limit = Math.min(args.limit ?? 25, 30);
  const trimmed = series.slice(-limit);
  const latest = trimmed.length ? trimmed[trimmed.length - 1] : null;

  return {
    plan: {
      ppdId,
      planName: latest?.planName ?? resolvedName,
      state: latest?.state ?? null,
    },
    latest,
    observationCount: trimmed.length,
    series: trimmed,
    dataSource: "Public Plans Database (publicplansdata.org, live API)",
    unitAssumption: "PPD thousands \u00d7 1000",
    degraded,
    note:
      UNIT_NOTE +
      " Series is annual by plan fiscal year (FY2001+), oldest first, capped to the most recent " +
      limit +
      " years.",
  };
}
