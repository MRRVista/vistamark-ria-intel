/**
 * Curated data.illinois.gov presets (Socrata, keyless). The State portal is
 * small (~300 datasets) and mostly IDPH health tables; these five are the ones
 * with prospecting / counterparty value that no other VistaIntel family covers.
 * PTAX-203 (it54-y4c6) and IDFPR licensing (pzzh-kp68) are already served by
 * lib/local-wealth (il_ptax_transfers, idfpr_licensee_search) and are NOT repeated.
 *
 * All verified live 2026-10-22:
 *   serf-cewv  DOI Insurance Producers (~? rows; snapshot 2024-06-13 — stale, flagged)
 *   iu6r-a89d  State Employee Pay (103,780 rows; refreshed ~monthly)
 *   2hsr-n93j  Active Lobbying Entities and Their Clients (SoS; daily)
 *   yrzn-vwcw  Sales and Use Tax Registration Certificate Revocation (IDOR; monthly)
 *   vbnw-q5s8  Cook County and Chicago Property Tax (transfer declaration) Form Data (IDOR; ~3M rows, daily)
 */
import { sodaQuery, soqlStr, soqlLike, num, str, isoDay, compactRow, clampLimit } from "./common";

const IL = "data.illinois.gov";

interface Preset {
  id: string;
  datasetId: string;
  name: string;
  description: string;
  select: string;
  order: string;
  freshness: string;
  /** map tool args → SoQL where fragments */
  filters: Record<string, (v: any) => string | null>;
  defaultWhere?: () => string | null;
  shape?: (r: any) => Record<string, unknown>;
}

const like = (field: string) => (v: any) => (v ? `upper(${field}) like ${soqlLike(String(v))}` : null);
const eq = (field: string) => (v: any) => (v ? `${field}=${soqlStr(String(v).trim())}` : null);
const gte = (field: string) => (v: any) => (Number.isFinite(Number(v)) && Number(v) > 0 ? `${field} >= ${Math.floor(Number(v))}` : null);
const zipPrefix = (field: string) => (v: any) => {
  if (!v) return null;
  const z = String(v).trim();
  if (!/^\d{5}$/.test(z)) throw new Error(`zip must be 5 digits (got '${z}')`);
  return `${field} like ${soqlStr(z + "%")}`;
};

export const IL_PRESETS: Preset[] = [
  {
    id: "insurance_producers",
    datasetId: "serf-cewv",
    name: "IL Dept of Insurance — licensed insurance producers",
    description: "Licensed insurance producers (agents/brokers) with mailing address and line of authority (Life, Health, Casualty, Fire, Variable Contracts, Personal Lines). One row per producer × line. Centers-of-influence list for a ZIP.",
    select: "last_name_or_business_name,first_name,mlg_address1,mailing_city,mailing_state,zip,loa_name",
    order: "last_name_or_business_name",
    freshness: "snapshot dated 2024-06-13 (not refreshed since; treat as historical)",
    filters: { name: like("last_name_or_business_name"), firstName: like("first_name"), city: like("mailing_city"), zip: zipPrefix("zip"), lineOfAuthority: like("loa_name") },
    shape: (r) => ({ name: [str(r.first_name), str(r.last_name_or_business_name)].filter(Boolean).join(" "), address: str(r.mlg_address1), city: str(r.mailing_city), state: str(r.mailing_state), zip: str(r.zip), lineOfAuthority: str(r.loa_name) }),
  },
  {
    id: "state_employee_pay",
    datasetId: "iu6r-a89d",
    name: "Illinois State Employee Pay (current employees)",
    description: "All current State of Illinois employees (paid in last 30 days, excl. sworn law enforcement): agency, division, name, title, period pay rate and YTD gross (USD). Use minYtdGross to find high earners (e.g. pension-system executives, physicians, university-affiliated officials).",
    select: "agency,agency_division,employee_name,position_title,period_pay_rate,ytd_gross",
    order: "ytd_gross DESC",
    freshness: "refreshed roughly monthly",
    filters: { name: like("employee_name"), agency: like("agency"), title: like("position_title"), minYtdGross: gte("ytd_gross") },
    shape: (r) => ({ name: str(r.employee_name), agency: str(r.agency), division: str(r.agency_division), title: str(r.position_title), periodPayRate: num(r.period_pay_rate), ytdGross: num(r.ytd_gross) }),
  },
  {
    id: "lobbying_clients",
    datasetId: "2hsr-n93j",
    name: "IL Secretary of State — active lobbying entities and their clients",
    description: "Registered Illinois lobbying entities and the clients they represent, past five registration years. Search by client (company/association) to see who lobbies for them, or by entity to see a lobbying firm's client roster.",
    select: "ent_reg_year,entity_id,entity_name,client_id,client_name",
    order: "ent_reg_year DESC, client_name",
    freshness: "daily",
    filters: { client: like("client_name"), entity: like("entity_name"), year: eq("ent_reg_year") },
    shape: (r) => ({ year: str(r.ent_reg_year), lobbyist: str(r.entity_name), lobbyistId: str(r.entity_id), client: str(r.client_name), clientId: str(r.client_id) }),
  },
  {
    id: "sales_tax_revocations",
    datasetId: "yrzn-vwcw",
    name: "IDOR — sales/use tax registration certificate revocations",
    description: "Illinois businesses whose Retailers' Occupation / Use Tax registration certificate was revoked by the Department of Revenue (IBT number, name, city, state, zip, date). A business-distress / compliance red flag for counterparty checks.",
    select: "ibt,name,city,state,zip,updated_at",
    order: "updated_at DESC",
    freshness: "monthly",
    filters: { name: like("name"), city: like("city"), zip: zipPrefix("zip"), state: eq("state") },
    shape: (r) => ({ ibt: str(r.ibt), name: str(r.name), city: str(r.city), state: str(r.state), zip: str(r.zip)?.slice(0, 5), revokedOrUpdated: isoDay(r.updated_at) }),
  },
  {
    id: "cook_transfer_forms",
    datasetId: "vbnw-q5s8",
    name: "IDOR — Cook County / Chicago real-estate transfer declaration forms",
    description: "Cook County transfer-declaration form and Chicago Form 7551 fields attached to PTAX-203 declarations: deed date/type, property use, full actual consideration (USD), mortgage amount, county tax, township. No address here — join on declaration_id to il_ptax_transfers (it54-y4c6) for the parcel/address. Use minConsideration for large transactions.",
    select: "declaration_id,county_form_deed_date,county_form_deed_type,county_form_property_use,county_form_interest_type,county_form_township,county_form_full_actual,county_form_mortgage_amount,county_form_county_tax_amount,chicago_form_attached",
    order: "county_form_deed_date DESC",
    freshness: "daily",
    filters: { minConsideration: gte("county_form_full_actual"), township: like("county_form_township"), deedType: like("county_form_deed_type"), declarationId: eq("declaration_id"), deedAfter: (v) => (v ? `county_form_deed_date >= '${String(v).slice(0, 10)}'` : null) },
    defaultWhere: () => "cook_county_form_attached=true",
    shape: (r) => ({ declarationId: str(r.declaration_id), deedDate: isoDay(r.county_form_deed_date), deedType: str(r.county_form_deed_type), propertyUse: str(r.county_form_property_use), interest: str(r.county_form_interest_type), township: str(r.county_form_township), consideration: num(r.county_form_full_actual), mortgage: num(r.county_form_mortgage_amount), countyTax: num(r.county_form_county_tax_amount), chicagoForm: r.chicago_form_attached === true }),
  },
];

export function listIlPresets() {
  return IL_PRESETS.map((p) => ({ preset: p.id, datasetId: p.datasetId, name: p.name, freshness: p.freshness, filters: Object.keys(p.filters), description: p.description }));
}

export async function ilOpenDataPresets(args: any) {
  const id = String(args?.preset ?? "").trim();
  if (!id || id === "list") {
    return { source: `data.illinois.gov presets`, fetchedAt: new Date().toISOString(), presets: listIlPresets(), note: "Call again with preset=<id> plus that preset's filters. Any other data.illinois.gov dataset: socrata_catalog_search → socrata_query with domain 'data.illinois.gov'." };
  }
  const p = IL_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset '${id}'. Valid: ${IL_PRESETS.map((x) => x.id).join(", ")}`);
  const limit = clampLimit(args?.limit, 25, 100);
  const where: string[] = [];
  const used: Record<string, unknown> = {};
  for (const [k, fn] of Object.entries(p.filters)) {
    const frag = fn(args?.[k]);
    if (frag) { where.push(frag); used[k] = args[k]; }
  }
  if (!where.length) throw new Error(`preset '${id}' needs at least one filter: ${Object.keys(p.filters).join(", ")}`);
  const dw = p.defaultWhere?.();
  if (dw) where.push(dw);
  const rows = await sodaQuery<any>(IL, p.datasetId, { select: p.select, where: where.join(" AND "), order: args?.order ? String(args.order) : p.order, limit });
  return {
    source: `data.illinois.gov ${p.datasetId} (${p.name})`,
    fetchedAt: new Date().toISOString(),
    preset: p.id,
    datasetId: p.datasetId,
    freshness: p.freshness,
    filters: used,
    returned: rows.length,
    hasMore: rows.length === limit,
    rows: rows.map((r: any) => (p.shape ? p.shape(r) : compactRow(r))),
  };
}
