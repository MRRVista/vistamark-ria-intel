/**
 * Nonprofit outreach programs — one per principal. Edit THIS file to change
 * targeting, voice, or facts; the engine reads from it and hardcodes nothing
 * about either sender.
 *
 * Program design (M. Rice, 2026-10-16):
 *   MATT — Illinois hard (Chicago metro first), plus southeast Wisconsin,
 *          western Michigan, and northwestern Indiana. Pools under $200MM.
 *   RYAN — Midwest (IL/MI/WI/IN/OH), pools $25–110MM, shared affinities
 *          Ohio State / Northwestern and ties to Chicago, Cleveland, Akron,
 *          Columbus, Evanston.
 *
 * v0.30.0 (2026-10-19): the LIVE settings are each program's VistaRandall
 * directive card (VistaOutreach; vistarandall lib/outreach-nonprofit.ts). The
 * engine fetches them at run time (./remote-config.ts) and merges them over
 * this file, which is now the shape and the defaults only: editing mailbox,
 * pool band, geo, boost cities, affinities, facts or thesis HERE no longer
 * changes what runs. Edit the card.
 *
 * Every sender fact below is a claim the sender is willing to stand behind in
 * an SEC exam. The engine forbids the model from inventing facts about
 * Vistamark that are not in this file.
 *
 * v0.38.0 (2026-10-28): Ryan's [ALWAYS] fact had said Matt's career was at
 * "Fiducient Advisors and NEPC". Matt never worked at NEPC; the line was
 * written in v0.37.0 / vistarandall v1.165.0 and every Ryan draft since then
 * carried it. Corrected here and on the card (vistarandall repairs the saved
 * value). The engine's affinity and shared-tie guards were tightened in the
 * same release (lib/nonprofit/engine.ts).
 */

export interface GeoRule {
  state: string;
  /** Restrict to these 3-digit zip prefixes; omit for the whole state. */
  zipPrefixes?: string[];
  /** Candidate-ranking weight (higher = earlier). */
  weight: number;
}

export interface NonprofitProgram {
  key: "matt" | "ryan";
  /** Outlook mailbox the drafts land in (Graph app creds must cover it). */
  mailbox: string;
  /** VistaCRM coordinator the Lead is assigned to. */
  principalEmail: string;
  principalName: string;
  draftNoteName: string;               // the [FOR ____] bracket label
  /** Investable-pool band (GREATEST of BMF assets / 990 endowment / 990 investments). */
  minPool: number;
  maxPool: number;
  geo: GeoRule[];
  /** Extra weight when the org's city matches (affinity metros). */
  boostCities: string[];
  /** Shared affinities the research step hunts for on the person. */
  affinities: string[];
  /** Titles fed to Apollo people search (board roles come from the 990 Part VII). */
  titles: string[];
  crmTags: string[];
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
  "quick question",
];

const FIRM_LEGAL = process.env.OUTREACH_FIRM_LEGAL || "Vistamark Investments";
const OFFICE = "333 Chestnut St, Hinsdale, IL 60521";
const FOOTER =
  process.env.NONPROFIT_OUTREACH_FOOTER ||
  [
    `${FIRM_LEGAL} · ${OFFICE}`,
    "If you'd rather not hear from me, reply \"no thanks\" and I won't write again.",
  ].join("\n");

export const TITLES = [
  "Chief Financial Officer", "CFO", "Chief Investment Officer", "CIO",
  "Executive Director", "President", "Treasurer", "Controller",
  "VP Finance", "Director of Finance", "Chief Executive Officer",
  "Board Chair", "Trustee",
];

export const PROGRAMS: Record<"matt" | "ryan", NonprofitProgram> = {
  matt: {
    key: "matt",
    mailbox: process.env.NONPROFIT_MAILBOX_MATT || "mrice@vistamarkllc.com",
    principalEmail: "mrice@vistamarkllc.com",
    principalName: "Matt Rice",
    draftNoteName: "MATT",
    minPool: Number(process.env.NONPROFIT_MIN_POOL_MATT || 20_000_000),
    maxPool: Number(process.env.NONPROFIT_MAX_POOL_MATT || 200_000_000),
    geo: [
      // Illinois hard — Chicago metro (600–609) outranks everything, downstate still in.
      { state: "IL", zipPrefixes: ["600", "601", "602", "603", "604", "605", "606", "607", "608", "609"], weight: 5 },
      { state: "IL", weight: 3 },
      // Southeast Wisconsin: Milwaukee / Waukesha / Racine / Kenosha / Janesville.
      { state: "WI", zipPrefixes: ["530", "531", "532", "534", "535"], weight: 2 },
      // Western Michigan: Grand Rapids / Kalamazoo / Holland / Muskegon / Battle Creek.
      { state: "MI", zipPrefixes: ["490", "491", "493", "494", "495"], weight: 2 },
      // Northwestern Indiana: Gary / Hammond / Munster / Valparaiso / Michigan City.
      { state: "IN", zipPrefixes: ["463", "464"], weight: 2 },
    ],
    boostCities: ["CHICAGO", "EVANSTON", "OAK BROOK", "HINSDALE", "NAPERVILLE", "MILWAUKEE", "GRAND RAPIDS"],
    affinities: [
      "Northwestern University (alumni, faculty, or board ties)",
      "Chicago / Chicagoland civic and professional ties",
      "Hinsdale or west-suburban Chicago ties",
    ],
    titles: TITLES,
    crmTags: ["nonprofit outreach", "np-matt"],
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
        "Built Vistamark to give mid-sized institutions the kind of investment office the largest consultants reserve for their biggest clients: flexible, customized, and at a cost that makes sense at this size.",
        "Works directly with investment committees: manager research, portfolio construction, fiduciary governance support, and committee-meeting preparation.",
      ],
      thesis:
        "Decades of institutional investment expertise, delivered to mid-sized endowments, foundations, and retirement plans at a reasonable cost, with a client experience built around how each committee actually works.",
      banned: SHARED_BANNED,
      footer: FOOTER,
    },
  },
  ryan: {
    key: "ryan",
    mailbox: process.env.NONPROFIT_MAILBOX_RYAN || "rwalter@vistamarkllc.com",
    principalEmail: "rwalter@vistamarkllc.com",
    principalName: "Ryan Walter",
    draftNoteName: "RYAN",
    minPool: Number(process.env.NONPROFIT_MIN_POOL_RYAN || 25_000_000),
    maxPool: Number(process.env.NONPROFIT_MAX_POOL_RYAN || 110_000_000),
    geo: [
      { state: "IL", weight: 4 },
      { state: "OH", weight: 3 },
      { state: "WI", weight: 2 },
      { state: "MI", weight: 2 },
      { state: "IN", weight: 2 },
    ],
    boostCities: ["CHICAGO", "EVANSTON", "CLEVELAND", "AKRON", "COLUMBUS"],
    affinities: [
      "The Ohio State University (alumni, faculty, or board ties)",
      "Northwestern University (alumni, faculty, or board ties)",
      "Ties to Chicago IL, Cleveland OH, Akron OH, Columbus OH, or Evanston IL",
    ],
    titles: TITLES,
    crmTags: ["nonprofit outreach", "np-ryan"],
    persona: {
      senderName: "Ryan Walter",
      senderTitle: "Partner, Director of Institutional Advisory",
      firm: "Vistamark",
      firmLegal: FIRM_LEGAL,
      officeShort: OFFICE,
      facts: [
        "Partner and Director of Institutional Advisory at Vistamark Investments, an independent investment office in Hinsdale, Illinois.",
        "[ALWAYS] Works alongside Vistamark's founder and Chief Investment Officer, Matt Rice, who spent two decades as Chief Investment Officer at Fiducient Advisors, where the firm oversaw roughly $260 billion in client assets for institutions, endowments, foundations and retirement plans.",
        "Works with Midwest endowments, foundations, and nonprofit retirement plans in the $25 million to $110 million range.",
        "The practice covers manager research, portfolio construction, fiduciary governance support, and investment-committee support, at fees built for organizations this size.",
        "Engagements are flexible and customized to how each committee works, not a packaged model.",
      ],
      thesis:
        "Decades of institutional investment expertise, delivered to Midwest endowments, foundations, and retirement plans at a reasonable cost, with a flexible, customized client experience.",
      banned: SHARED_BANNED,
      footer: FOOTER,
    },
  },
};

/** v0.37.0: a card fact that starts with "[ALWAYS]" must appear in every
 *  draft's paragraph 2 (e.g. Ryan's line about working alongside Matt). */
export const ALWAYS_TAG = /^\s*\[ALWAYS\]\s*/i;

export function personaFactsBlock(p: NonprofitProgram): string {
  const always = p.persona.facts.filter((f) => ALWAYS_TAG.test(f));
  const lines = p.persona.facts.map((f, i) => `${i + 1}. ${f.replace(ALWAYS_TAG, "")}${ALWAYS_TAG.test(f) ? "  (REQUIRED: use this one in paragraph 2 of every email)" : ""}`);
  return lines.join("\n") + (always.length ? "\nThe REQUIRED fact counts toward the two-fact limit." : "");
}

/** Next two weekday call slots, skipping the next two business days so the
 *  recipient sees real near-term availability ("Tue 10/21 or Thu 10/23"). */
export function availabilityDates(now = new Date()): [string, string] {
  const tz = "America/Chicago";
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "numeric", day: "numeric" });
  const out: string[] = [];
  const d = new Date(now);
  let skipped = 0;
  while (out.length < 2) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
    if (dow === "Sat" || dow === "Sun") continue;
    if (skipped < 2) { skipped += 1; continue; }         // leave two business days of runway
    out.push(fmt.format(d).replace(",", ""));
    d.setUTCDate(d.getUTCDate() + 1);                     // space the two slots a day apart minimum
  }
  return [out[0], out[1]];
}
