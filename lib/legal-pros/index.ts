/**
 * Legal Professionals family — Chicago-area attorneys by practice area, for the
 * referral-partner network (playbook §4.7) and prospecting. Attorneys are NOT in
 * IDFPR (`idfpr_licensee_search`); they are licensed by the Illinois ARDC.
 *
 *   Trusts & estates:   actec_fellow_search, cepc_member_search, naela_il_search
 *   Family law:         aaml_il_fellow_search, collaborative_divorce_il_search
 *   ERISA / benefits:   acebc_fellow_search, dol_sch_c_legal_counsel (DB — Schedule C code 29 = Legal)
 *   Any practice area:  leading_lawyers_search (Illinois, peer-recommended), courtlistener_counsel (federal dockets)
 *   Verification:       ardc_lawyer_lookup (licence status, firm, admission, discipline) — run last
 *   Doctrine:           legal_pros_playbook
 *
 * Per-source endpoints, quirks and what was verified live are in README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import {
  DIRECTORIES_ESTATE_FAMILY_TOOLS,
  DIRECTORIES_ESTATE_FAMILY_CATALOG,
  DIRECTORIES_ESTATE_FAMILY_CHECKS,
} from "./directories-estate-family";
import { ERISAGENERAL_TOOLS, ERISAGENERAL_CATALOG, ERISAGENERAL_CHECKS } from "./directories-erisa-general";
import { DERIVED_TOOLS, DERIVED_CATALOG, DERIVED_CHECKS } from "./derived";

export const LEGALPROS_TOOLS: ToolDef[] = [...DIRECTORIES_ESTATE_FAMILY_TOOLS, ...ERISAGENERAL_TOOLS, ...DERIVED_TOOLS];

export const LEGALPROS_DOMAIN: CatalogDomain = {
  id: "legalpros",
  label: "Legal Professionals (ACTEC · AAML-IL · Collaborative Divorce IL · CEPC · NAELA · ACEBC · Leading Lawyers · ARDC · Sch C legal · CourtListener)",
  source:
    "ACTEC Fellow directory · AAML Illinois (MembershipWorks) · Collaborative Divorce Illinois (GravityView) · Chicago Estate Planning Council services directory · NAELA Find-a-Lawyer · ACEBC Find a Fellow · Leading Lawyers (Law Bulletin Media) · Illinois ARDC Lawyer Search · DOL Form 5500 Schedule C (code 29) · CourtListener v4 RECAP",
  tools: [...DIRECTORIES_ESTATE_FAMILY_CATALOG, ...ERISAGENERAL_CATALOG, ...DERIVED_CATALOG],
};

export const LEGALPROS_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  ...DIRECTORIES_ESTATE_FAMILY_CHECKS,
  ...ERISAGENERAL_CHECKS,
  ...DERIVED_CHECKS,
];
