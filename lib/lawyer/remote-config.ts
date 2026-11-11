/**
 * Lawyer COI outreach -- live settings come from the program's VistaRandall
 * directive card (vistarandall lib/outreach-lawyer.ts), read here at run time
 * and merged over ./programs.ts. v0.39.0, same contract as
 * lib/nonprofit/remote-config.ts.
 *
 * GET https://vistarandall.app/api/lawyer-programs
 *   Authorization: Bearer VISTACRM_BRIDGE_SECRET (same value in both projects)
 *
 * Any failure is returned as { ok: false }. The caller must NOT fall back to
 * the file defaults: it skips the run and says so.
 */

import { PROGRAM, LawyerProgram, LawyerCategory, isCategory } from "./programs";

export interface EffectiveLawyerProgram {
  program: LawyerProgram;
  enabled: boolean;
  target: number;
  /** null = cycle all lanes; otherwise every draft of the run goes to this lane. */
  category: LawyerCategory | null;
  /** Highest geo band the engine may work this run (1..4). */
  maxBand: 1 | 2 | 3 | 4;
  directiveDnum: number | null;
  label: string;
}

export type RemoteLoad =
  | { ok: true; url: string; fetchedAt: string; program: EffectiveLawyerProgram }
  | { ok: false; url: string; error: string };

export function randallConfigUrl(): string {
  const base = (process.env.VISTARANDALL_BASE_URL || "https://vistarandall.app").replace(/\/+$/, "");
  return `${base}/api/lawyer-programs`;
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export async function loadEffectiveLawyerProgram(timeoutMs = 15_000): Promise<RemoteLoad> {
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
  const r = list.find((x) => x?.key === "matt");
  if (!r) return { ok: false, url, error: `VistaRandall returned no "matt" lawyer program` };
  const bad = (field: string): RemoteLoad => ({ ok: false, url, error: `VistaRandall lawyer program has an invalid ${field}` });
  if (typeof r.enabled !== "boolean") return bad("enabled");
  if (!Number.isInteger(r.target) || r.target < 1 || r.target > 15) return bad("target");
  if (typeof r.mailbox !== "string" || !/^[^@\s]+@[^@\s]+$/.test(r.mailbox)) return bad("mailbox");
  if (r.category !== null && r.category !== undefined && !isCategory(r.category)) return bad("category");
  if (![1, 2, 3, 4].includes(r.maxBand)) return bad("maxBand");
  if (!isStrArr(r.affinities)) return bad("affinities");
  if (!isStrArr(r.facts) || !r.facts.length) return bad("facts");
  if (typeof r.thesis !== "string" || !r.thesis.trim()) return bad("thesis");
  if (!isStrArr(r.extraBanned)) return bad("extraBanned");
  if (r.laneOrder !== undefined && !(isStrArr(r.laneOrder) && r.laneOrder.every(isCategory))) return bad("laneOrder");

  const base = PROGRAM;
  return {
    ok: true, url, fetchedAt: new Date().toISOString(),
    program: {
      enabled: r.enabled,
      target: r.target,
      category: isCategory(r.category) ? r.category : null,
      maxBand: r.maxBand,
      directiveDnum: Number.isInteger(r.directiveDnum) ? r.directiveDnum : null,
      label: typeof r.label === "string" && r.label ? r.label : "Lawyer COI Outreach",
      program: {
        ...base,
        mailbox: r.mailbox,
        affinities: r.affinities,
        laneOrder: isStrArr(r.laneOrder) && r.laneOrder.length ? (r.laneOrder as LawyerCategory[]) : base.laneOrder,
        persona: { ...base.persona, facts: r.facts, thesis: r.thesis, banned: [...base.persona.banned, ...r.extraBanned] },
      },
    },
  };
}
