/**
 * v0.30.0 (2026-10-19, M. Rice: "They should be in the VistaRandall
 * directives."): the LIVE nonprofit program settings are each program's
 * VistaRandall directive card (VistaOutreach; vistarandall
 * lib/outreach-nonprofit.ts). The engine reads them here at run time and
 * merges them over ./programs.ts, which is now the shape and the defaults
 * only (principal identity, titles, CRM tags, the built-in banned list, the
 * footer).
 *
 * GET https://vistarandall.app/api/nonprofit-programs
 *   Authorization: Bearer VISTACRM_BRIDGE_SECRET (same value in both projects)
 *
 * Any failure (missing secret, network, non-200, a program missing, a field
 * that does not validate) is returned as { ok: false }. The caller must NOT
 * fall back to the file defaults: it skips the run and says so.
 */

import { PROGRAMS, NonprofitProgram, GeoRule } from "./programs";

export type ProgramKey = "matt" | "ryan";

export interface EffectiveProgram {
  program: NonprofitProgram;
  enabled: boolean;
  target: number;
  directiveDnum: number | null;
  label: string;
}

export type RemoteLoad =
  | { ok: true; url: string; fetchedAt: string; programs: Record<ProgramKey, EffectiveProgram> }
  | { ok: false; url: string; error: string };

export function randallConfigUrl(): string {
  const base = (process.env.VISTARANDALL_BASE_URL || "https://vistarandall.app").replace(/\/+$/, "");
  return `${base}/api/nonprofit-programs`;
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validGeo(v: unknown): v is GeoRule[] {
  if (!Array.isArray(v) || !v.length) return false;
  return v.every((g: any) =>
    g && typeof g.state === "string" && /^[A-Z]{2}$/.test(g.state) && isNum(g.weight) &&
    (g.zipPrefixes === undefined || (isStrArr(g.zipPrefixes) && g.zipPrefixes.every((z: string) => /^\d{3}$/.test(z)))));
}

export async function loadEffectivePrograms(timeoutMs = 15_000): Promise<RemoteLoad> {
  const url = randallConfigUrl();
  const secret = process.env.VISTACRM_BRIDGE_SECRET;
  if (!secret) return { ok: false, url, error: "VISTACRM_BRIDGE_SECRET is not set on vistamark-ria-intel" };

  let j: any;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(timeoutMs) });
    j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) return { ok: false, url, error: `HTTP ${res.status}: ${String(j?.error ?? "no JSON body").slice(0, 300)}` };
  } catch (err) {
    return { ok: false, url, error: `unreachable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400) };
  }

  const list: any[] = Array.isArray(j.programs) ? j.programs : [];
  const out: Partial<Record<ProgramKey, EffectiveProgram>> = {};
  for (const k of ["matt", "ryan"] as ProgramKey[]) {
    const r = list.find((x) => x?.key === k);
    if (!r) return { ok: false, url, error: `VistaRandall returned no "${k}" program` };
    const bad = (field: string): RemoteLoad => ({ ok: false, url, error: `VistaRandall "${k}" program has an invalid ${field}` });
    if (typeof r.enabled !== "boolean") return bad("enabled");
    if (!Number.isInteger(r.target) || r.target < 1 || r.target > 10) return bad("target");
    if (typeof r.mailbox !== "string" || !/^[^@\s]+@[^@\s]+$/.test(r.mailbox)) return bad("mailbox");
    if (!isNum(r.minPool) || !isNum(r.maxPool) || r.minPool >= r.maxPool) return bad("pool band");
    if (!validGeo(r.geo)) return bad("geo");
    if (!isStrArr(r.boostCities)) return bad("boostCities");
    if (!isStrArr(r.affinities)) return bad("affinities");
    if (!isStrArr(r.facts) || !r.facts.length) return bad("facts");
    if (typeof r.thesis !== "string" || !r.thesis.trim()) return bad("thesis");
    if (!isStrArr(r.extraBanned)) return bad("extraBanned");

    const base = PROGRAMS[k];
    out[k] = {
      enabled: r.enabled,
      target: r.target,
      directiveDnum: Number.isInteger(r.directiveDnum) ? r.directiveDnum : null,
      label: typeof r.label === "string" && r.label ? r.label : k,
      program: {
        ...base,
        mailbox: r.mailbox,
        minPool: r.minPool,
        maxPool: r.maxPool,
        geo: r.geo.map((g: GeoRule) => (g.zipPrefixes ? { state: g.state, zipPrefixes: [...g.zipPrefixes], weight: g.weight } : { state: g.state, weight: g.weight })),
        boostCities: r.boostCities.map((c: string) => c.toUpperCase()),
        affinities: r.affinities,
        persona: { ...base.persona, facts: r.facts, thesis: r.thesis, banned: [...base.persona.banned, ...r.extraBanned] },
      },
    };
  }
  return { ok: true, url, fetchedAt: new Date().toISOString(), programs: out as Record<ProgramKey, EffectiveProgram> };
}
