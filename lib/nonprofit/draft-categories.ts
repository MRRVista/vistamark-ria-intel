/**
 * Outlook categories on nonprofit outreach drafts — v0.34.1 (2026-10-23,
 * M. Rice: "unique categories on each category that make it clear where it
 * came from and also if it's original or a reply").
 *
 * Every draft the engine places carries TWO Outlook categories:
 *   1. the SPECIFIC chip: "Randall Outreach: D-095 MATT -- NONPROFIT OUTREACH (New)"
 *      — the program's VistaRandall card (D-number + label) and whether the
 *      draft opens a new thread (every nonprofit draft does today);
 *   2. the FAMILY tag "Randall-Nonprofit", which VistaRandall's engines and
 *      its outreach reply watch key on (Graph filters by exact category, not
 *      prefix).
 *
 * This is a copy of the naming functions in MRRVista/vistarandall
 * lib/draft-categories.ts. Edit both or neither.
 */

export const FAMILY_NONPROFIT = "Randall-Nonprofit";
export const OUTREACH_PREFIX = "Randall Outreach: ";
export type DraftMode = "new" | "reply";

export function cleanCategoryLabel(label: string, max = 60): string {
  return String(label || "")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

export function fmtDnumForCategory(dnum: number | null | undefined): string {
  return Number.isFinite(dnum as number) && (dnum as number) > 0 ? `D-${String(dnum).padStart(3, "0")}` : "";
}

export function outreachProgramCategory(dnum: number | null | undefined, label: string, mode: DraftMode): string {
  const d = fmtDnumForCategory(dnum);
  const name = cleanCategoryLabel(label) || "Nonprofit Outreach";
  return `${OUTREACH_PREFIX}${d ? d + " " : ""}${name} (${mode === "reply" ? "Reply" : "New"})`;
}

/** The categories array for a nonprofit outreach draft: specific first, family second. */
export function nonprofitDraftCategories(dnum: number | null | undefined, label: string, mode: DraftMode = "new"): string[] {
  return [outreachProgramCategory(dnum, label, mode), FAMILY_NONPROFIT];
}
