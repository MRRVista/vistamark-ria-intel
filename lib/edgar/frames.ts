/**
 * SEC EDGAR XBRL frames API — one concept across ALL filers for one period.
 * Live (data.sec.gov), no key, no ingest.
 *
 * companyconcept answers "what did company X report over time"; frames
 * answers the transpose: "what did EVERY filer report for concept Y in
 * period Z". That's cross-market screening — rank all filers by Assets,
 * Revenues, NetIncomeLoss, StockholdersEquity, etc., or pull a named
 * peer set's values for the same period.
 *
 * Endpoint: GET https://data.sec.gov/api/xbrl/frames/{taxonomy}/{concept}/{unit}/{frame}.json
 * Frame syntax:
 *   CY2025      — annual duration (flow concepts: Revenues, NetIncomeLoss)
 *   CY2025Q3    — quarterly duration
 *   CY2025Q3I   — instantaneous quarter-end (stock concepts: Assets,
 *                 Liabilities, StockholdersEquity)
 * The classic pitfall: instantaneous concepts 404 on duration frames and
 * vice versa — so on a miss, adjacent frame variants are retried
 * automatically and resolvedFrame/framesTried make the choice auditable.
 *
 * Response: { taxonomy, tag, ccp, uom, label, description, pts,
 *   data: [{ accn, cik, entityName, loc, start?, end, val }] } — one fact
 * per entity per frame (the SEC picks each filer's most relevant fact).
 */
import { jsonFetch } from "../data/http";

const FRAMES_BASE = "https://data.sec.gov/api/xbrl/frames";

function buildFrame(year: number, quarter?: number, instantaneous?: boolean): string {
  let f = `CY${year}`;
  if (quarter) f += `Q${quarter}`;
  if (instantaneous) f += "I";
  return f;
}

function frameCandidates(year: number, quarter?: number, instantaneous?: boolean): string[] {
  const primary = buildFrame(year, quarter, instantaneous);
  const candidates = [primary];
  if (quarter) {
    // Toggle the instantaneous suffix — the usual cause of a 404.
    candidates.push(buildFrame(year, quarter, !instantaneous));
  } else {
    // Annual frames only exist for duration concepts; for stock concepts
    // the year-end equivalent is the Q4 instantaneous frame.
    if (!instantaneous) candidates.push(buildFrame(year, 4, true));
    else candidates.push(buildFrame(year, 4, true), buildFrame(year, undefined, false));
  }
  return [...new Set(candidates)];
}

async function tryFrame(
  taxonomy: string,
  concept: string,
  unit: string,
  frame: string
): Promise<any | null> {
  try {
    const raw = await jsonFetch<any>(
      `${FRAMES_BASE}/${encodeURIComponent(taxonomy)}/${encodeURIComponent(concept)}/${encodeURIComponent(unit)}/${frame}.json`
    );
    return Array.isArray(raw?.data) && raw.data.length > 0 ? raw : null;
  } catch {
    // 404 = no frame published for this concept/unit/period combination.
    return null;
  }
}

export interface EdgarConceptFrameArgs {
  concept: string;
  year: number;
  quarter?: number;
  instantaneous?: boolean;
  taxonomy?: string;
  unit?: string;
  nameContains?: string;
  minValue?: number;
  sortDir?: "asc" | "desc";
  limit?: number;
}

export async function edgarConceptFrame(args: EdgarConceptFrameArgs) {
  if (!args.concept || !String(args.concept).trim()) {
    throw new Error(
      "edgar_concept_frame requires a concept (e.g. Assets, Revenues, NetIncomeLoss, StockholdersEquity)."
    );
  }
  if (!args.year || !Number.isFinite(Number(args.year))) {
    throw new Error("edgar_concept_frame requires a year (e.g. 2025).");
  }
  const concept = String(args.concept).trim();
  const taxonomy = args.taxonomy?.trim() || "us-gaap";
  const unit = args.unit?.trim() || "USD";
  const year = Number(args.year);
  const quarter = args.quarter ? Number(args.quarter) : undefined;
  if (quarter !== undefined && (quarter < 1 || quarter > 4)) {
    throw new Error("quarter must be 1-4.");
  }

  const candidates = frameCandidates(year, quarter, args.instantaneous);
  const framesTried: string[] = [];
  let raw: any = null;
  let resolvedFrame: string | null = null;
  for (const f of candidates) {
    framesTried.push(f);
    raw = await tryFrame(taxonomy, concept, unit, f);
    if (raw) {
      resolvedFrame = f;
      break;
    }
  }

  if (!raw || !resolvedFrame) {
    return {
      dataSource: "SEC EDGAR XBRL frames (data.sec.gov, live)",
      concept,
      taxonomy,
      unit,
      framesTried,
      totalEntities: 0,
      entities: [],
      note:
        `No frame published for ${taxonomy}/${concept}/${unit} in any of: ${framesTried.join(", ")}. ` +
        "Checks: (1) concept spelling — exact us-gaap tag names (case-sensitive); (2) unit — most monetary concepts are USD, share counts are 'shares', EPS is 'USD-per-shares'; (3) recency — frames lag filings by weeks, so the newest quarter may not exist yet; (4) duration vs instantaneous — flow concepts (Revenues) publish CY2025/CY2025Q3 frames, stock concepts (Assets) publish CY2025Q3I frames.",
    };
  }

  let rows: any[] = raw.data;
  if (args.nameContains && args.nameContains.trim()) {
    const needle = args.nameContains.trim().toLowerCase();
    rows = rows.filter((r) => String(r?.entityName ?? "").toLowerCase().includes(needle));
  }
  if (args.minValue != null) {
    rows = rows.filter((r) => Number(r?.val) >= Number(args.minValue));
  }
  const dir = args.sortDir === "asc" ? 1 : -1;
  rows = [...rows].sort((a, b) => dir * (Number(a?.val ?? 0) - Number(b?.val ?? 0)));
  const limit = Math.min(args.limit ?? 25, 200);
  const top = rows.slice(0, limit);

  return {
    dataSource: "SEC EDGAR XBRL frames (data.sec.gov, live)",
    concept: raw.tag ?? concept,
    label: raw.label ?? null,
    taxonomy: raw.taxonomy ?? taxonomy,
    unit: raw.uom ?? unit,
    resolvedFrame,
    framesTried,
    totalEntities: raw.pts ?? raw.data.length,
    matchedEntities: rows.length,
    returned: top.length,
    entities: top.map((r) => ({
      entityName: r?.entityName ?? null,
      cik: r?.cik != null ? String(r.cik).padStart(10, "0") : null,
      value: r?.val ?? null,
      start: r?.start ?? null,
      end: r?.end ?? null,
      accessionNumber: r?.accn ?? null,
    })),
    note:
      "One as-reported fact per filer per frame (the SEC selects each filer's most relevant fact); values are in the stated unit. Frames lag filings by weeks. Duration frames (CY2025, CY2025Q3) serve flow concepts like Revenues/NetIncomeLoss; instantaneous frames (CY2025Q3I) serve balance-sheet concepts like Assets/StockholdersEquity — mismatches are retried automatically (resolvedFrame shows what actually served the data). Use nameContains to pull a named peer set, minValue to floor a screen, sortDir 'asc' for smallest-first.",
  };
}
