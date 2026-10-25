/**
 * House opening for every first-touch outreach draft. v0.36.0.
 *
 * M. Rice, 2026-10-25, on a nonprofit draft that opened
 * "Michael — becoming the first new leader of Openlands…":
 *   "Name em dash bad way to start… Name, / Hope all is well…"
 *
 * Every draft now opens exactly:
 *
 *   Michael,
 *
 *   Hope all is well. <the specific opener…>
 *
 * The model is told this in the prompt (openingRule) AND the body is then
 * rewritten here (normalizeOpening), so "Michael — …", "Hi Michael,",
 * "Dear Michael:" or a doubled "Hope you're well" never reaches a mailbox.
 */

export const HOPE_LINE = "Hope all is well.";

/** Prompt line for the drafting model's rules list. */
export function openingRule(): string {
  return `- Opening (house rule, no exceptions): the first line is the recipient's first name followed by a comma and nothing else (e.g. "Michael,"). No "Hi", "Hello" or "Dear" before it, and never a dash after the name. Then a blank line, then begin the first paragraph with "${HOPE_LINE}" followed by the specific opener.`;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DASH = "[\\u2014\\u2013]|-{1,2}";

function displayName(first: string): string {
  // Apollo / assessor names sometimes arrive ALL CAPS or all lower.
  if (first === first.toUpperCase() || first === first.toLowerCase()) {
    return first.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  }
  return first;
}

/** Rewrite the start of a drafted body into the house opening. */
export function normalizeOpening(body: string, firstName: string | null | undefined): string {
  const first = (firstName || "").trim();
  let rest = body.replace(/^\s+/, "");

  // 1. Strip whatever salutation the model wrote.
  const lead = "(?:(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\\s+)";
  const salute = first
    ? new RegExp(`^${lead}?${esc(first)}\\s*(?:,|:|${DASH})\\s*`, "i")
    : new RegExp(`^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))(?:\\s+there)?\\s*(?:,|:|${DASH})\\s*`, "i");
  rest = rest.replace(salute, "");

  // 2. Drop a hope-you're-well line the model already wrote, so it isn't doubled.
  rest = rest.replace(/^(?:i\s+)?hope (?:all is|everything is|things are|you(?:'|’)re|you are)(?: doing)? well[^.!?\n]*[.!?…]*\s*/i, "");

  // 3. Re-capitalize the sentence that now follows "Hope all is well."
  rest = rest.charAt(0).toUpperCase() + rest.slice(1);

  const greeting = first ? `${displayName(first)},` : "Hello,";
  return `${greeting}\n\n${HOPE_LINE} ${rest}`;
}
