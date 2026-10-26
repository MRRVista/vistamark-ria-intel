/**
 * v0.37.0 (2026-10-26, M. Rice: "please remove all M dashes and opt for
 * different yet acceptable punctuation"). Firm-wide outreach rule: no em
 * dashes, en dashes or "--" in any drafted email, subject or body.
 *
 * The drafting prompts say so (dashRule), and every draft is then run through
 * stripDashes, because models slip back into em dashes even when told not to.
 * assertNoDashes is the last line: a draft that still carries one is refused.
 */

/** Prompt line for the drafting model's rules list. */
export function dashRule(): string {
  return `- Punctuation (house rule, no exceptions): never use an em dash (—), an en dash (–) or a double hyphen (--). Use a comma, a period, a colon or parentheses instead. Ordinary hyphenated words (e.g. "mid-sized") are fine.`;
}

const DASH_CLASS = "\\u2014\\u2013\\u2012\\u2015";

/** Replace every em/en dash and "--" with acceptable punctuation. */
export function stripDashes(text: string): string {
  let s = text;
  // HTML entities first, so the rest only sees characters.
  s = s.replace(/&mdash;|&#8212;|&#x2014;/gi, "—").replace(/&ndash;|&#8211;|&#x2013;/gi, "–");
  // Number ranges: "2019–2024", "$25–110 million" -> plain hyphen.
  s = s.replace(new RegExp(`(\\d)\\s*[${DASH_CLASS}]\\s*(\\$?\\d)`, "g"), "$1-$2");
  // "--" between digits is a range too.
  s = s.replace(/(\d)\s*--\s*(\$?\d)/g, "$1-$2");

  const DASH = `(?:[${DASH_CLASS}]|--+)`;
  // Name at the very start of a line ("Susie — your ...") -> "Susie, your ...".
  // Paired dashes inside one sentence ("X — an aside — Y") -> commas.
  // A dash alone on its line (footer separators) or dangling at a line end -> drop it.
  s = s.replace(new RegExp(`^[ \\t]*${DASH}[ \\t]*\\n?`, "gm"), "");
  s = s.replace(new RegExp(`[ \\t]*${DASH}[ \\t]*$`, "gm"), "");
  s = s.replace(new RegExp(`[ \\t]*${DASH}[ \\t]*([^.!?\\n${DASH_CLASS}]{1,140}?)[ \\t]*${DASH}[ \\t]*`, "g"), ", $1, ");
  // Any single dash left mid-line -> comma.
  s = s.replace(new RegExp(`[ \\t]*${DASH}[ \\t]*(?=\\S)`, "g"), ", ");

  // Tidy what the replacements can leave behind.
  s = s
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?:;)])/g, "$1")
    .replace(/([(:])\s*,\s*/g, "$1")
    .replace(/^,\s*/gm, "")
    .replace(/[ \t]{2,}/g, " ");
  return s;
}

/** True when the text still carries a forbidden dash. */
export function hasForbiddenDash(text: string): boolean {
  return new RegExp(`[${DASH_CLASS}]|--|&mdash;|&ndash;`, "i").test(text);
}

export function assertNoDashes(...texts: string[]): void {
  for (const t of texts) if (hasForbiddenDash(t)) throw new Error("draft still contains an em/en dash or \"--\" after cleanup");
}
