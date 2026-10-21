/**
 * Illinois PTAX-203 real estate transfer declarations (IL Dept of Revenue via
 * data.illinois.gov Socrata, no key) + the DuPage County join.
 *
 * Datasets (verified live 2026-10-21):
 *   it54-y4c6  PTAX-203, 203-A, and 203-B — every declaration filed since 2013-01-01,
 *              statewide incl. Cook, updated weekly (newest recording ~1 week old).
 *              Fields used: declaration_id, document_number, date_recorded, full_address,
 *              line_1_* (street/city/zip/township/county/primary_pin/acreage),
 *              line_4_instrument_date, line_5_instrument_type, line_6_principal_residence,
 *              line_8_current_use / intended_use (form codes A–K), line_10* (circumstance
 *              checkboxes), line_11_full_consideration, line_13_net_consideration,
 *              step_4_seller_name, step_4_buyer_name, additional_buyers.
 *   dwt7-rycp  PTAX-203 Additional Buyers (declaration_id, buyer_name).
 *
 * DuPage: the county itself does not publish sale price/date in any open GIS layer
 * (ParcelsWithRealEstateCC and the ParcelSearch services carry owner/bill name and
 * assessed value only). PTAX is therefore THE machine-readable DuPage sales source;
 * dupage_parcel_sales filters PTAX to DuPage and joins each primary PIN to the DuPage
 * GIS parcel layer (same endpoint as lib/prospects/parcels.ts) for the current
 * bill name, mailing address, property class and assessed value.
 */
import { jsonFetch } from "../data/http";
import { IL_HOST, soda, soqlStr, soqlLike, soqlIn, chunk, num, str, day, isoDate, monthsAgo, clampLimit, strList } from "./socrata";
// Same layer as lib/prospects/parcels.ts DUPAGE_PARCELS_URL — duplicated (not imported) so this
// live-API family does not pull the Postgres prospects store into its module graph.
const DUPAGE_PARCELS_URL =
  "https://gis.dupageco.org/arcgis/rest/services/DuPage_County_IL/ParcelsWithRealEstateCC/FeatureServer/0";

const PTAX = "it54-y4c6";
const PTAX_BUYERS = "dwt7-rycp";

export const PTAX_USE_CODES: Record<string, string> = {
  A: "Land/lot only",
  B: "Residence (single-family, condo, townhome, duplex)",
  C: "Mobile home residence",
  D: "Apartment building (≤6 units)",
  E: "Apartment building (>6 units)",
  F: "Office",
  G: "Retail establishment",
  H: "Commercial building",
  I: "Industrial building",
  J: "Farm",
  K: "Other",
};

/** Circumstance checkboxes that make a transfer non-market. */
const NON_MARKET_FLAGS: Array<[string, string]> = [
  ["line_10b_sale_between_related", "related-parties"],
  ["line_10c_transfer_of_100", "less-than-100pct-interest"],
  ["line_10d_court_ordered_sale", "court-ordered"],
  ["line_10e_sale_in_lieu_of", "in-lieu-of-foreclosure"],
  ["line_10f_condemnation", "condemnation"],
  ["line_10g_short_sale", "short-sale"],
  ["line_10h_bank_reo", "bank-reo"],
  ["line_10i_auction_sale", "auction"],
  ["line_10p_trade_of_property", "trade"],
  ["line_10q_sale_leaseback", "sale-leaseback"],
];

const SELECT = [
  "declaration_id", "document_number", "date_recorded", "full_address", "line_1_street", "line_1_city", "line_1_zip_code",
  "line_1_township", "line_1_county", "line_1_primary_pin", "line_1_lot_size_or_acreage", "line_2_total_parcels",
  "line_4_instrument_date", "line_5_instrument_type", "line_6_principal_residence", "line_7_property_advertised",
  "line_8_current_use", "line_8_intended_use", "line_9_new_construction", "line_11_full_consideration",
  "line_13_net_consideration", "step_4_seller_name", "step_4_buyer_name", "additional_buyers",
  ...NON_MARKET_FLAGS.map(([f]) => f),
].join(",");

export interface PtaxArgs {
  county?: string;
  city?: string;
  zip?: string;
  township?: string;
  pin?: string | string[];
  address?: string;
  buyerName?: string;
  sellerName?: string;
  startDate?: string;
  endDate?: string;
  minPrice?: number;
  maxPrice?: number;
  useCodes?: string[];
  principalResidenceOnly?: boolean;
  marketOnly?: boolean;
  limit?: number;
}

function titleCounty(c: string): string {
  const s = c.trim().replace(/\s+county$/i, "");
  if (/^du\s*page$/i.test(s)) return "DuPage";
  if (/^la\s*salle$/i.test(s)) return "La Salle";
  if (/^de\s*kalb$/i.test(s)) return "DeKalb";
  if (/^de\s*witt$/i.test(s)) return "De Witt";
  if (/^mc\s*henry$/i.test(s)) return "McHenry";
  if (/^mc\s*lean$/i.test(s)) return "McLean";
  if (/^mc\s*donough$/i.test(s)) return "McDonough";
  return s.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Format a PIN the way PTAX stores it: DuPage/collar "09-12-129-011", Cook "18-06-117-009-0000". */
function ptaxPin(p: string): string[] {
  const d = String(p).replace(/\D/g, "");
  if (d.length === 10) {
    const ten = `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 7)}-${d.slice(7, 10)}`;
    return [ten, `${ten}-0000`];
  }
  if (d.length === 14) {
    const ten = `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 7)}-${d.slice(7, 10)}`;
    return [`${ten}-${d.slice(10)}`, ...(d.endsWith("0000") ? [ten] : [])];
  }
  return [String(p).trim()];
}

function buildWhere(args: PtaxArgs, notes: string[]): { where: string[]; startDate?: string; scoped: boolean } {
  const where: string[] = [];
  const pins = strList(args.pin).flatMap(ptaxPin);
  if (args.county) where.push(`line_1_county=${soqlStr(titleCounty(args.county))}`);
  if (args.city) where.push(`line_1_city=${soqlStr(args.city.toUpperCase())}`);
  if (args.zip) where.push(`starts_with(line_1_zip_code, ${soqlStr(args.zip.replace(/\D/g, "").slice(0, 5))})`);
  if (args.township) where.push(`upper(line_1_township)=${soqlStr(args.township.toUpperCase())}`);
  if (pins.length) where.push(`line_1_primary_pin in ${soqlIn(pins)}`);
  if (args.address) where.push(`upper(full_address) like ${soqlLike(args.address)}`);
  if (args.buyerName) where.push(`upper(step_4_buyer_name) like ${soqlLike(args.buyerName)}`);
  if (args.sellerName) where.push(`upper(step_4_seller_name) like ${soqlLike(args.sellerName)}`);
  const pointLookup = pins.length > 0 || !!args.address || !!args.buyerName || !!args.sellerName;
  const scoped = where.length > 0;
  if (!scoped) throw new Error("Give at least one of: county, city, zip, township, pin, address, buyerName, sellerName");
  if (!args.city && !args.zip && !args.township && !pointLookup && args.county) {
    notes.push("County-wide scan: consider city/zip to keep results local.");
  }
  const startDate = isoDate(args.startDate, "startDate") ?? (pointLookup ? undefined : monthsAgo(12));
  const endDate = isoDate(args.endDate, "endDate");
  if (startDate) where.push(`date_recorded >= ${soqlStr(startDate)}`);
  if (endDate) where.push(`date_recorded <= ${soqlStr(endDate + "T23:59:59")}`);
  const minPrice = args.minPrice ?? (pointLookup ? undefined : args.marketOnly === false ? undefined : 10000);
  if (minPrice != null) where.push(`line_11_full_consideration >= ${Number(minPrice)}`);
  if (args.maxPrice != null) where.push(`line_11_full_consideration <= ${Number(args.maxPrice)}`);
  const uses = strList(args.useCodes).map((u) => u.toUpperCase()).filter((u) => PTAX_USE_CODES[u]);
  if (uses.length) where.push(`line_8_current_use in ${soqlIn(uses)}`);
  if (args.principalResidenceOnly) where.push("line_6_principal_residence=true");
  const marketOnly = args.marketOnly ?? !pointLookup;
  if (marketOnly) {
    for (const [f] of NON_MARKET_FLAGS.slice(0, 6)) where.push(`(${f} IS NULL OR ${f}=false)`);
  }
  return { where, startDate, scoped };
}

function shapeRow(r: any, extraBuyers: Map<string, string[]>) {
  const flags = NON_MARKET_FLAGS.filter(([f]) => r[f] === true).map(([, label]) => label);
  const use = str(r.line_8_current_use);
  const id = String(r.declaration_id);
  return {
    declarationId: id,
    documentNumber: str(r.document_number),
    recorded: day(r.date_recorded),
    instrumentDate: day(r.line_4_instrument_date),
    address: str(r.full_address),
    county: str(r.line_1_county),
    township: str(r.line_1_township),
    pin: str(r.line_1_primary_pin),
    totalParcels: num(r.line_2_total_parcels),
    lotSize: str(r.line_1_lot_size_or_acreage),
    fullConsideration: num(r.line_11_full_consideration),
    netConsideration: num(r.line_13_net_consideration),
    instrumentType: str(r.line_5_instrument_type),
    currentUse: use ? `${use} ${PTAX_USE_CODES[use] ?? ""}`.trim() : null,
    principalResidence: r.line_6_principal_residence === true,
    newConstruction: r.line_9_new_construction === true || undefined,
    buyer: str(r.step_4_buyer_name),
    additionalBuyers: extraBuyers.get(id),
    seller: str(r.step_4_seller_name),
    flags: flags.length ? flags : undefined,
  };
}

async function fetchExtraBuyers(rows: any[]): Promise<Map<string, string[]>> {
  const ids = rows.filter((r) => r.additional_buyers === true).map((r) => String(r.declaration_id));
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const parts = await Promise.all(
    chunk(ids, 200).map((c) => soda(IL_HOST, PTAX_BUYERS, { $where: `declaration_id in ${soqlIn(c)}`, $limit: 1000 }))
  );
  for (const r of parts.flat()) {
    const id = String(r.declaration_id);
    const name = str(r.buyer_name);
    if (!name) continue;
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(name);
  }
  return out;
}

async function queryPtax(args: PtaxArgs, defaultLimit: number, maxLimit: number) {
  const notes: string[] = [];
  const limit = clampLimit(args.limit, defaultLimit, maxLimit);
  const { where, startDate } = buildWhere(args, notes);
  const order = args.minPrice != null && !args.pin && !args.address ? "line_11_full_consideration DESC" : "date_recorded DESC";
  const rows = await soda(IL_HOST, PTAX, { $select: SELECT, $where: where.join(" AND "), $order: order, $limit: limit });
  const extra = await fetchExtraBuyers(rows);
  return { rows, extra, notes, startDate, order, limit };
}

export async function ilPtaxTransfers(args: PtaxArgs = {}) {
  const { rows, extra, notes, startDate, order } = await queryPtax(args, 25, 200);
  const transfers = rows.map((r) => shapeRow(r, extra));
  if (!transfers.length) notes.push("No declarations matched. City names are upper-case on the form (HINSDALE); try zip instead, widen dates, or drop minPrice.");
  notes.push(
    "Seller-filed PTAX-203 declarations (IDOR), statewide since 2013, weekly refresh (~1 week lag). fullConsideration = line 11 sale price; buyers are often trusts/land trusts/LLCs. Buyer mailing addresses are not published. Default area scans: last 12 months, ≥$10k, related-party/partial-interest/court/foreclosure transfers excluded (marketOnly)."
  );
  return {
    dataSource: "Illinois Dept of Revenue PTAX-203 via data.illinois.gov (it54-y4c6, additional buyers dwt7-rycp)",
    query: { ...args, startDate, order },
    count: transfers.length,
    transfers,
    note: notes.join(" "),
  };
}

// ---------------------------------------------------------------------------
// DuPage join
// ---------------------------------------------------------------------------

async function dupageParcelsByPin(pins10: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const uniq = [...new Set(pins10.filter((p) => /^\d{10}$/.test(p)))];
  if (!uniq.length) return out;
  const fields = "PIN,BILLNAME,BILLADDRL1,BILLCITY,BILLSTATE,BILLZIP,PROPADDRL1,PROPCITY,REA017_PROP_CLASS,REA017_FCV_TOTAL,ACREAGE,EXEMPTCODE";
  const parts = await Promise.all(
    chunk(uniq, 100).map(async (c) => {
      const qs = new URLSearchParams({
        where: `PIN IN (${c.map((p) => `'${p}'`).join(",")})`,
        outFields: fields,
        returnGeometry: "false",
        f: "json",
      });
      const j: any = await jsonFetch(`${DUPAGE_PARCELS_URL}/query?${qs}`, { timeoutMs: 15000, retries: 1 });
      if (j?.error) throw new Error(`DuPage GIS error ${j.error.code}: ${j.error.message}`);
      return (j?.features ?? []).map((f: any) => f.attributes);
    })
  );
  for (const a of parts.flat()) out.set(String(a.PIN), a);
  return out;
}

const tt = (v: unknown) => (v == null ? null : String(v).replace(/\s+/g, " ").trim() || null);

export async function dupageParcelSales(args: PtaxArgs & { includeParcel?: boolean } = {}) {
  const a: PtaxArgs = { ...args, county: "DuPage" };
  const { rows, extra, notes, startDate, order } = await queryPtax(a, 25, 200);
  const sales = rows.map((r) => shapeRow(r, extra));
  let joined = 0;
  if (args.includeParcel !== false && sales.length) {
    try {
      const parcels = await dupageParcelsByPin(sales.map((s) => String(s.pin ?? "").replace(/\D/g, "").slice(0, 10)));
      for (const s of sales as any[]) {
        const p = parcels.get(String(s.pin ?? "").replace(/\D/g, "").slice(0, 10));
        if (!p) continue;
        joined++;
        const fcv = num(p.REA017_FCV_TOTAL);
        s.parcel = {
          billName: tt(p.BILLNAME),
          billAddress: [tt(p.BILLADDRL1), tt(p.BILLCITY), tt(p.BILLSTATE), tt(p.BILLZIP)].filter(Boolean).join(", ") || null,
          propertyClass: tt(p.REA017_PROP_CLASS),
          assessedValue: fcv,
          impliedMarketValue: fcv ? fcv * 3 : null,
          acreage: num(p.ACREAGE),
          exemptCode: tt(p.EXEMPTCODE),
        };
      }
    } catch (e: any) {
      notes.push(`DuPage GIS join failed (${String(e?.message ?? e).slice(0, 120)}); sales returned without parcel detail.`);
    }
  }
  if (!sales.length) notes.push("No DuPage declarations matched. Try zip:'60521' or city:'HINSDALE', widen dates, or drop minPrice.");
  notes.push(
    "DuPage County publishes no open sale price/date layer; this is the IDOR PTAX-203 feed (weekly, ~1 week lag) filtered to DuPage, joined by PIN to DuPage GIS ParcelsWithRealEstateCC (current bill name/address = who gets the tax bill now; assessed value ×3 ≈ market value). County GIS terms: internal use only, no redistribution."
  );
  return {
    dataSource: "IL Dept of Revenue PTAX-203 (data.illinois.gov it54-y4c6) + DuPage County GIS ParcelsWithRealEstateCC",
    query: { ...a, startDate, order },
    count: sales.length,
    parcelJoined: joined,
    sales,
    note: notes.join(" "),
  };
}
