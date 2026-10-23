/**
 * Angle engine — turns confirmed evidence into ranked outreach hooks.
 *
 * An angle is a specific, true, useful observation plus the guardrail that
 * governs using it. The ranking is deliberately simple and auditable: timing
 * beats affinity beats geography, recency boosts, and every angle names the
 * evidence it rests on. Drafts are first lines only — the outreach engines
 * (nightly prospect engine, nonprofit engine, Randall) own full drafts and the
 * draft-then-approve gate; this module never sends anything.
 */
import type { Evidence } from "./core";
import { usd } from "./core";

export interface Angle {
  rank: number;
  hook: string;
  /** Why this works, in one line, citing the evidence. */
  why: string;
  /** A first line Matt could actually send. Pattern-interrupt, no flattery. */
  openerDraft: string;
  /** The guardrail that applies before this angle is used. */
  guardrail: string;
  basis: Evidence["signal"][];
  score: number;
}

const GUARD = {
  consent: "Run prospect_lookup first: consent block + do-not-contact flags. Draft only; Matt approves before anything sends.",
  proEmail: "Professional (published) email only — Hunter/Apollo/firm domain. Never a home email or phone.",
  noPrice: "Never cite the transaction price, the filing, or the deed in the message itself — the timing is the hook, the record stays private.",
  public: "Reference only what is public and professional (board seat, title, employer). Nothing about family, health, or finances.",
  benchmark: "Benchmarks come from the org's own 990/5500 numbers vs peers — never characterize the incumbent, only the gap.",
};

function recencyBoost(e: Evidence): number {
  if (!e.date) return 0.6;
  const months = (Date.now() - Date.parse(e.date)) / (1000 * 3600 * 24 * 30.44);
  if (!Number.isFinite(months)) return 0.6;
  if (months <= 3) return 1.0;
  if (months <= 12) return 0.85;
  if (months <= 24) return 0.6;
  return 0.35;
}

export function buildProspectAngles(evidence: Evidence[], ctx: { firstName?: string; city?: string }): Angle[] {
  const out: Angle[] = [];
  const by = (s: Evidence["signal"]) => evidence.filter((e) => e.signal === s);
  const first = ctx.firstName ? ctx.firstName : "there";
  const town = ctx.city || "Hinsdale";

  for (const e of by("insider")) {
    const sale = /\bS\b|sale|disp/i.test(e.summary);
    out.push({
      rank: 0,
      hook: sale ? "Concentrated-stock / 10b5-1 planning" : "Equity-comp planning for a public-company insider",
      why: `${e.summary} (${e.source}).`,
      openerDraft: sale
        ? `${first} — most people who sell company stock in a scheduled plan never get shown what the after-tax proceeds could do if the next tranche were pre-planned instead of post-rationalized. Happy to show you the version I built for a neighbor in a similar seat.`
        : `${first} — insiders at companies like yours usually have two plans: the one in the 10b5-1 and the one nobody wrote down. I spend most of my week on the second one.`,
      guardrail: `${GUARD.noPrice} ${GUARD.proEmail}`,
      basis: ["insider"],
      score: 30 * e.confidence * recencyBoost(e),
    });
  }
  for (const e of by("formd_person")) {
    out.push({
      rank: 0,
      hook: "Pre-liquidity planning for a founder / GP (QSBS, trusts, carried interest)",
      why: `${e.summary} (${e.source}).`,
      openerDraft: `${first} — the most valuable hour a founder spends with an advisor is the one before the term sheet, not the one after the wire. If a raise or exit is on the horizon, I'd rather be early and useless than late and expensive.`,
      guardrail: `${GUARD.public} ${GUARD.proEmail}`,
      basis: ["formd_person"],
      score: 26 * e.confidence * recencyBoost(e),
    });
  }
  for (const e of by("parcel_sell")) {
    out.push({
      rank: 0,
      hook: "Proceeds in motion (recent home sale)",
      why: `${e.summary} (${e.source}).`,
      openerDraft: `${first} — a quick, non-salesy note from a ${town} neighbor: the window between a sale closing and year-end is where most of the tax outcome gets decided. If it's useful, I keep a one-page checklist for exactly that.`,
      guardrail: `${GUARD.noPrice} ${GUARD.consent}`,
      basis: ["parcel_sell"],
      score: 20 * e.confidence * recencyBoost(e),
    });
  }
  for (const e of by("parcel_buy")) {
    out.push({
      rank: 0,
      hook: "New neighbor — welcome + property-tax appeal note",
      why: `${e.summary} (${e.source}).`,
      openerDraft: `${first} — welcome to ${town}. Unsolicited but useful: DuPage/Cook reassessments usually land a year after a purchase and the appeal window is short. I'm happy to point you to the two people here who actually win appeals. No pitch attached.`,
      guardrail: `${GUARD.noPrice} ${GUARD.consent}`,
      basis: ["parcel_buy"],
      score: 16 * e.confidence * recencyBoost(e),
    });
  }
  const seats = by("board_seat");
  if (seats.length) {
    const biggest = seats.slice().sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))[0];
    out.push({
      rank: 0,
      hook: "Shared-institution / civic warm path",
      why: `${seats.length} board seat(s); largest: ${biggest.summary} (${biggest.source}).`,
      openerDraft: `${first} — I noticed the work you do with ${biggest.ref?.orgName ?? "that board"}. We run the investment program for a few organizations that size and I had a specific thought about the reserve policy question most boards your size are wrestling with this year.`,
      guardrail: GUARD.public,
      basis: ["board_seat", "co_board"],
      score: 12 * biggest.confidence + Math.min(8, seats.length * 2),
    });
  }
  for (const e of by("license")) {
    const prof = String(e.ref?.profession ?? e.summary).toLowerCase();
    const isPhysician = /physician|medical|surgeon|dentist/.test(prof);
    const isCpa = /public accountant|cpa/.test(prof);
    out.push({
      rank: 0,
      hook: isCpa ? "Referral-partner conversation (CPA)" : isPhysician ? "Physician-specific planning (tax, asset protection, practice equity)" : "Professional-affinity planning",
      why: `${e.summary} (${e.source}).`,
      openerDraft: isCpa
        ? `${first} — I'm a CFA/CAIA in ${town} and I send my clients' tax work to CPAs who actually return calls in March. I'd like to know if you take referrals; I'll trade you a look at how we handle the investment side.`
        : isPhysician
        ? `${first} — most physician households I meet are over-insured, under-sheltered and paying retail for both. Twenty minutes usually finds one of the three.`
        : `${first} — I work with a number of ${town} professionals on the part of the balance sheet that is not the practice. Happy to compare notes.`,
      guardrail: `${GUARD.proEmail} ${GUARD.public}`,
      basis: ["license"],
      score: 8 * e.confidence,
    });
  }
  for (const e of by("plan_sponsor")) {
    out.push({
      rank: 0,
      hook: "Employer plan — rollover / deferred-comp review",
      why: `${e.summary} (${e.source}).`,
      openerDraft: `${first} — the plan at your employer is bigger than most people realize, and the menu inside it decides more of your outcome than the market does. I review these for a living; happy to show you yours in ten minutes.`,
      guardrail: GUARD.public,
      basis: ["plan_sponsor"],
      score: 9 * e.confidence,
    });
  }
  if (!out.length) {
    out.push({
      rank: 0,
      hook: "Local identity — neighbor-to-neighbor",
      why: "No timing or affinity signal confirmed; geography is the only hook.",
      openerDraft: `${first} — I'm a ${town} neighbor and a CFA who runs a small investment firm here. No pitch: if you ever want a second set of eyes on a statement, I'm two streets over.`,
      guardrail: `${GUARD.consent} ${GUARD.proEmail}`,
      basis: [],
      score: 3,
    });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .map((a, i) => ({ ...a, rank: i + 1, score: Math.round(a.score * 10) / 10 }))
    .slice(0, 5);
}

export function buildOrgAngles(input: {
  orgName: string;
  fees?: number | null;
  feesPrior?: number | null;
  netAssets?: number | null;
  netAssetsPrior?: number | null;
  investments?: number | null;
  endowment?: number | null;
  dbPlan?: boolean;
  planAssets?: number | null;
  incumbents?: string[];
  grantsUsd?: number | null;
  decisionMakers?: string[];
}): Angle[] {
  const out: Angle[] = [];
  const dm = input.decisionMakers?.length ? ` (${input.decisionMakers.slice(0, 2).join(", ")})` : "";
  if (input.fees && input.fees > 0) {
    const rising = input.feesPrior !== null && input.feesPrior !== undefined && input.fees > input.feesPrior;
    const shrinking = input.netAssets !== null && input.netAssetsPrior !== null && input.netAssets !== undefined && input.netAssetsPrior !== undefined && input.netAssets < input.netAssetsPrior;
    out.push({
      rank: 0,
      hook: "Fee-for-outcome benchmark (Part IX 11f vs peers)",
      why: `990 reports ${usd(input.fees)} in investment-management fees${rising ? ", up from " + usd(input.feesPrior) : ""}${shrinking ? "; net assets fell year over year" : ""}.`,
      openerDraft: `Your newest 990 shows ${usd(input.fees)} going to investment management${shrinking ? " in a year net assets declined" : ""}. We benchmarked that against organizations your size in the region; the gap is worth one meeting with the finance committee${dm}.`,
      guardrail: GUARD.benchmark,
      basis: ["mgmt_fees"],
      score: 25 + (rising ? 10 : 0) + (shrinking ? 15 : 0),
    });
  }
  if (input.incumbents?.length) {
    out.push({
      rank: 0,
      hook: "Named incumbent on Schedule C — displacement comparison",
      why: `Schedule C names ${input.incumbents.slice(0, 3).join(", ")} as plan service providers.`,
      openerDraft: `Plan sponsors rarely get an independent second opinion on the adviser line of their Schedule C. We provide one, in writing, for free — most of the time it says 'you're fine', which is also worth knowing.`,
      guardrail: GUARD.benchmark,
      basis: ["db_plan"],
      score: 18,
    });
  }
  if (input.dbPlan) {
    out.push({
      rank: 0,
      hook: "Defined-benefit funding / de-risking conversation",
      why: `Sponsors a defined-benefit plan${input.planAssets ? ` (${usd(input.planAssets)})` : ""}.`,
      openerDraft: `Rates did the funding work for most DB plans over the last three years; the question now is whether the glide path locked any of it in. I'd like to show your committee the two-page version.`,
      guardrail: GUARD.benchmark,
      basis: ["db_plan"],
      score: 16,
    });
  }
  if ((input.endowment ?? 0) > 5e6 || (input.investments ?? 0) > 5e6) {
    out.push({
      rank: 0,
      hook: "Spending-policy & reserve review (endowment / invested securities)",
      why: `Invested securities ${usd(input.investments)}, endowment ${usd(input.endowment)}.`,
      openerDraft: `Organizations with ${usd(Math.max(input.endowment ?? 0, input.investments ?? 0))} invested usually have a spending rule written in a different rate environment than this one. We rewrite those; it is usually a one-meeting project.`,
      guardrail: GUARD.benchmark,
      basis: ["endowment"],
      score: 14,
    });
  }
  if ((input.grantsUsd ?? 0) > 1e6) {
    out.push({
      rank: 0,
      hook: "Federal-grant dependence → reserve policy",
      why: `${usd(input.grantsUsd)} in federal awards over the lookback window.`,
      openerDraft: `With ${usd(input.grantsUsd)} of federal funding in the mix, the reserve question is really a liquidity-ladder question. Happy to share the one we built for a similarly funded organization.`,
      guardrail: GUARD.benchmark,
      basis: ["grant"],
      score: 10,
    });
  }
  if (!out.length) {
    out.push({
      rank: 0,
      hook: "Peer benchmark (size cohort)",
      why: "No fee, plan or endowment signal confirmed; a peer comparison is still available.",
      openerDraft: `We keep a running benchmark of organizations ${input.orgName ? "like " + input.orgName : "your size"} in the region — happy to send the one-pager.`,
      guardrail: GUARD.benchmark,
      basis: [],
      score: 4,
    });
  }
  return out
    .sort((a, b) => b.score - a.score)
    .map((a, i) => ({ ...a, rank: i + 1 }))
    .slice(0, 5);
}
