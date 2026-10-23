/**
 * Housing Markets family — market-level price, rent and inventory indices for
 * the places where prospects live (Hinsdale 60521, DuPage/Cook, Chicago metro,
 * Illinois, US). Complements lib/local-wealth, which has parcel-level SALES.
 *
 *   zillow_zhvi           — Zillow Home Value Index by zip/city/county/metro/state, mid/top/bottom tier, SFR/condo/4br/5br
 *   zillow_dataset        — any other Zillow Research file: ZORI rents, inventory, new listings, median sale/list price,
 *                           days to pending, price-cut share, sale-to-list, market heat, affordability, ZHVF forecast
 *   fhfa_hpi              — FHFA House Price Index (USA / Census division / state / MSA from the master CSV; ZIP5/ZIP3 annual)
 *   realtor_inventory     — Realtor.com monthly listing metrics by zip/county/metro/state (latest + trailing months)
 *   hud_fair_market_rents — HUD FMR by county / metro / state (HUD_API_KEY)
 *   hud_usps_crosswalk    — HUD-USPS ZIP <-> county / tract / CBSA crosswalk (HUD_API_KEY)
 *
 * All Zillow / FHFA / Realtor.com sources are keyless public CSV/XLSX files that are
 * streamed and filtered (never fully buffered when > 20 MB) and cached 12–24 h.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { zillowZhvi, zillowDataset, ZILLOW_DATASETS } from "./zillow";
import { fhfaHpi } from "./fhfa";
import { realtorInventory } from "./realtor";
import { hudFairMarketRents, hudUspsCrosswalk } from "./hud";

const placeProps = {
  zip: { type: "string", description: "5-digit ZIP, e.g. 60521 (implies geography zip)." },
  name: { type: "string", description: "Place name: city ('Hinsdale'), county ('DuPage County'), metro ('Chicago' or 'Chicago, IL'), state ('Illinois'). Case-insensitive; prefix matches allowed." },
  state: { type: "string", description: "2-letter state to disambiguate names (IL)." },
  regionId: { type: "string", description: "Zillow RegionID for an exact match (returned in results)." },
  months: { type: "number", default: 24, maximum: 120, description: "Trailing monthly rows to return (0 = none)." },
  limit: { type: "number", default: 5, maximum: 25, description: "Max matching regions (e.g. all zips of a city)." },
};

export const HOUSING_TOOLS: ToolDef[] = [
  {
    name: "zillow_zhvi",
    description:
      "Zillow Home Value Index (ZHVI): the typical home value for a ZIP, city, county, metro or state from Zillow Research's public CSVs (keyless; monthly since 2000, refreshed mid-month for the prior month, smoothed and seasonally adjusted). tier: mid (35th–65th percentile, default), top (65th–95th — use this for affluent markets like Hinsdale/Oak Brook/Winnetka where the mid tier understates the housing stock) or bottom; homeType: all (default), sfr, condo, 4br, 5br. Returns, per matched region, the latest value in whole dollars, 1m/3m/12m/3y/5y/10y percent changes and CAGRs, the all-time peak with current drawdown, and the last N months, plus the US national line for comparison. Geography: zip (pass zip, or a city name to list all its zips), city, county, metro ('Chicago'), state. The ZIP/city files are ~125 MB and are streamed+filtered on a cold call (~3–6 s); results are cached 12 h. Use this for 'what are homes worth in 60521 / how much has Hinsdale appreciated'; for rents, inventory, sale prices, days-on-market or forecasts use zillow_dataset; for recorded individual sales use cook_parcel_sales / dupage_parcel_sales; for the official repeat-sales index use fhfa_hpi.",
    inputSchema: {
      type: "object",
      properties: {
        geography: { type: "string", enum: ["zip", "city", "county", "metro", "state", "neighborhood"], description: "Defaults to zip when zip is given, else metro." },
        tier: { type: "string", enum: ["mid", "top", "bottom"], default: "mid" },
        homeType: { type: "string", enum: ["all", "sfr", "condo", "4br", "5br"], default: "all" },
        includeNational: { type: "boolean", default: true },
        ...placeProps,
      },
    },
    handler: zillowZhvi,
  },
  {
    name: "zillow_dataset",
    description:
      "Any other Zillow Research public dataset (keyless CSVs, monthly, refreshed mid-month) for a ZIP, county, metro (or city for rents): zori (observed asking rent, since 2015), inventory (active for-sale listings), new_listings, new_pending, median_sale_price, median_list_price, sales_count, days_to_pending_median/mean, pct_listings_price_cut, mean_price_cut_pct, sale_to_list, pct_sold_above_list, market_heat (Zillow Market Heat Index), income_needed / affordability / monthly_payment (20% down, mid-tier home), new_construction_median_price, and zhvf_growth (Zillow's 1/3/12-month home-value forecast). Call with list:true (or no dataset) to see every key with its available geographies — the list is what has been verified live. Returns per region: latest value, trailing percent changes, peak/drawdown and the last N months; dollars are whole dollars, shares in percent. Coverage below metro level depends on listing volume (60521 has inventory, new listings, list price, days-to-pending, price cuts, market heat and the forecast; ZORI rents and sale prices for Hinsdale need geography county 'DuPage' or metro — ZORI zips/cities exist only for larger rental markets such as Naperville). Use zillow_zhvi for home values by tier; realtor_inventory for Realtor.com's listing counts, days on market and price-reduced share with month-over-month/year-over-year deltas.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", enum: ZILLOW_DATASETS.map((d) => d.key), description: "Dataset key (see list:true)." },
        geography: { type: "string", enum: ["zip", "city", "county", "metro", "state", "neighborhood"], description: "Must be one the dataset publishes; defaults to zip when zip given, else metro." },
        list: { type: "boolean", description: "List datasets and their geographies instead of fetching." },
        ...placeProps,
      },
    },
    handler: zillowDataset,
  },
  {
    name: "fhfa_hpi",
    description:
      "FHFA House Price Index (official repeat-sales index on Fannie/Freddie mortgages; keyless; from fhfa.gov's master CSV, refreshed with each monthly release ~2 months after period end). level: USA or census division (monthly purchase-only, SA/NSA), state (quarterly), msa (quarterly; Chicago is 'Chicago-Naperville-Schaumburg, IL (MSAD)' id 16984), or zip5 / zip3 (experimental ANNUAL all-transactions index, updated each March — e.g. place '60521'). flavor: purchase-only (default where available), all-transactions (adds refi appraisals; longest history, 1975+/1980+), expanded-data (adds FHA + county recorder). Returns latest index level, YoY, 1/3/5/10-year percent changes and CAGRs, peak and drawdown, available flavors, and the last N periods. listPlaces:true lists matching places/series. Use for 'how has Illinois / Chicago metro appreciated vs the US' and long-history cycles; FHFA is an index (not dollars) — use zillow_zhvi for dollar values and tiers, and note FHFA excludes jumbo-only markets' cash/non-GSE sales so very affluent ZIPs are thin.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["USA", "division", "state", "msa", "zip5", "zip3", "all"], description: "Default USA when place is empty; otherwise searched across levels." },
        place: { type: "string", description: "Place name, state code (IL), CBSA code (16984), census division ('East North Central'), or ZIP (60521 / 605)." },
        flavor: { type: "string", enum: ["purchase-only", "all-transactions", "expanded-data"] },
        frequency: { type: "string", enum: ["monthly", "quarterly"] },
        seasonallyAdjusted: { type: "boolean", default: true, description: "Use the SA column when published (purchase-only only)." },
        periods: { type: "number", default: 24, maximum: 240, description: "Recent periods to return." },
        limit: { type: "number", default: 3, maximum: 10, description: "Max matching places." },
        listPlaces: { type: "boolean" },
      },
    },
    handler: fhfaHpi,
  },
  {
    name: "realtor_inventory",
    description:
      "Realtor.com Research monthly housing inventory metrics (keyless CSVs from Realtor.com's econdata S3 bucket; monthly since Jul-2016, published ~1 week after month end) for a ZIP (60521), county (name+state or FIPS 17043), metro (CBSA 16980 / 'Chicago') or state: median and average listing price, median $/sq ft, active / new / pending / total listing counts, median days on market, price-reduced count and share, price-increased share, and pending ratio, each with Realtor.com's own month-over-month and year-over-year percent changes, plus a trailing-N-month trend table and trailing averages (months default 13; 1 = latest-month file only, fastest). Dollars are whole dollars, shares in percent; quality_flag 1 marks thin samples. The ZIP history file is 837 MB sorted newest-first, so a 13-month ZIP query streams ~180 MB in ~6 s cold and is cached 12 h; county/metro are fast. Use this for listing-market tightness (inventory, DOM, price cuts) in a prospect's town; zillow_dataset has Zillow's versions of similar metrics and rents; cook_parcel_sales / dupage_parcel_sales have closed sales.",
    inputSchema: {
      type: "object",
      properties: {
        geography: { type: "string", enum: ["zip", "county", "metro", "state"], description: "Inferred from zip / fips / cbsa / name when omitted." },
        zip: { type: "string", description: "5-digit ZIP." },
        fips: { type: "string", description: "5-digit county FIPS (DuPage 17043, Cook 17031)." },
        cbsa: { type: "string", description: "Metro CBSA code (Chicago 16980)." },
        name: { type: "string", description: "County ('DuPage'), metro ('Chicago') or city-for-zips name." },
        state: { type: "string", description: "2-letter state (IL) to disambiguate county/zip names; or the state itself for geography state." },
        months: { type: "number", default: 13, maximum: 60, description: "Trailing months (zip max 25)." },
        metrics: { type: "array", items: { type: "string" }, description: "Subset of: median_listing_price, active_listing_count, new_listing_count, pending_listing_count, total_listing_count, median_days_on_market, price_reduced_count, price_reduced_share, price_increased_share, pending_ratio, median_listing_price_per_square_foot, median_square_feet, average_listing_price. First 6 go in the trend table." },
        limit: { type: "number", default: 5, maximum: 25 },
      },
    },
    handler: realtorInventory,
  },
  {
    name: "hud_fair_market_rents",
    description:
      "HUD Fair Market Rents (FMR) — HUD's annual 40th-percentile gross rent by bedroom count (studio to 4BR) for a county (countyFips 17043 or county+state), metro (cbsa 16980), HUD entityId, or a whole state (state alone), for a fiscal year (default latest). Small Area FMR metros (incl. Chicago) return per-ZIP rents. Also list:'counties' (with state) or list:'metros' to find entity ids. Keyed: HUD_API_KEY (free token from huduser.gov) — fails immediately with a clear error when unset. Dollars per month, whole dollars. Use for rental-market and Section-8 payment-standard context; for market asking rents use zillow_dataset zori.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "HUD entity id, e.g. 1704399999 (DuPage) or METRO16980M16980." },
        countyFips: { type: "string", description: "5-digit county FIPS; expanded to the 10-digit HUD id." },
        cbsa: { type: "string", description: "CBSA code; expanded to METRO<cbsa>M<cbsa>." },
        county: { type: "string", description: "County name (with state) to resolve via listCounties." },
        state: { type: "string", description: "2-letter state. Alone = whole-state table." },
        year: { type: "number", description: "FMR fiscal year, e.g. 2026." },
        list: { type: "string", enum: ["counties", "metros"] },
        limit: { type: "number", default: 50, maximum: 200 },
      },
    },
    handler: hudFairMarketRents,
  },
  {
    name: "hud_usps_crosswalk",
    description:
      "HUD-USPS ZIP Code Crosswalk — maps a ZIP to the counties / census tracts / CBSAs / congressional districts it overlaps (and the reverse), with the share of residential, business and total addresses in each (percent). Default type zip-county. Quarterly vintages (year/quarter optional). Keyed: HUD_API_KEY — fails fast when unset. Use to resolve a prospect's ZIP (e.g. 60521 straddles DuPage and Cook) to the right county FIPS before calling county-level tools.",
    inputSchema: {
      type: "object",
      properties: {
        zip: { type: "string", description: "Source ZIP for zip->X types." },
        type: { type: "string", description: "1-12 or zip-tract | zip-county (default) | zip-cbsa | zip-cbsadiv | zip-cd | tract-zip | county-zip | cbsa-zip | cbsadiv-zip | cd-zip | zip-countysub | countysub-zip" },
        query: { type: "string", description: "Source id for reverse types (county FIPS 17043, tract GEOID, CBSA 16980)." },
        year: { type: "number" },
        quarter: { type: "number" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: hudUspsCrosswalk,
  },
];

export const HOUSING_DOMAIN: CatalogDomain = {
  id: "housing",
  label: "Housing Markets (Zillow ZHVI · FHFA HPI · Realtor.com inventory)",
  source:
    "Zillow Research public CSVs (files.zillowstatic.com), FHFA HPI master CSV + ZIP workbooks (fhfa.gov), Realtor.com Research inventory CSVs (econdata S3, HTTPS), HUD User FMR + USPS crosswalk API (HUD_API_KEY) — live, streamed + filtered, cached 12–24h",
  tools: [
    { name: "zillow_zhvi", backing: "live-api", probe: "unprobed", note: "ZIP/city files ~125 MB streamed per query (~3–6 s cold), cached 12h; county/metro/state parsed once" },
    { name: "zillow_dataset", backing: "live-api", probe: "unprobed", note: "34 verified file keys (ZORI, inventory, sale/list price, DOM, price cuts, heat index, affordability, forecast)" },
    { name: "fhfa_hpi", backing: "live-api", probe: "unprobed", note: "17 MB master CSV parsed once (12h); ZIP5 annual via streamed 40 MB xlsx per zip" },
    { name: "realtor_inventory", backing: "live-api", probe: "unprobed", note: "HTTPS S3 endpoint (documented http host is unreachable from the proxy); history newest-first so streams cancel early" },
    { name: "hud_fair_market_rents", backing: "live-api", probe: "unprobed", note: "HUD_API_KEY required; response shapes per docs, not live-verified (no key in sandbox)" },
    { name: "hud_usps_crosswalk", backing: "live-api", probe: "unprobed", note: "HUD_API_KEY required; same caveat" },
  ],
};

export const HOUSING_CHECKS: Array<{ name: string; tool: string; args: Record<string, unknown>; note?: string }> = [
  { name: "zillow_zhvi metro Chicago", tool: "zillow_zhvi", args: { geography: "metro", name: "Chicago", months: 3, includeNational: false }, note: "4.5 MB metro file" },
  { name: "fhfa_hpi USA monthly", tool: "fhfa_hpi", args: { level: "USA", place: "United States", periods: 3 }, note: "17 MB master CSV, ~2.5 s cold" },
  { name: "realtor_inventory DuPage latest", tool: "realtor_inventory", args: { fips: "17043", months: 1 }, note: "0.9 MB latest-month county file" },
  { name: "hud_fair_market_rents keyless error", tool: "hud_fair_market_rents", args: { countyFips: "17043" }, note: "Expected to fail fast with 'HUD_API_KEY not configured' when the key is absent" },
];
