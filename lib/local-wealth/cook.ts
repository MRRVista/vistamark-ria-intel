/**
 * cook_parcel_sales — Cook County Assessor open data (Socrata, no key).
 *
 * Datasets (ids verified live 2026-10-21 on datacatalog.cookcountyil.gov):
 *   wvhk-k5uv  Assessor - Parcel Sales: pin, sale_date, sale_price, doc_no, deed_type,
 *              mydec_deed_type, buyer_name, seller_name, class, township_code, nbhd,
 *              is_multisale, num_parcels_sale, sale_filter_* outlier flags. 1971 → ~2 months ago
 *              (MyDec-sourced rows carry buyer/seller names; ~90% of 2024+ rows have a buyer).
 *   3723-97qp  Assessor - Parcel Addresses: situs address + owner-of-record and taxpayer
 *              (mail) name/address by pin and roll year. Used for the address search, the
 *              city/zip → PIN universe, and the address join on returned sales.
 *   x54s-btds  Assessor - Residential Single and Multi-Family Improvement Characteristics:
 *              building sq ft, land sq ft, year built, beds, baths, type, quality. Condos
 *              (3r7i-mrz4) are not joined — class 299 sales come back without characteristics.
 *
 * Geography: the sales table has township_code but no city/zip, so city/zip filters first
 * pull the PIN universe for that city/zip from Parcel Addresses (cached 24h) and then query
 * sales in PIN chunks. Hinsdale-Cook (60521) is ~1,090 PINs, all in Lyons township (21).
 * City/zip universes over 6,000 PINs (e.g. Chicago) are refused — use township instead.
 */
import {
  COOK_HOST,
  soda,
  soqlStr,
  soqlLike,
  soqlIn,
  chunk,
  num,
  str,
  day,
  isoDate,
  monthsAgo,
  clampLimit,
  strList,
  cached,
} from "./socrata";

const SALES = "wvhk-k5uv";
const ADDRESSES = "3723-97qp";
const CHARS = "x54s-btds";
const DAY_MS = 24 * 3600 * 1000;

export const COOK_TOWNSHIPS: Record<string, string> = {
  BARRINGTON: "10", BERWYN: "11", BLOOM: "12", BREMEN: "13", CALUMET: "14", CICERO: "15", "ELK GROVE": "16",
  EVANSTON: "17", HANOVER: "18", LEMONT: "19", LEYDEN: "20", LYONS: "21", MAINE: "22", "NEW TRIER": "23",
  NILES: "24", NORTHFIELD: "25", "NORWOOD PARK": "26", "OAK PARK": "27", ORLAND: "28", PALATINE: "29",
  PALOS: "30", PROVISO: "31", RICH: "32", "RIVER FOREST": "33", RIVERSIDE: "34", SCHAUMBURG: "35",
  STICKNEY: "36", THORNTON: "37", WHEELING: "38", WORTH: "39", "HYDE PARK": "70", JEFFERSON: "71",
  LAKE: "72", "LAKE VIEW": "73", "NORTH CHICAGO": "74", "ROGERS PARK": "75", "SOUTH CHICAGO": "76",
  "WEST CHICAGO": "77",
};
const TOWNSHIP_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(COOK_TOWNSHIPS).map(([n, c]) => [c, n.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())])
);

/** "18-06-117-009-0000" / "1806117009" / 14 digits → 14-digit Cook PIN. */
export function normalizeCookPin(p: string): string {
  const d = String(p).replace(/\D/g, "");
  if (d.length === 10) return d + "0000";
  if (d.length === 14) return d;
  throw new Error(`Cook PIN must have 10 or 14 digits (got '${p}')`);
}

export function fmtCookPin(p: string): string {
  const d = String(p).replace(/\D/g, "").padEnd(14, "0");
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 7)}-${d.slice(7, 10)}-${d.slice(10, 14)}`;
}

function townshipCode(t: unknown): string | null {
  if (t == null || t === "") return null;
  const s = String(t).trim().toUpperCase();
  if (/^\d{2}$/.test(s)) return s;
  const code = COOK_TOWNSHIPS[s.replace(/\s+TOWNSHIP$/, "")];
  if (!code) throw new Error(`Unknown Cook township '${t}'. Use a name (e.g. Lyons, New Trier) or 2-digit code.`);
  return code;
}

async function latestAddressYear(): Promise<string> {
  return cached("cook:addr-year", DAY_MS, async () => {
    const rows = await soda(COOK_HOST, ADDRESSES, { $select: "max(year) as y" });
    const y = str(rows[0]?.y);
    if (!y) throw new Error("Could not determine the latest Cook Parcel Addresses roll year");
    return y.replace(/\.0$/, "");
  });
}

async function pinsForArea(city?: string, zip?: string): Promise<string[]> {
  const year = await latestAddressYear();
  const key = `cook:pins:${year}:${city ?? ""}:${zip ?? ""}`;
  return cached(key, DAY_MS, async () => {
    const where = [`year=${soqlStr(year)}`];
    if (city) where.push(`prop_address_city_name=${soqlStr(city.toUpperCase())}`);
    if (zip) where.push(`prop_address_zipcode_1=${soqlStr(zip.slice(0, 5))}`);
    const count = await soda(COOK_HOST, ADDRESSES, { $select: "count(*) as n", $where: where.join(" AND ") });
    const n = Number(count[0]?.n ?? 0);
    if (n > 6000) {
      throw new Error(
        `${city ?? zip} has ${n.toLocaleString()} Cook parcels — too many for a city/zip PIN join. Filter by township (e.g. township:'Lyons') instead.`
      );
    }
    const rows = await soda(COOK_HOST, ADDRESSES, { $select: "pin", $where: where.join(" AND "), $limit: 6000, $order: "pin" });
    return rows.map((r: any) => String(r.pin));
  });
}

async function addressesFor(pins: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!pins.length) return out;
  const year = await latestAddressYear();
  const parts = await Promise.all(
    chunk(pins, 250).map((c) =>
      soda(COOK_HOST, ADDRESSES, {
        $select:
          "pin,prop_address_full,prop_address_city_name,prop_address_zipcode_1,owner_address_name,owner_address_full,owner_address_city_name,mail_address_name,mail_address_full,mail_address_city_name",
        $where: `year=${soqlStr(year)} AND pin in ${soqlIn(c)}`,
        $limit: 1000,
      })
    )
  );
  for (const r of parts.flat()) out.set(String(r.pin), r);
  return out;
}

async function characteristicsFor(pins: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (!pins.length) return out;
  const parts = await Promise.all(
    chunk(pins, 150).map((c) =>
      soda(COOK_HOST, CHARS, {
        $select:
          "pin,year,card,class,char_yrblt,char_bldg_sf,char_land_sf,char_beds,char_rooms,char_fbath,char_hbath,char_type_resd,char_cnst_qlty,char_ext_wall,char_bsmt,char_gar1_size,char_use",
        $where: `pin in ${soqlIn(c)}`,
        $order: "year DESC, card ASC",
        $limit: 2000,
      })
    )
  );
  for (const r of parts.flat()) {
    const pin = String(r.pin);
    if (!out.has(pin)) out.set(pin, r); // newest year, first card
  }
  return out;
}

function compactChars(r: any) {
  if (!r) return null;
  return {
    rollYear: str(r.year)?.replace(/\.0$/, "") ?? null,
    yearBuilt: num(r.char_yrblt),
    buildingSqft: num(r.char_bldg_sf),
    landSqft: num(r.char_land_sf),
    beds: num(r.char_beds),
    fullBaths: num(r.char_fbath),
    halfBaths: num(r.char_hbath),
    type: str(r.char_type_resd),
    use: str(r.char_use),
    quality: str(r.char_cnst_qlty),
    exterior: str(r.char_ext_wall),
    basement: str(r.char_bsmt),
    garage: str(r.char_gar1_size),
  };
}

export interface CookSalesArgs {
  pin?: string | string[];
  address?: string;
  city?: string;
  zip?: string;
  township?: string;
  startDate?: string;
  endDate?: string;
  minPrice?: number;
  maxPrice?: number;
  deedTypes?: string[];
  buyerName?: string;
  sellerName?: string;
  includeFiltered?: boolean;
  includeCharacteristics?: boolean;
  includeAddresses?: boolean;
  limit?: number;
}

export async function cookParcelSales(args: CookSalesArgs = {}) {
  const limit = clampLimit(args.limit, 25, 200);
  const notes: string[] = [];
  let pins: string[] = strList(args.pin).map(normalizeCookPin);
  const explicitPins = pins.length > 0;
  let addressMatches: any[] = [];

  if (!explicitPins && args.address) {
    const year = await latestAddressYear();
    const where = [`year=${soqlStr(year)}`, `upper(prop_address_full) like ${soqlLike(args.address)}`];
    if (args.city) where.push(`prop_address_city_name=${soqlStr(args.city.toUpperCase())}`);
    if (args.zip) where.push(`prop_address_zipcode_1=${soqlStr(args.zip.slice(0, 5))}`);
    addressMatches = await soda(COOK_HOST, ADDRESSES, {
      $select: "pin,prop_address_full,prop_address_city_name,prop_address_zipcode_1",
      $where: where.join(" AND "),
      $limit: 50,
    });
    if (!addressMatches.length) {
      return {
        dataSource: "Cook County Assessor Parcel Addresses (3723-97qp)",
        query: args,
        count: 0,
        sales: [],
        note: `No Cook parcel address matches '${args.address}'${args.city ? ` in ${args.city}` : ""}. Use the street as the roll writes it (e.g. '603 JUSTINA'; suffixes are abbreviated: ST, AVE, RD).`,
      };
    }
    pins = addressMatches.map((r) => String(r.pin));
  } else if (!explicitPins && (args.city || args.zip)) {
    pins = await pinsForArea(args.city, args.zip);
    if (!pins.length) {
      return {
        dataSource: "Cook County Assessor Parcel Addresses (3723-97qp)",
        query: args,
        count: 0,
        sales: [],
        note: `No Cook parcels with situs ${args.city ?? ""} ${args.zip ?? ""}. Cook rolls use upper-case city names (HINSDALE); DuPage-side Hinsdale is in dupage_parcel_sales.`,
      };
    }
  }

  const tCode = townshipCode(args.township);
  const pinScoped = pins.length > 0;
  if (!pinScoped && !tCode && !args.buyerName && !args.sellerName) {
    throw new Error("cook_parcel_sales needs at least one of: pin, address, city, zip, township, buyerName, sellerName");
  }

  // Date defaults: PIN/address lookups see full history; area scans default to the last 12 months.
  const startDate = isoDate(args.startDate, "startDate") ?? (pinScoped && (explicitPins || args.address) ? undefined : monthsAgo(12));
  const endDate = isoDate(args.endDate, "endDate");

  const base: string[] = [];
  if (tCode) base.push(`township_code=${soqlStr(tCode)}`);
  if (startDate) base.push(`sale_date >= ${soqlStr(startDate)}`);
  if (endDate) base.push(`sale_date <= ${soqlStr(endDate + "T23:59:59")}`);
  if (args.minPrice != null) base.push(`sale_price >= ${Number(args.minPrice)}`);
  if (args.maxPrice != null) base.push(`sale_price <= ${Number(args.maxPrice)}`);
  const deeds = strList(args.deedTypes);
  if (deeds.length) base.push(`deed_type in ${soqlIn(deeds.map((d) => d.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Quit Claim$/i, "Quit claim")))}`);
  if (args.buyerName) base.push(`upper(buyer_name) like ${soqlLike(args.buyerName)}`);
  if (args.sellerName) base.push(`upper(seller_name) like ${soqlLike(args.sellerName)}`);
  if (!args.includeFiltered && !explicitPins) {
    base.push("sale_filter_less_than_10k=false", "sale_filter_deed_type=false");
  }

  const select =
    "pin,sale_date,sale_price,doc_no,deed_type,mydec_deed_type,buyer_name,seller_name,class,township_code,nbhd,is_multisale,num_parcels_sale,sale_type,sale_filter_same_sale_within_365,sale_filter_less_than_10k,sale_filter_deed_type";
  let rows: any[];
  if (pinScoped) {
    const parts = await Promise.all(
      chunk(pins, 300).map((c) =>
        soda(COOK_HOST, SALES, {
          $select: select,
          $where: [...base, `pin in ${soqlIn(c)}`].join(" AND "),
          $order: "sale_date DESC",
          $limit: limit,
        })
      )
    );
    rows = parts.flat();
  } else {
    rows = await soda(COOK_HOST, SALES, { $select: select, $where: base.join(" AND "), $order: "sale_date DESC", $limit: limit });
  }
  rows.sort((a, b) => String(b.sale_date).localeCompare(String(a.sale_date)) || (num(b.sale_price) ?? 0) - (num(a.sale_price) ?? 0));
  rows = rows.slice(0, limit);

  const salePins = [...new Set(rows.map((r) => String(r.pin)))];
  const [addrs, chars] = await Promise.all([
    args.includeAddresses === false ? Promise.resolve(new Map<string, any>()) : addressesFor(salePins),
    args.includeCharacteristics === false ? Promise.resolve(new Map<string, any>()) : characteristicsFor(salePins),
  ]);

  const sales = rows.map((r) => {
    const pin = String(r.pin);
    const a = addrs.get(pin);
    const flags = [
      r.sale_filter_less_than_10k ? "under-10k" : null,
      r.sale_filter_deed_type ? "non-arms-length-deed" : null,
      r.sale_filter_same_sale_within_365 ? "repeat-sale-within-365d" : null,
      r.is_multisale ? `multi-parcel(${num(r.num_parcels_sale) ?? "?"})` : null,
    ].filter(Boolean);
    return {
      pin: fmtCookPin(pin),
      saleDate: day(r.sale_date),
      salePrice: num(r.sale_price),
      deedType: str(r.mydec_deed_type) ?? str(r.deed_type),
      docNo: str(r.doc_no),
      buyer: str(r.buyer_name),
      seller: str(r.seller_name),
      class: str(r.class),
      township: TOWNSHIP_NAME[String(r.township_code)] ?? str(r.township_code),
      address: a ? [str(a.prop_address_full), str(a.prop_address_city_name), str(a.prop_address_zipcode_1)].filter(Boolean).join(", ") : null,
      currentOwnerOfRecord: a ? str(a.owner_address_name) : undefined,
      currentTaxpayer: a ? str(a.mail_address_name) : undefined,
      characteristics: chars.size ? compactChars(chars.get(pin)) : undefined,
      flags: flags.length ? flags : undefined,
    };
  });

  if (!rows.length) notes.push("No sales matched. The table lags ~2 months behind recording; widen the date range or drop minPrice.");
  if (sales.some((s) => s.class?.startsWith("29"))) notes.push("Class 299 = condo unit; characteristics are only joined for single/multi-family (class 2xx non-condo).");
  notes.push(
    "Buyer/seller names come from MyDec (PTAX) and are present on most post-2013 arm's-length sales; land-trust and LLC buyers need SOS/deed work. currentOwnerOfRecord/currentTaxpayer are from the latest roll and can differ from the buyer. For the freshest recordings (~1 week lag) use il_ptax_transfers with county 'Cook'."
  );

  return {
    dataSource: "Cook County Assessor open data: Parcel Sales (wvhk-k5uv) + Parcel Addresses (3723-97qp) + Residential Characteristics (x54s-btds)",
    query: {
      pins: explicitPins ? pins.map(fmtCookPin) : undefined,
      addressMatches: addressMatches.length ? addressMatches.map((m) => `${fmtCookPin(m.pin)} ${m.prop_address_full}, ${m.prop_address_city_name}`).slice(0, 10) : undefined,
      areaPinCount: !explicitPins && !args.address && pinScoped ? pins.length : undefined,
      township: tCode ? TOWNSHIP_NAME[tCode] : undefined,
      startDate,
      endDate,
      minPrice: args.minPrice,
      maxPrice: args.maxPrice,
      arms_length_filter: !args.includeFiltered && !explicitPins,
    },
    count: sales.length,
    sales,
    note: notes.join(" "),
  };
}
