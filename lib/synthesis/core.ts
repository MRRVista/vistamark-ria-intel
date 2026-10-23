/**
 * Synthesis core — the fan-out / join plumbing every composite shares.
 *
 * Composites call OTHER registered tools in-process. That means a late-bound
 * lookup against lib/mcp/tools.ts (which imports this family), so the registry
 * is resolved at call time via dynamic import — never at module load — to keep
 * the import graph acyclic at evaluation time.
 *
 * Every upstream call is isolated: a timeout, a missing API key or an upstream
 * 500 degrades ONE source and is reported in `sources[]`, never thrown. The
 * composite's job is to be honest about coverage, not to pretend.
 */

export interface SourceResult<T = any> {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  /** Number of rows the source contributed after filtering, when countable. */
  rows?: number;
  error?: string;
  /** Raw (possibly trimmed) result — only present when `keepRaw` was requested. */
  raw?: T;
}

export interface FanOutCall {
  tool: string;
  args: Record<string, unknown>;
  /** Per-call timeout; composites budget ~20s total, so individual calls are capped lower. */
  timeoutMs?: number;
  /** Skip the call entirely (reported as skipped) — used for keyed tools without keys. */
  skip?: string;
}

const DEFAULT_CALL_TIMEOUT_MS = 12000;

async function resolveTool(name: string): Promise<((args: any) => Promise<any>) | null> {
  const mod: any = await import("../mcp/tools");
  const t = mod.TOOL_BY_NAME?.[name];
  return t?.handler ?? null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ]);
}

/** Run one registered tool, never throwing. */
export async function callTool<T = any>(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS
): Promise<{ src: SourceResult<T>; data: T | null }> {
  const started = Date.now();
  const handler = await resolveTool(tool);
  if (!handler) {
    return { src: { tool, args, ok: false, ms: 0, error: "unknown tool" }, data: null };
  }
  try {
    const data = (await withTimeout(Promise.resolve(handler(args)), timeoutMs, tool)) as T;
    return { src: { tool, args, ok: true, ms: Date.now() - started }, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { src: { tool, args, ok: false, ms: Date.now() - started, error: message.slice(0, 300) }, data: null };
  }
}

/** Run many registered tools in parallel. Results keep call order. */
export async function fanOut(calls: FanOutCall[]): Promise<Array<{ src: SourceResult; data: any }>> {
  return Promise.all(
    calls.map(async (c) => {
      if (c.skip) return { src: { tool: c.tool, args: c.args, ok: false, ms: 0, error: `skipped: ${c.skip}` }, data: null };
      return callTool(c.tool, c.args, c.timeoutMs);
    })
  );
}

/* ------------------------------ name helpers ------------------------------ */

const HONORIFICS = /\b(mr|mrs|ms|dr|hon|rev|sir|jr|sr|ii|iii|iv|esq|cpa|cfa|md|phd|jd)\b\.?/gi;

/** Normalize a person name for joins: lowercase, strip honorifics/suffixes/punct, collapse spaces. */
export function normName(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[.,'"()]/g, " ")
    .replace(HONORIFICS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split "Last, First M" / "First M Last" / "LAST FIRST" into {first,last}. */
export function splitName(full: string, order: "auto" | "first-last" | "last-first" = "auto"): { first: string; last: string } {
  const n = normName(full);
  if (!n) return { first: "", last: "" };
  if (full.includes(",")) {
    const [last, rest] = full.split(",");
    return { last: normName(last), first: normName(rest).split(" ")[0] ?? "" };
  }
  const parts = n.split(" ");
  if (parts.length === 1) return { first: "", last: parts[0] };
  if (order === "last-first") return { last: parts[0], first: parts[1] };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/** Loose person match: same last name AND (same first name OR first initial). */
export function samePerson(a: string, b: string): boolean {
  const x = splitName(a);
  const y = splitName(b);
  if (!x.last || !y.last || x.last !== y.last) return false;
  if (!x.first || !y.first) return true;
  return x.first === y.first || x.first[0] === y.first[0];
}

export function normOrg(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .toLowerCase()
    .replace(/[.,'"()&]/g, " ")
    .replace(/\b(the|inc|incorporated|llc|l l c|ltd|corp|corporation|co|company|foundation|fdn|trust|fund|of|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sameOrg(a: string, b: string): boolean {
  const x = normOrg(a);
  const y = normOrg(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/* ------------------------------ row helpers ------------------------------- */

/** Find the first array-valued field in a tool result (rows/results/items/filings/people/...). */
export function rowsOf(data: any): any[] {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data;
  for (const k of ["rows", "results", "items", "filings", "people", "transactions", "sales", "transfers", "licensees", "matches", "seats", "board", "awards", "loans", "plans", "providers", "firms", "advisors", "entities", "data"]) {
    if (Array.isArray(data[k])) return data[k];
  }
  for (const v of Object.values(data)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  return [];
}

/** First present value among candidate keys (case-insensitive). */
export function pick(row: any, ...keys: string[]): any {
  if (!row || typeof row !== "object") return undefined;
  const lower: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function monthsAgo(dateStr: unknown): number | null {
  if (typeof dateStr !== "string") return null;
  const d = Date.parse(dateStr);
  if (!Number.isFinite(d)) return null;
  return (Date.now() - d) / (1000 * 60 * 60 * 24 * 30.44);
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/** Trim a row to a handful of fields for compact output. */
export function compactRow(row: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = pick(row, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/* ---------------------------- evidence & scoring --------------------------- */

export interface Evidence {
  /** Signal family — drives scoring and angles. */
  signal:
    | "in_db"
    | "board_seat"
    | "insider"
    | "formd_person"
    | "license"
    | "parcel_buy"
    | "parcel_sell"
    | "plan_sponsor"
    | "pro_contact"
    | "ria"
    | "mgmt_fees"
    | "endowment"
    | "grant"
    | "ppp"
    | "edgar"
    | "lei"
    | "db_plan"
    | "formd_issuer"
    | "co_board";
  source: string;
  summary: string;
  /** 0..1 — how strongly this row identifies the subject (name+geo match etc.). */
  confidence: number;
  amount?: number | null;
  date?: string | null;
  ref?: Record<string, unknown>;
}

/** Signal weights for the wealth-signal score. Documented so the number is auditable. */
export const SIGNAL_WEIGHTS: Record<Evidence["signal"], number> = {
  insider: 30,        // Section 16 filer = public-company officer/director/10% holder
  formd_person: 25,   // exec/director/promoter of a Reg D issuer
  parcel_sell: 18,    // just sold = proceeds in motion
  parcel_buy: 15,     // just bought = new neighbor, home value tier
  board_seat: 12,     // civic capital; scaled by org assets
  license: 8,         // physician/CPA/etc.
  plan_sponsor: 10,   // employer plan size
  in_db: 5,           // already known
  pro_contact: 4,     // professional email path exists
  ria: 0, mgmt_fees: 0, endowment: 0, grant: 0, ppp: 0, edgar: 0, lei: 0, db_plan: 0, formd_issuer: 0, co_board: 6,
};

/** Roll evidence into a 0–100 score. Confidence-weighted, diminishing per family. */
export function wealthSignalScore(evidence: Evidence[]): { score: number; drivers: string[] } {
  const byFamily = new Map<string, number>();
  for (const e of evidence) {
    const w = SIGNAL_WEIGHTS[e.signal] ?? 0;
    const prior = byFamily.get(e.signal) ?? 0;
    // second and later hits in the same family add half as much
    byFamily.set(e.signal, prior + w * e.confidence * (prior ? 0.5 : 1));
  }
  const raw = Array.from(byFamily.values()).reduce((a, b) => a + b, 0);
  const score = Math.round(Math.min(100, raw));
  const drivers = Array.from(byFamily.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k} (+${Math.round(v)})`);
  return { score, drivers };
}

/** Coverage line: which sources answered, which failed, which were skipped. */
export function coverage(sources: SourceResult[]): { answered: string[]; failed: Array<{ tool: string; error: string }>; skipped: string[] } {
  return {
    answered: sources.filter((s) => s.ok).map((s) => s.tool),
    failed: sources.filter((s) => !s.ok && !(s.error ?? "").startsWith("skipped")).map((s) => ({ tool: s.tool, error: s.error ?? "error" })),
    skipped: sources.filter((s) => (s.error ?? "").startsWith("skipped")).map((s) => s.tool),
  };
}

export function hasEnv(...names: string[]): boolean {
  return names.every((n) => Boolean(process.env[n]));
}
