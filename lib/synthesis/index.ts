/**
 * Synthesis family — composite tools that triangulate across datasets.
 *
 *   prospect_360            — one person, every dataset, scored + angled
 *   org_360                 — one institution, in-play score + incumbents + angle
 *   liquidity_event_radar   — money in motion in a zip/town, cross-referenced
 *   relationship_graph      — warm paths via shared board service
 *   market_regime_brief     — eight sources → one regime + client talking points
 *   synthesis_playbooks     — the triangulation recipes (and the doctrine) on demand
 *
 * These call other registered tools in-process (lib/synthesis/core.ts). They
 * are the first thing Randall and Ask should reach for on any prospecting,
 * institution, area or market question; the single-dataset tools are for the
 * drill-down afterwards. Output is compact by design (Ask caps tool results)
 * and every composite reports `coverage` — which sources answered, failed or
 * were skipped — so an absent signal is never mistaken for an absent fact.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { prospect360 } from "./prospect360";
import { org360 } from "./org360";
import { liquidityEventRadar } from "./liquidity";
import { relationshipGraph } from "./graph";
import { marketRegimeBrief } from "./regime";
import { PLAYBOOKS, DOCTRINE, renderPlaybookFull, renderDoctrine } from "./playbooks";

export { PLAYBOOKS, DOCTRINE, renderDoctrine, renderPlaybookIndex, renderPlaybookFull } from "./playbooks";
export { SIGNAL_WEIGHTS, wealthSignalScore } from "./core";

export const SYNTHESIS_TOOLS: ToolDef[] = [
  {
    name: "prospect_360",
    description:
      "ONE CALL, EVERY DATASET, ONE DOSSIER for a named person — the first tool to call on any 'who is X / is X a prospect / why would X take a meeting' question. Fans out in parallel to the prospect DB, the national 990 board-member index, SEC Section 16 insider filings (owner name), SEC Form D related persons, IDFPR professional licenses, Cook County parcel sales and IDOR PTAX-203 transfers (buyer and seller sides), the employer's DOL 5500 plans (if employer is given) and, with includeContact=true, a free Apollo people match (no credits). Joins on normalized name × geography (pass city or zip — common surnames need one), drops rows under the identity floor, and returns: identity status (confirmed = ≥2 independent sources agree), a 0-100 wealth-signal score with its drivers (auditable weights), the evidence list with per-row confidence, compact per-source profiles, RANKED OUTREACH ANGLES with a draft first line and the guardrail that governs each, the do-not-contact flag from the DB, and coverage (which sources answered / failed / were skipped). Drill into any hit with the single-dataset tool named in `source`. Never contacts anyone; never spends credits.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "First + last (any order; 'Last, First' accepted)" },
        city: { type: "string", description: "Home city, e.g. Hinsdale — tightens every join" },
        state: { type: "string", default: "IL" },
        zip: { type: "string", description: "5-digit zip — the strongest geography key" },
        employer: { type: "string", description: "Employer name — pulls the sponsor's 5500 plans" },
        lookbackMonths: { type: "number", default: 24, maximum: 120, description: "Window for transactions, filings and sales" },
        includeContact: { type: "boolean", default: false, description: "Run the free Apollo people search (needs APOLLO_API_KEY; no credits spent)" },
        nameOrder: { type: "string", enum: ["auto", "first-last", "last-first"], default: "auto" },
      },
      required: ["name"],
    },
    handler: prospect360,
  },
  {
    name: "org_360",
    description:
      "ONE INSTITUTION, RESOLVED EVERYWHERE, SCORED FOR 'IS THE MANDATE IN PLAY' — the first tool to call on any nonprofit, foundation, plan sponsor, college or company question. Wave 1 resolves identity in parallel (IRS 990 e-file, IRS BMF, DOL 5500 by sponsor, Form ADV, GLEIF LEI, EDGAR ticker); wave 2 pulls depth against the resolved EIN/name (990 Part VII board with finance-titled decision makers flagged, ProPublica multi-year trend, DOL Schedule C named service providers = the incumbents, USAspending federal awards, SBA PPP, EDGAR full-text mentions). Returns the newest 990 financial summary with the prior year beside it (fees up? net assets down?), an additive in-play score (0-100) with every reason listed, the incumbent providers, the plans, RANKED ANGLES (fee-for-outcome benchmark, Schedule C displacement, DB de-risking, spending policy, grant-dependence) each with a draft opener and guardrail, and coverage. Give name (+state/city) or ein.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        ein: { oneOf: [{ type: "string" }, { type: "number" }] },
        state: { type: "string" },
        city: { type: "string" },
        includeEdgar: { type: "boolean", default: true, description: "false skips the EDGAR ticker lookup and full-text mention search (faster for small nonprofits)" },
      },
    },
    handler: org360,
  },
  {
    name: "liquidity_event_radar",
    description:
      "WHERE IS MONEY IN MOTION IN OUR ZIPS RIGHT NOW. One call scans a town or zip for the last N days across Cook County parcel sales AND IDOR PTAX-203 transfers (Hinsdale is split Cook/DuPage so both always run), SEC Forms 3/4/5 filed by insiders with a local address, and SEC Form D related persons with a local address — then cross-references every named party against the prospect DB (already known? do-not-contact? client?) and the 990 board index (chairs a foundation?). Returns events ranked by recency × size (with a premium for events that name a person directly), each with kind (home_sale | insider_filing | formd_person), parties, the known/board context, an actionable flag and the angle that fits the event type, plus counts and coverage. Defaults: Hinsdale, 180 days, sales ≥ $1M. Use before any nightly outreach run and whenever someone asks 'who just sold / who's new / who's raising money around here'. Pass crossReference=false for a faster raw scan.",
    inputSchema: {
      type: "object",
      properties: {
        zip: { type: "string" },
        city: { type: "string", default: "Hinsdale" },
        state: { type: "string", default: "IL" },
        lookbackDays: { type: "number", default: 180, maximum: 1095 },
        minPrice: { type: "number", default: 1000000, description: "Minimum sale consideration for parcel events" },
        maxEvents: { type: "number", default: 40, maximum: 120 },
        crossReference: { type: "boolean", default: true },
      },
    },
    handler: liquidityEventRadar,
  },
  {
    name: "relationship_graph",
    description:
      "THE WARMEST PATH to a person or institution, built from public board service. Seed with a person (their current 990 seats) or an org (its current board); depth 1 adds every co-board member, depth 2 adds each co-member's other seats (officers first, capped). Every person node is then intersected with the prospect DB so the graph says who we already know and their lead status. Returns connectors ranked (in-DB first, then by seat count) with the orgs they share, warmPaths with a ready 'ask the connector' line, the org list with assets, the edges, and coverage. Claims only 'serves alongside' — never 'knows'. Use for 'how do we get introduced to X', 'who on this board do we know', and to find the common thread between two prospects.",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Full name (first + last) to seed from" },
        org: { type: "string", description: "Org name to seed from (resolved via 990 search)" },
        ein: { oneOf: [{ type: "string" }, { type: "number" }] },
        state: { type: "string", description: "Scopes org matches to this state" },
        depth: { type: "number", enum: [1, 2], default: 1 },
        maxOrgs: { type: "number", default: 8, maximum: 15 },
        maxPeoplePerOrg: { type: "number", default: 25, maximum: 60 },
        includeDbMatch: { type: "boolean", default: true },
      },
    },
    handler: relationshipGraph,
  },
  {
    name: "market_regime_brief",
    description:
      "EIGHT SOURCES → ONE REGIME CALL → THREE CLIENT SENTENCES + ONE PROSPECT SENTENCE. Runs in parallel: morning_market_brief (22 FRED indicators + net liquidity + TGA + daily flows + full curve + OFR FSI), NY Fed recession probability, Atlanta Fed GDPNow, Shiller CAPE with historical percentile, Cboe VIX term structure + SKEW, Damodaran implied ERP, ACM term premia and the Philly Fed SPF consensus. Reads seven pillars (curve, credit, liquidity, growth, valuation, volatility, rates) with documented threshold rules, labels the regime (defensive / constructive / mixed) only when ≥3 pillars agree, and returns talkingPoints — whatChanged, whatWeDid, whatWeAreWatching, and a prospectHook (CAPE-implied real return vs plan assumptions). Also carries the firing signals, the consensus table and briefMarkdown. Indicators, not predictions. Use for the pre-market read, client letters, IPS reviews and any 'what should clients hear from us this week'.",
    inputSchema: {
      type: "object",
      properties: {
        includeSpf: { type: "boolean", default: true },
        includeTermPremia: { type: "boolean", default: true },
      },
    },
    handler: marketRegimeBrief,
  },
  {
    name: "synthesis_playbooks",
    description:
      "The triangulation playbooks and reasoning doctrine behind the composites — hypothesis → parallel fan-out → confirmation rule → angle → never-infer, for: prospect-360, org-360, liquidity-radar, relationship-graph, market-regime, icio-ria-prospect, endowment-benchmark. Call with no args for the index + doctrine, or id for one playbook's full steps (same step number = run in parallel). Use when a question has no composite yet (iCIO RIA screening, endowment benchmarking) or to explain HOW a conclusion was reached.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    handler: async (args: { id?: string }) => {
      if (args?.id) {
        const p = PLAYBOOKS.find((x) => x.id === args.id);
        if (!p) return { error: `Unknown playbook "${args.id}"`, available: PLAYBOOKS.map((x) => x.id) };
        return { playbook: p, rendered: renderPlaybookFull(p) };
      }
      return {
        doctrine: DOCTRINE,
        playbooks: PLAYBOOKS.map((p) => ({ id: p.id, question: p.question, composite: p.composite ?? null, steps: p.steps.length })),
        rendered: renderDoctrine(),
        note: "Pass id for the full step list of one playbook.",
      };
    },
  },
];

export const SYNTHESIS_DOMAIN: CatalogDomain = {
  id: "synthesis",
  label: "Synthesis / Triangulation",
  source: "Composite tools that fan out across the other families in-process and join on EIN / CRD / CIK / LEI / PIN or normalized name × geography; scored and angled (v0.33)",
  tools: [
    { name: "prospect_360", backing: "hybrid", probe: "unprobed", note: "Composite: prospects DB + 990 people + insiders + Form D + IDFPR + Cook/PTAX + 5500 (+ Apollo opt-in). Selftest runs a Hinsdale name with crossReference; coverage reports per-source outcomes." },
    { name: "org_360", backing: "hybrid", probe: "unprobed", note: "Composite: 990 + BMF + 5500/Sch C + ADV + LEI + EDGAR + USAspending + PPP + ProPublica." },
    { name: "liquidity_event_radar", backing: "hybrid", probe: "unprobed", note: "Composite: Cook + PTAX + insiders-by-location + Form D persons, cross-referenced to prospects DB and 990 people." },
    { name: "relationship_graph", backing: "postgres", probe: "unprobed", note: "990 Part VII graph walk + prospects DB intersection." },
    { name: "market_regime_brief", backing: "live-api", probe: "unprobed", note: "8 upstreams in parallel; each error-isolated. Slow-ish (10-20s cold)." },
    { name: "synthesis_playbooks", backing: "live-api", probe: "unprobed", note: "Static — the doctrine and recipes; always answers." },
  ],
};

export const SYNTHESIS_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "synth-playbooks", tool: "synthesis_playbooks", args: {}, note: "static; expect doctrine + 7 playbooks" },
  { name: "synth-prospect-360", tool: "prospect_360", args: { name: "Matthew Rice", city: "Hinsdale", state: "IL", lookbackMonths: 36 }, note: "composite probe — expect identity/evidence/angles/coverage; individual upstream failures surface in coverage.failed, not as a check failure" },
  { name: "synth-org-360", tool: "org_360", args: { name: "Hinsdale Hospital Foundation", state: "IL", includeEdgar: false }, note: "composite probe — 990 + BMF + 5500 + Sch C + ProPublica + USAspending + PPP" },
  { name: "synth-radar", tool: "liquidity_event_radar", args: { city: "Hinsdale", lookbackDays: 120, minPrice: 1500000, maxEvents: 10, crossReference: false }, note: "raw scan (no cross-ref) to keep the probe under the selftest budget" },
  { name: "synth-regime", tool: "market_regime_brief", args: { includeSpf: false, includeTermPremia: false }, note: "6 upstreams; needs FRED_API_KEY for the composite section" },
];
