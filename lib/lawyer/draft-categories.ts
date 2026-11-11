/**
 * Outlook categories on lawyer COI outreach drafts -- v0.39.0. Same shape as
 * lib/nonprofit/draft-categories.ts: the SPECIFIC chip ("Randall Outreach:
 * D-0NN Lawyer COI Outreach (New)") plus the FAMILY tag "Randall-Lawyer" that
 * VistaRandall's reply watch keys on. Copy of the naming functions in
 * MRRVista/vistarandall lib/draft-categories.ts. Edit both or neither.
 */

import { outreachProgramCategory, DraftMode } from "../nonprofit/draft-categories";

export const FAMILY_LAWYER = "Randall-Lawyer";

/** The categories array for a lawyer outreach draft: specific first, family second. */
export function lawyerDraftCategories(dnum: number | null | undefined, label: string, mode: DraftMode = "new"): string[] {
  return [outreachProgramCategory(dnum, label || "Lawyer COI Outreach", mode), FAMILY_LAWYER];
}
