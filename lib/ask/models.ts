/**
 * Model roster for POST /api/ask.
 *
 * WHY A ROSTER AND NOT TWO ENV PINS
 * ---------------------------------
 * Until v0.26 the Ask panel offered exactly two choices: the env-pinned
 * Anthropic model and the env-pinned OpenRouter model. Matt wants the same
 * freedom here that VistaRandall (vistamark-m365, lib/model-routing.ts) has:
 * the whole Anthropic lineup plus whatever OpenRouter serves, selectable per
 * question. This module is the single source of that list.
 *
 * ANTHROPIC side is a static registry. It mirrors VistaRandall's seed
 * registry (Opus 4.8 / 4.7 / 4.6, Fable 5, Sonnet 4.6, Haiku 4.5) and adds the
 * current generation (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5). Ids are
 * what the Messages API accepts. New models land via ASK_EXTRA_MODELS (JSON
 * array of {id,label,provider?,tier?,notes?}) with no code change.
 *
 * OPENROUTER side is fetched live from GET https://openrouter.ai/api/v1/models
 * (public, no key) and filtered to tool-capable models from a vendor
 * allowlist, cached in module memory for an hour. Hardcoding OpenRouter ids
 * is the one thing this file refuses to do beyond a tiny fallback: those ids
 * rotate monthly and a stale pick returns a 404 that reads as an outage.
 *
 * FAILOVER mirrors VistaRandall's MODEL_FALLBACKS: a Mythos-class primary
 * falls back to the Opus line when the primary is overloaded or not served.
 */

export type Provider = "anthropic" | "openrouter";

export interface ModelEntry {
  id: string;
  label: string;
  provider: Provider;
  /** 1 (cheapest) .. 5 (flagship). Console sorts descending within a provider. */
  tier: number;
  notes?: string;
  /** Context window, when known (OpenRouter reports it). */
  context?: number;
  /** USD per million tokens, when known. */
  priceIn?: number;
  priceOut?: number;
}

export const HARD_DEFAULT_ANTHROPIC = "claude-sonnet-4-6";
export const HARD_DEFAULT_OPENROUTER = "anthropic/claude-sonnet-4.5";

const ANTHROPIC_REGISTRY: ModelEntry[] = [
  // Current generation (2026-06+)
  { id: "claude-fable-5-1", label: "Fable 5.1", provider: "anthropic", tier: 5, notes: "Mythos-class flagship for chat and knowledge work." },
  { id: "claude-opus-5-5", label: "Opus 5.5", provider: "anthropic", tier: 5 },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "anthropic", tier: 3 },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", provider: "anthropic", tier: 1, notes: "Cheapest current model; fine for single-tool lookups." },
  // VistaRandall's seed registry (lib/model-routing.ts), kept so the two apps offer the same names
  { id: "claude-fable-5", label: "Fable 5", provider: "anthropic", tier: 5, notes: "VistaRandall email-compose pin since 2026-07-01." },
  { id: "claude-opus-4-8", label: "Opus 4.8", provider: "anthropic", tier: 5, notes: "VistaRandall complex-escalation default." },
  { id: "claude-opus-4-7", label: "Opus 4.7", provider: "anthropic", tier: 4 },
  { id: "claude-opus-4-6", label: "Opus 4.6", provider: "anthropic", tier: 4 },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", provider: "anthropic", tier: 3, notes: "Ask default (env ANTHROPIC_MODEL overrides)." },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", provider: "anthropic", tier: 1 },
];

/** Static fallback used only when the live OpenRouter catalog is unreachable. */
const OPENROUTER_FALLBACK: ModelEntry[] = [
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5 (via OpenRouter)", provider: "openrouter", tier: 3 },
  { id: "qwen/qwen3-32b", label: "Qwen3-32B", provider: "openrouter", tier: 1, notes: "VistaRandall OpenRouter pilot." },
];

/** Vendors whose OpenRouter models are offered. Anything else is noise in a picker. */
const OPENROUTER_VENDORS = new Set([
  "anthropic", "openai", "google", "x-ai", "deepseek", "meta-llama", "mistralai", "qwen", "perplexity", "cohere",
]);
const OPENROUTER_MAX = 60;
const OPENROUTER_TTL_MS = 60 * 60 * 1000;

/** Primary -> ordered fallbacks. Mirrors VistaRandall; extended to the 5.x line. */
export const MODEL_FALLBACKS: Record<string, string[]> = {
  "claude-fable-5-1": ["claude-opus-5-5", "claude-opus-4-8"],
  "claude-fable-5": ["claude-opus-4-8"],
  "claude-opus-5-5": ["claude-opus-4-8"],
  "claude-sonnet-5-5": ["claude-sonnet-4-6"],
  "claude-haiku-5-5": ["claude-haiku-4-5-20251001"],
};

export function modelChain(primary: string): string[] {
  const p = (primary || "").trim() || HARD_DEFAULT_ANTHROPIC;
  return Array.from(new Set([p, ...(MODEL_FALLBACKS[p] || [])]));
}

/** 429 / 5xx / 529 / "model not found" mean try the fallback; auth and validation errors do not. */
export function isModelUnavailable(status: number, bodyText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return true;
  const t = (bodyText || "").toLowerCase();
  if (t.includes("overloaded")) return true;
  if (status === 404 && t.includes("model")) return true;
  return false;
}

function extraModels(): ModelEntry[] {
  const raw = process.env.ASK_EXTRA_MODELS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.id === "string" && e.id.trim())
      .map((e) => ({
        id: e.id.trim(),
        label: typeof e.label === "string" && e.label.trim() ? e.label.trim() : e.id.trim(),
        provider: e.provider === "openrouter" ? "openrouter" : "anthropic",
        tier: Number.isFinite(e.tier) ? Number(e.tier) : 3,
        ...(typeof e.notes === "string" ? { notes: e.notes } : {}),
      }));
  } catch {
    return [];
  }
}

export function anthropicModels(): ModelEntry[] {
  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (const m of [...extraModels().filter((m) => m.provider === "anthropic"), ...ANTHROPIC_REGISTRY]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => b.tier - a.tier);
}

let orCache: { at: number; models: ModelEntry[] } | null = null;

function labelFromOpenRouter(id: string, name: string | undefined): string {
  if (name && name.trim()) return name.trim().replace(/^[^:]+:\s*/, "");
  return id.split("/").slice(-1)[0];
}

function tierFromPrice(priceOut: number | undefined): number {
  if (priceOut === undefined || !Number.isFinite(priceOut)) return 3;
  if (priceOut >= 20) return 5;
  if (priceOut >= 8) return 4;
  if (priceOut >= 2) return 3;
  if (priceOut >= 0.5) return 2;
  return 1;
}

export async function openRouterModels(opts: { timeoutMs?: number } = {}): Promise<{ models: ModelEntry[]; live: boolean }> {
  if (orCache && Date.now() - orCache.at < OPENROUTER_TTL_MS) return { models: orCache.models, live: true };
  const extra = extraModels().filter((m) => m.provider === "openrouter");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
    const resp = await fetch("https://openrouter.ai/api/v1/models", { signal: ctrl.signal, headers: { accept: "application/json" } });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`openrouter models ${resp.status}`);
    const data: any = await resp.json();
    const rows: any[] = Array.isArray(data?.data) ? data.data : [];
    const picked: ModelEntry[] = [];
    for (const r of rows) {
      const id: string = typeof r?.id === "string" ? r.id : "";
      if (!id || id.includes(":")) continue; // skip variant suffixes (:free, :nitro, :online)
      const vendor = id.split("/")[0];
      if (!OPENROUTER_VENDORS.has(vendor)) continue;
      const params: string[] = Array.isArray(r?.supported_parameters) ? r.supported_parameters : [];
      if (params.length && !params.includes("tools")) continue; // Ask is a tool loop; a model without tools is useless here
      const priceIn = r?.pricing?.prompt !== undefined ? Number(r.pricing.prompt) * 1e6 : undefined;
      const priceOut = r?.pricing?.completion !== undefined ? Number(r.pricing.completion) * 1e6 : undefined;
      picked.push({
        id,
        label: labelFromOpenRouter(id, r?.name),
        provider: "openrouter",
        tier: tierFromPrice(priceOut),
        ...(Number.isFinite(r?.context_length) ? { context: Number(r.context_length) } : {}),
        ...(priceIn !== undefined && Number.isFinite(priceIn) ? { priceIn: Math.round(priceIn * 100) / 100 } : {}),
        ...(priceOut !== undefined && Number.isFinite(priceOut) ? { priceOut: Math.round(priceOut * 100) / 100 } : {}),
      });
    }
    // Newest first per vendor is what the catalog order already gives; cap the list so the picker stays usable.
    const byVendor = new Map<string, ModelEntry[]>();
    for (const m of picked) {
      const v = m.id.split("/")[0];
      if (!byVendor.has(v)) byVendor.set(v, []);
      byVendor.get(v)!.push(m);
    }
    const perVendor = Math.max(4, Math.floor(OPENROUTER_MAX / Math.max(1, byVendor.size)));
    const models: ModelEntry[] = [];
    for (const [, list] of byVendor) models.push(...list.slice(0, perVendor));
    const ids = new Set(models.map((m) => m.id));
    for (const m of [...extra, ...OPENROUTER_FALLBACK]) if (!ids.has(m.id)) { models.push(m); ids.add(m.id); }
    models.sort((a, b) => a.id.localeCompare(b.id));
    orCache = { at: Date.now(), models };
    return { models, live: true };
  } catch {
    const ids = new Set<string>();
    const models = [...extra, ...OPENROUTER_FALLBACK].filter((m) => (ids.has(m.id) ? false : (ids.add(m.id), true)));
    return { models, live: false };
  }
}
