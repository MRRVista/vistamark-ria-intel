/**
 * Outreach persona — the facts and voice every prospect-engine draft is
 * written from. Edit THIS file to change how the emails sound; the engine
 * and prompts read from it and never hardcode biography.
 *
 * Everything here is a claim the sender is willing to stand behind in an
 * SEC exam. Keep it factual. The engine forbids the model from adding facts
 * about Vistamark that are not in this file.
 */

export const PERSONA = {
  /** Who the email is from. Env-overridable so a different partner can run the engine. */
  senderName: process.env.OUTREACH_SENDER_NAME || "Matt Rice",
  senderTitle: process.env.OUTREACH_SENDER_TITLE || "Founder & Chief Investment Officer",
  firm: "Vistamark",
  firmLegal: process.env.OUTREACH_FIRM_LEGAL || "Vistamark Investments",
  office: "Vistamark Plaza, 333 Chestnut Street, downtown Hinsdale",
  officeShort: "333 Chestnut St, Hinsdale, IL 60521",
  website: process.env.OUTREACH_WEBSITE || "",

  /**
   * Biography the model may draw on. Each line is a discrete, checkable fact.
   * The model is told to use at most two of these per email — the point is
   * a neighbor writing a note, not a resume.
   */
  facts: [
    "Started Vistamark to serve Hinsdale — a wealth firm made in Hinsdale, for Hinsdale residents.",
    "Spent two decades as Chief Investment Officer at Fiducient Advisors, where the firm oversaw roughly $260 billion in client assets for institutions and family offices.",
    "Brings that institutional and family-office discipline to individual families in town.",
    "Lives in Hinsdale on Robbins Park.",
    "Kids attend Hinsdale Central.",
    "Office is at Vistamark Plaza, 333 Chestnut Street, in downtown Hinsdale.",
  ],

  /** The one-sentence framing the model should orbit. */
  thesis:
    "Institutional-grade investment counsel from a neighbor, not a downtown Chicago firm — made in Hinsdale to serve Hinsdale.",

  /** The only call to action permitted: a low-pressure local meeting. */
  callToAction:
    "A coffee at the office on Chestnut, or a walk around Robbins Park — twenty minutes, no pitch deck.",

  /** Words and constructions the model must not use. */
  banned: [
    "guarantee", "guaranteed", "outperform", "beat the market", "returns of", "track record of",
    "risk-free", "can't lose", "limited time", "act now", "exclusive offer", "free consultation",
    "AUM", "alpha", "synergy", "leverage our", "best-in-class", "world-class", "cutting-edge",
    "I hope this email finds you well", "I wanted to reach out", "touch base", "circle back",
  ],

  /**
   * Required footer. CAN-SPAM needs a valid physical address and a working
   * opt-out on every commercial email; the Marketing Rule wants the adviser
   * identified. Env-overridable so compliance can set the exact wording.
   */
  footer:
    process.env.OUTREACH_FOOTER ||
    [
      `${process.env.OUTREACH_FIRM_LEGAL || "Vistamark Investments"} · 333 Chestnut St, Hinsdale, IL 60521`,
      "If you'd rather not hear from me, reply \"no thanks\" and I won't write again.",
    ].join("\n"),
} as const;

/** Compact facts block for the prompt. */
export function personaFactsBlock(): string {
  return PERSONA.facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
}
