/**
 * Lawyer COI outreach program -- Matt Rice, v0.39.0 (2026-10-30).
 *
 * ONE program card, FIVE sub-pools (lanes). Each lane is a referral
 * relationship the sender wants with a kind of attorney; the lane sets the
 * directory tools that feed it, the hook paragraph 2 orbits, and the ask
 * context. Shared rails (geography bands, pace, dedupe, house style, the
 * 20-minute intro ask) live on the card and in the engine.
 *
 *   ERISA        -> retirement plan work (plan-committee investment fiduciary)
 *   DIVORCE      -> private wealth; willing to serve as expert witness on
 *                   investment assets / asset division
 *   T&E          -> private wealth, trustee-friendly reporting
 *   TRANSACTION  -> family office intros after a liquidity event (iCIO)
 *   TAX          -> family office / liquidity-event structuring intros
 *
 * As with lib/nonprofit/programs.ts the LIVE settings are the VistaRandall
 * directive card (vistarandall lib/outreach-lawyer.ts), fetched at run time by
 * ./remote-config.ts and merged over this file. This file is the shape and
 * the defaults only.
 *
 * Every sender fact is a claim Matt is willing to stand behind in an SEC exam.
 * The engine forbids the model from inventing anything about Vistamark that is
 * not here.
 */

export type LawyerCategory = "erisa" | "divorce" | "te" | "transaction" | "tax";
export const LAWYER_CATEGORIES: LawyerCategory[] = ["erisa", "divorce", "te", "transaction", "tax"];

export interface GeoBand {
  /** 1 = Hinsdale, 2 = west suburbs, 3 = Chicago Loop / River North, 4 = full metro */
  band: 1 | 2 | 3 | 4;
  label: string;
  /** Title-case city names as the directories spell them. */
  cities: string[];
  /** 3-digit zip prefixes accepted for the band when a city is unknown. */
  zipPrefixes: string[];
  weight: number;
}

export interface LaneConfig {
  category: LawyerCategory;
  label: string;
  /** What this lane is for, in the sender's words (research + draft prompts). */
  purpose: string;
  /** The paragraph-2 angle: what Matt brings a lawyer in this lane. */
  hook: string;
  /** Directory tools that feed the lane, in priority order. */
  tools: string[];
  /** Leading Lawyers presets to sweep for the lane. */
  llPresets: string[];
  /** Divorce lane only: research flags HNW / asset-division work and the draft
   *  may mention willingness to serve as an expert witness. */
  expertWitness?: boolean;
}

export interface LawyerProgram {
  key: "matt";
  mailbox: string;
  principalEmail: string;
  principalName: string;
  geo: GeoBand[];
  affinities: string[];
  crmTags: string[];
  lanes: Record<LawyerCategory, LaneConfig>;
  /** Lane share of a mixed run, in order; the engine cycles through these. */
  laneOrder: LawyerCategory[];
  persona: {
    senderName: string;
    senderTitle: string;
    firm: string;
    firmLegal: string;
    officeShort: string;
    facts: string[];
    thesis: string;
    banned: string[];
    footer: string;
  };
}

const SHARED_BANNED = [
  "guarantee", "guaranteed", "outperform", "beat the market", "returns of", "track record of",
  "risk-free", "can't lose", "limited time", "act now", "exclusive offer", "free consultation",
  "alpha", "synergy", "leverage our", "best-in-class", "world-class", "cutting-edge",
  "I hope this email finds you well", "I wanted to reach out", "touch base", "circle back",
  "quick question", "hope all is well", "referral partner", "refer clients to me",
];

const FIRM_LEGAL = process.env.OUTREACH_FIRM_LEGAL || "Vistamark Investments";
const OFFICE = "333 Chestnut St, Hinsdale, IL 60521";
const FOOTER =
  process.env.LAWYER_OUTREACH_FOOTER ||
  [
    `${FIRM_LEGAL} \u00B7 ${OFFICE}`,
    "If you'd rather not hear from me, reply \"no thanks\" and I won't write again.",
  ].join("\n");

/** Staged geography. Band 1 is worked first; later bands only when the earlier
 *  ones are exhausted for the lane. */
export const GEO_BANDS: GeoBand[] = [
  { band: 1, label: "Hinsdale", cities: ["Hinsdale"], zipPrefixes: ["605"], weight: 10 },
  {
    band: 2, label: "West suburbs",
    cities: ["Oak Brook", "Western Springs", "Clarendon Hills", "Burr Ridge", "La Grange", "LaGrange", "Downers Grove", "Elmhurst", "Naperville", "Wheaton", "Glen Ellyn", "Lombard", "Westmont", "Willowbrook", "Darien", "Lisle", "Oakbrook Terrace"],
    zipPrefixes: ["605"], weight: 7,
  },
  { band: 3, label: "Chicago Loop / River North", cities: ["Chicago"], zipPrefixes: ["606"], weight: 4 },
  { band: 4, label: "Chicago metro", cities: [], zipPrefixes: ["600", "601", "602", "603", "604", "605", "606", "607", "608"], weight: 1 },
];

export const LANES: Record<LawyerCategory, LaneConfig> = {
  erisa: {
    category: "erisa",
    label: "ERISA / employee benefits",
    purpose: "Retirement plan work. When a plan committee needs an investment fiduciary (3(21)/3(38), OCIO, or an independent review), Matt wants to be the name the lawyer thinks of; when a client of Matt's needs ERISA counsel, the lawyer gets the call.",
    hook: "Matt spent two decades as CIO at Fiducient, which oversaw roughly $260 billion for institutions, endowments, foundations and retirement plans, and he now works directly with plan and investment committees at Vistamark.",
    tools: ["acebc_fellow_search", "leading_lawyers_search", "courtlistener_counsel"],
    llPresets: ["employee_benefits"],
  },
  divorce: {
    category: "divorce",
    label: "Divorce / matrimonial",
    purpose: "Private wealth after a divorce: QDRO and asset-division analysis, post-settlement planning for the spouse who ends up holding the investment assets. Matt is willing to serve as an expert witness on investment assets and asset division.",
    hook: "Vistamark manages private wealth from Hinsdale and Matt is willing to serve as an expert witness on investment assets and asset division when a case needs one.",
    tools: ["aaml_il_fellow_search", "collaborative_divorce_il_search", "leading_lawyers_search"],
    llPresets: ["family"],
    expertWitness: true,
  },
  te: {
    category: "te",
    label: "Trusts & estates",
    purpose: "Private wealth for the families and trusts the lawyer serves: trustee-friendly reporting, investment policy for trusts, and an investment office the estate planner can put a client in front of.",
    hook: "Matt wrote Think Like a Family Office (2026) and Nonprofit Asset Management (Wiley, 2012), and Vistamark gives trustees and families clear, trustee-friendly reporting from an independent investment office in Hinsdale.",
    tools: ["actec_fellow_search", "cepc_member_search", "naela_il_search", "leading_lawyers_search"],
    llPresets: ["estate", "elder"],
  },
  transaction: {
    category: "transaction",
    label: "Transaction / M&A",
    purpose: "Family office introductions after a liquidity event. Founders who just sold need an investment office; Vistamark's Integrated CIO works for family offices and Vistamark Consulting has sat on the M&A side.",
    hook: "Vistamark's Integrated CIO serves family offices and founders after a liquidity event, blending direct management with oversight of other assets, and Vistamark Consulting has M&A advisory experience.",
    tools: ["leading_lawyers_search"],
    llPresets: ["closely_held", "ma", "securities", "banking"],
  },
  tax: {
    category: "tax",
    label: "Tax",
    purpose: "Family office and liquidity-event structuring: entity structuring, QSBS, charitable and tax-managed investing for the clients the tax lawyer already advises.",
    hook: "Vistamark runs tax-managed and direct-indexing strategies and an Integrated CIO service for family offices and liquidity-event clients, from an independent office in Hinsdale.",
    tools: ["leading_lawyers_search"],
    llPresets: ["tax_individual", "tax_business"],
  },
};

export const PROGRAM: LawyerProgram = {
  key: "matt",
  mailbox: process.env.LAWYER_MAILBOX_MATT || "mrice@vistamark.com",
  principalEmail: "mrice@vistamarkllc.com",
  principalName: "Matt Rice",
  geo: GEO_BANDS,
  affinities: [
    "Northwestern University (alumni, faculty, or board ties)",
    "Hinsdale or west-suburban Chicago ties",
    "Chicago / Chicagoland civic and professional ties",
  ],
  crmTags: ["lawyer outreach", "coi", "lawyer-matt"],
  lanes: LANES,
  laneOrder: ["erisa", "divorce", "te", "transaction", "tax"],
  persona: {
    senderName: "Matt Rice, CFA, CAIA",
    senderTitle: "Founder & Chief Investment Officer",
    firm: "Vistamark",
    firmLegal: FIRM_LEGAL,
    officeShort: OFFICE,
    facts: [
      "Founder and Chief Investment Officer of Vistamark Investments, an independent investment office in Hinsdale, Illinois.",
      "Spent two decades as Chief Investment Officer at Fiducient Advisors, where the firm oversaw roughly $260 billion in client assets for institutions, endowments, foundations, retirement plans, and family offices.",
      "Holds the CFA and CAIA designations.",
      "Northwestern University graduate (economics).",
      "Author of Think Like a Family Office (2026) and Nonprofit Asset Management (Wiley, 2012).",
      "Vistamark's Integrated CIO service works with family offices and founders after a liquidity event, blending direct management with oversight of other assets.",
      "Works directly with investment and plan committees: manager research, portfolio construction, fiduciary governance support, and committee-meeting preparation.",
      "Willing to serve as an expert witness on investment assets and asset division in divorce proceedings.",
    ],
    thesis:
      "A Hinsdale neighbor with 25 years as a CIO who would like to know what you do, tell you what Vistamark does, and figure out together whether there are clients each of us should be sending the other.",
    banned: SHARED_BANNED,
    footer: FOOTER,
  },
};

export const ALWAYS_TAG = /^\s*\[ALWAYS\]\s*/i;

export function personaFactsBlock(p: LawyerProgram): string {
  const always = p.persona.facts.filter((f) => ALWAYS_TAG.test(f));
  const lines = p.persona.facts.map((f, i) => `${i + 1}. ${f.replace(ALWAYS_TAG, "")}${ALWAYS_TAG.test(f) ? "  (REQUIRED: use this one in paragraph 2 of every email)" : ""}`);
  return lines.join("\n") + (always.length ? "\nThe REQUIRED fact counts toward the two-fact limit." : "");
}

export function isCategory(v: unknown): v is LawyerCategory {
  return typeof v === "string" && (LAWYER_CATEGORIES as string[]).includes(v);
}
