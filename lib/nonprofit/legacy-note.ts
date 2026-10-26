/**
 * v0.36.1 (2026-10-26, Matt on a 10/23 draft that still opened
 * "[FOR MATT: CHICAGO HOPE ACADEMY ...]": "Still coming with verbiage.")
 *
 * Drafts made before v0.31.0 (2026-10-24) carry the engine's briefing as the
 * first paragraph of the body: "[FOR MATT: ...]" / "[FOR RYAN: ...]". New
 * drafts put it in an internal note instead. These helpers take that
 * paragraph out of an existing draft -- plain text (as the engine wrote it)
 * or HTML (once Outlook has re-saved it) -- and hand back the briefing so it
 * can become the internal note. Nothing else in the body is touched.
 */

import { normalizeOpening, HOPE_LINE } from "../outreach/opening";

const TEXT_RX = /^\s*\[FOR (?:MATT|RYAN|[A-Z]+):[^\]]*\]\s*/;

export function stripLegacyBriefingText(body: string): { body: string; briefing: string | null } {
  const m = body.match(TEXT_RX);
  if (!m) return { body, briefing: null };
  return { body: body.slice(m[0].length), briefing: m[0].trim().replace(/^\[|\]$/g, "") };
}

const decode = (s: string) => s
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, " ").trim();

/** HTML body: remove "[FOR X: ... ]" (it may be split by tags/entities) and the
 *  empty paragraphs it leaves at the top of the body. */
export function stripLegacyBriefingHtml(html: string): { body: string; briefing: string | null } {
  const rx = /\[(?:<[^>]*>|\s|&nbsp;)*FOR(?:<[^>]*>|\s|&nbsp;)+(?:MATT|RYAN|[A-Z]+):[\s\S]*?\]/;
  const m = html.match(rx);
  if (!m || m.index === undefined) return { body: html, briefing: null };
  // Only when it is the first visible text of the body.
  const bodyOpen = html.search(/<body[^>]*>/i);
  const start = bodyOpen >= 0 ? html.indexOf(">", bodyOpen) + 1 : 0;
  if (decode(html.slice(start, m.index)) !== "") return { body: html, briefing: null };
  const briefing = decode(m[0]).replace(/^\[|\]$/g, "");
  let after = html.slice(m.index + m[0].length);
  // Drop the now-empty block(s) and blank lines that followed the briefing.
  const EMPTY = /^(\s|&nbsp;|<br\s*\/?>|<\/?(?:span|font|o:p)[^>]*>)*/i;
  const EMPTY_BLOCK = /^\s*<(p|div)[^>]*>(\s|&nbsp;|<br\s*\/?>|<\/?(?:span|font|o:p)[^>]*>)*<\/\1>/i;
  after = after.replace(EMPTY, "");
  // close the block the briefing sat in, if it is now empty
  let before = html.slice(0, m.index);
  const openBlock = before.match(/<(p|div)[^>]*>((\s|&nbsp;|<\/?(?:span|font)[^>]*>)*)$/i);
  if (openBlock && new RegExp(`^(\\s|&nbsp;|<\\/?(?:span|font)[^>]*>)*<\\/${openBlock[1]}>`, "i").test(after)) {
    before = before.slice(0, before.length - openBlock[0].length);
    after = after.replace(new RegExp(`^(\\s|&nbsp;|<\\/?(?:span|font)[^>]*>)*<\\/${openBlock[1]}>`, "i"), "");
  }
  for (let i = 0; i < 6 && EMPTY_BLOCK.test(after); i++) after = after.replace(EMPTY_BLOCK, "");
  return { body: before + after, briefing };
}

// ---------------------------------------------------------------------------
// v0.36.1 (Matt, 2026-10-26: "asked for better opening than Susie emdash lower
// case wham... abrupt. Fit the directive."): drafts made before v0.36.0 open
// "Susie -- your career ...". Rewrite that opening, in place, to the house
// opening every new draft already uses (lib/outreach/opening.ts):
//   Susie,
//
//   Hope all is well. Your career ...
// ---------------------------------------------------------------------------

const escRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function alreadyHouse(text: string, first: string): boolean {
  return new RegExp(`^\\s*${escRx(first)},\\s*\\n\\s*\\n?\\s*${escRx(HOPE_LINE)}`, "i").test(text);
}

/** Plain-text body: house opening, or unchanged when it already has it. */
export function fixLegacyOpeningText(body: string, firstName: string | null | undefined): { body: string; changed: boolean } {
  const first = String(firstName || "").trim();
  if (!first || alreadyHouse(body, first)) return { body, changed: false };
  // Only a draft that opens on the recipient's name (with or without Hi/Dear)
  // is rewritten; anything else is left exactly as it is.
  if (!new RegExp(`^\\s*(?:(?:hi|hello|hey|dear)\\s+)?${escRx(first)}\\s*(?:,|:|—|–|-{1,2})`, "i").test(body)) return { body, changed: false };
  const out = normalizeOpening(body, first);
  return { body: out, changed: out !== body };
}

/** HTML body: rewrite only a leading "Name -- x..." / "Name, x..." / "Hi Name," in
 *  the first block, leaving every other tag and paragraph as the partner left it. */
export function fixLegacyOpeningHtml(html: string, firstName: string | null | undefined): { body: string; changed: boolean } {
  const first = String(firstName || "").trim();
  if (!first) return { body: html, changed: false };
  const bodyOpen = html.search(/<body[^>]*>/i);
  const start = bodyOpen >= 0 ? html.indexOf(">", bodyOpen) + 1 : 0;
  const head = html.slice(0, start);
  const rest = html.slice(start);
  // Leading tags/whitespace, then the first run of text.
  const m = rest.match(/^((?:\s|&nbsp;|<[^>]+>)*)([^<]+)/);
  if (!m) return { body: html, changed: false };
  const lead = m[1];
  const text = m[2].replace(/&nbsp;/g, " ");
  const DASH = "(?:—|–|&mdash;|&ndash;|-{1,2})";
  const rx = new RegExp(`^\\s*(?:(?:hi|hello|hey|dear)\\s+)?${escRx(first)}\\s*(?:,|:|${DASH})\\s*`, "i");
  const sm = text.match(rx);
  if (!sm) return { body: html, changed: false };
  let after = text.slice(sm[0].length);
  if (!after.trim()) return { body: html, changed: false };         // "Susie," alone on its line already
  if (new RegExp(`^${escRx(HOPE_LINE)}`, "i").test(after)) return { body: html, changed: false };
  after = after.replace(/^(?:i\s+)?hope (?:all is|everything is|things are|you(?:'|’)re|you are)(?: doing)? well[^.!?]*[.!?]*\s*/i, "");
  after = after.charAt(0).toUpperCase() + after.slice(1);
  const name = first === first.toUpperCase() || first === first.toLowerCase()
    ? first.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_x, p, c) => p + c.toUpperCase()) : first;
  const replaced = `${name},<br><br>${HOPE_LINE} ${after}`;
  return { body: head + lead + replaced + rest.slice(m[0].length), changed: true };
}
