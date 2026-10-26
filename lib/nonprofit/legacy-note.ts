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
