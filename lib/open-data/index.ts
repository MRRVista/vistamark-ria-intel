/**
 * Open Data Portals family — the ESCAPE HATCH for any public dataset that no
 * dedicated VistaIntel family covers. All live, keyless (SOCRATA_APP_TOKEN optional).
 *
 *   socrata_catalog_search     — Socrata Discovery API across Chicago / Illinois / Cook County (or any Socrata domain)
 *   socrata_query              — generic SoQL query against any allowlisted government Socrata domain
 *   socrata_dataset_columns    — dataset metadata + column field names / types
 *   chicago_business_licenses  — City of Chicago business licenses (+ owners) by name / owner / address / zip / type
 *   chicago_building_permits   — City of Chicago building permits by address / contact / type / min cost
 *   il_open_data_presets       — 5 curated data.illinois.gov datasets (insurance producers, state pay, lobbying, tax revocations, Cook transfer forms)
 *   datagov_search             — data.gov federal/state/local catalog (new OpenSearch API; CKAN retired)
 *
 * DuPage County has no Socrata portal (data.dupageco.org does not exist). See README.md.
 */
import type { ToolDef } from "../mcp/tools";
import type { CatalogDomain } from "../mcp/catalog";
import { socrataCatalogSearch, socrataQuery, socrataDatasetColumns } from "./socrata";
import { chicagoBusinessLicenses, chicagoBuildingPermits } from "./chicago";
import { ilOpenDataPresets, IL_PRESETS } from "./illinois";
import { datagovSearch } from "./datagov";

export const OPENDATA_TOOLS: ToolDef[] = [
  {
    name: "socrata_catalog_search",
    description:
      "Find public datasets on Socrata open-data portals via the Socrata Discovery API (live, keyless). Default scope is Chicagoland government: data.cityofchicago.org, data.illinois.gov (indexed as illinois-edp.data.socrata.com) and datacatalog.cookcountyil.gov; pass `domains` for other portals (data.ny.gov, data.cdc.gov, publicreporting.cftc.gov, data.texas.gov …) or allDomains=true to search every Socrata portal in the US. Returns dataset 4x4 id, domain, name, trimmed description, attribution, column count/first field names, update frequency, last data update, downloads and permalink. This is the ESCAPE HATCH for any public dataset not covered by a dedicated family — use it first, then socrata_dataset_columns for exact field names and socrata_query for rows. DuPage County has no Socrata portal.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "keywords, e.g. 'business licenses', 'property tax exempt', 'lobbyist', 'salaries'" },
        domains: { type: "array", items: { type: "string" }, description: "Socrata hostnames to search (default Chicago + Illinois + Cook County)" },
        allDomains: { type: "boolean", default: false, description: "search every US Socrata portal (requires q)" },
        order: { type: "string", enum: ["relevance", "popularity", "updated"], default: "relevance" },
        category: { type: "string", description: "Socrata category filter, e.g. 'Buildings', 'Property Taxation'" },
        limit: { type: "number", default: 15, maximum: 25 },
      },
    },
    handler: socrataCatalogSearch,
  },
  {
    name: "socrata_query",
    description:
      "Run a SoQL query against ANY dataset on an allowlisted government Socrata portal (live, keyless; SOCRATA_APP_TOKEN optional for higher rate limits). Allowed hosts: any *.gov or *.us domain, *.cityofchicago.org, *.socrata.com, publicreporting.cftc.gov, data.cms.gov, data.ny.gov, data.sf.gov, data.cdc.gov. Args: domain + datasetId (4x4 like 'r5kz-chrr'), optional select (fields or aggregates like 'ward,count(*)'), where (SoQL: upper(name) like '%ACME%' AND amount > 1000000 AND date > '2026-01-01'), order ('date DESC'), group, q (full-text), columns (shorthand select), limit ≤ 100, offset. Returns rows (location/point objects flattened, long strings trimmed) plus the column names present. Get field names first with socrata_dataset_columns — a 400 means a bad field or SoQL. Use the dedicated tools (chicago_business_licenses, cook_parcel_sales, il_ptax_transfers, idfpr_licensee_search …) when they exist; this is the generic fallback for everything else, e.g. CFTC COT (publicreporting.cftc.gov 6dca-aqww), Cook County tax-exempt parcels (vgzx-68gb), Chicago business owners (ezma-pppn).",
    inputSchema: {
      type: "object",
      required: ["domain", "datasetId"],
      properties: {
        domain: { type: "string", description: "e.g. data.cityofchicago.org, data.illinois.gov, datacatalog.cookcountyil.gov, publicreporting.cftc.gov" },
        datasetId: { type: "string", description: "Socrata 4x4 dataset id" },
        select: { type: "string", description: "$select clause (fields, aggregates, aliases)" },
        where: { type: "string", description: "$where clause in SoQL" },
        order: { type: "string", description: "$order clause, e.g. 'issue_date DESC'" },
        group: { type: "string", description: "$group clause (with aggregates in select)" },
        q: { type: "string", description: "full-text search across all text columns" },
        columns: { type: "array", items: { type: "string" }, description: "field names to return (shorthand for select)" },
        limit: { type: "number", default: 25, maximum: 100 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: socrataQuery,
  },
  {
    name: "socrata_dataset_columns",
    description:
      "Dataset metadata and column dictionary for any Socrata dataset (live, keyless; <domain>/api/views/<id>.json, cached 6h). Returns name, description, category, attribution, last row update, update frequency, time period covered, download count, and every column's API field name, data type (text, number, calendar_date, checkbox, point/location) and description; `search` filters columns by keyword; stats=true adds distinct-count, non-null count and top values per column. Call this before socrata_query to get exact field names and to see which columns hold amounts, dates and names. Works for all allowlisted government domains (see socrata_query).",
    inputSchema: {
      type: "object",
      required: ["domain", "datasetId"],
      properties: {
        domain: { type: "string" },
        datasetId: { type: "string" },
        search: { type: "string", description: "keyword filter on column field/name/description, e.g. 'date', 'cost', 'owner'" },
        stats: { type: "boolean", default: false, description: "include cardinality / non-null / top values" },
        limit: { type: "number", default: 60, maximum: 150 },
      },
    },
    handler: socrataDatasetColumns,
  },
  {
    name: "chicago_business_licenses",
    description:
      "City of Chicago business licenses from the Chicago Data Portal (Socrata r5kz-chrr, 2002–present, ~1.2M rows, refreshed daily, keyless). Search by business `name` (legal or DBA), `owner` person name (joined through the Business Owners dataset ezma-pppn → account numbers), street `address`, 5-digit `zip`, `licenseType` (e.g. 'Retail Food', 'Limited Business', 'Tavern', 'Package Goods', 'Hotel', 'Pawnbroker', 'Day Care'), `neighborhood` (community area) or `accountNumber`; `startedAfter` (YYYY-MM-DD) finds new licenses (new-business signal). Default activeOnly=true keeps status AAI with an unexpired term. Returns license number, account, legal name, DBA, address, zip, community area, ward, license type/activity, start/expiry/issued dates, status; includeOwners=true adds owners/officers per account. Use for business-owner prospecting, verifying a prospect's Chicago operations, and who owns a venue; suburban/IL-wide businesses are not here (use idfpr_licensee_search or socrata_catalog_search).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "legal or DBA name fragment" },
        owner: { type: "string", description: "owner/officer name fragment (first, last or full)" },
        address: { type: "string", description: "street address fragment, e.g. '50 S LA SALLE'" },
        zip: { type: "string" },
        licenseType: { type: "string", description: "license description fragment" },
        neighborhood: { type: "string", description: "community area name, e.g. 'LINCOLN PARK', 'LOOP'" },
        accountNumber: { type: "number" },
        startedAfter: { type: "string", description: "YYYY-MM-DD license start floor" },
        activeOnly: { type: "boolean", default: true },
        includeOwners: { type: "boolean", default: false },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: chicagoBusinessLicenses,
  },
  {
    name: "chicago_building_permits",
    description:
      "City of Chicago building permits (Chicago Data Portal, Socrata ydr8-5enu, 2006–present, refreshed daily, keyless). Filter by `address` ('1060 W ADDISON' — number + direction + street), `street`, `contact` (owner / architect / contractor name across the first 3 contact slots), `zip` (contact zip, dataset has no site zip), `permitType` ('NEW CONSTRUCTION', 'RENOVATION/ALTERATION', 'WRECKING/DEMOLITION', 'EASY PERMIT', 'ELEVATOR', 'SIGNS'), `workType`, `minCost` (self-reported cost, USD), `ward`, `communityArea`, `issuedAfter`/`issuedBefore` (YYYY-MM-DD; type/cost-only scans default to the last 12 months), `q` (work-description text). orderBy 'cost' ranks by reported cost. Returns permit number, type, status, dates, address, reported cost, fee, ward, PINs, trimmed description and up to `contacts` (default 3) named parties with role/city/zip, plus total reported cost. High-cost residential renovations and new construction with an OWNER contact are a wealth signal; contractor/architect contacts are centers of influence. Chicago only — use socrata_catalog_search for other cities (e.g. Rockford 3k8p-pkx8 on data.illinois.gov).",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        street: { type: "string" },
        contact: { type: "string", description: "owner/architect/contractor name fragment" },
        zip: { type: "string" },
        permitType: { type: "string" },
        workType: { type: "string" },
        minCost: { type: "number", description: "minimum reported_cost in USD, e.g. 1000000" },
        ward: { type: "number" },
        communityArea: { type: "number" },
        issuedAfter: { type: "string" },
        issuedBefore: { type: "string" },
        q: { type: "string", description: "work description text fragment" },
        orderBy: { type: "string", enum: ["issued", "cost"], default: "issued" },
        contacts: { type: "number", default: 3, maximum: 6, description: "how many contact slots to return" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: chicagoBuildingPermits,
  },
  {
    name: "il_open_data_presets",
    description:
      `Curated data.illinois.gov datasets (Socrata, keyless) that no other family covers, each with safe pre-built SoQL. preset: ${IL_PRESETS.map((p) => `${p.id} (${p.name.split(" — ")[1] ?? p.name}; filters ${Object.keys(p.filters).join("/")})`).join("; ")}. Omit preset (or 'list') to see descriptions and freshness. Returns ≤ limit rows shaped per preset (names, amounts in USD, dates YYYY-MM-DD). Insurance producers is a 2024 snapshot; state pay is monthly; lobbying and Cook transfer forms are daily. For PTAX-203 sales use il_ptax_transfers; for IDFPR professional licenses use idfpr_licensee_search; for any other Illinois dataset use socrata_catalog_search + socrata_query (domain data.illinois.gov).`,
    inputSchema: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["list", ...IL_PRESETS.map((p) => p.id)] },
        name: { type: "string", description: "name fragment (producer / employee / business)" },
        firstName: { type: "string" },
        city: { type: "string" },
        zip: { type: "string", description: "5-digit ZIP" },
        state: { type: "string" },
        lineOfAuthority: { type: "string", description: "insurance_producers: Life, Health, Casualty, Fire, Variable Contracts, Personal Lines" },
        agency: { type: "string", description: "state_employee_pay agency fragment" },
        title: { type: "string", description: "state_employee_pay position title fragment" },
        minYtdGross: { type: "number", description: "state_employee_pay YTD gross floor (USD)" },
        client: { type: "string", description: "lobbying_clients client-name fragment" },
        entity: { type: "string", description: "lobbying_clients lobbyist-entity fragment" },
        year: { type: "string", description: "lobbying_clients registration year" },
        minConsideration: { type: "number", description: "cook_transfer_forms consideration floor (USD)" },
        township: { type: "string", description: "cook_transfer_forms township fragment, e.g. 'Lyons', 'New Trier'" },
        deedType: { type: "string" },
        declarationId: { type: "string" },
        deedAfter: { type: "string", description: "YYYY-MM-DD" },
        order: { type: "string", description: "override $order" },
        limit: { type: "number", default: 25, maximum: 100 },
      },
    },
    handler: ilOpenDataPresets,
  },
  {
    name: "datagov_search",
    description:
      "Search the data.gov catalog — ~300k federal, state, county, city and university datasets (live, keyless; catalog.data.gov's current OpenSearch API, the old CKAN package_search is retired). Args: q keywords; sort relevance | popularity | last_harvested_date; orgType filter (Federal Government, State Government, County Government, City Government, University); orgSlug (e.g. 'ed', 'treasury', 'austin-tx'); keyword tags; hasDownload=true; after cursor for paging; or slug to fetch one dataset's full distribution list. Search is AND-matched on all terms, so keep q to 2–3 words ('IRS zip code', not 'SOI tax stats zip code'); zero results means try fewer words. Returns title, organization + type, publisher, trimmed description, modified/harvested dates, keywords, landing page and resources (format + download/API URL). Use as the escape hatch for any public dataset not covered by a dedicated tool — then fetch the CSV/JSON resource URL, or if the resource is Socrata-hosted (…/api/views/<4x4>), query it with socrata_query. Metadata only: this tool does not download the data.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        slug: { type: "string", description: "dataset slug or id for a single-dataset lookup" },
        sort: { type: "string", enum: ["relevance", "popularity", "last_harvested_date"], default: "relevance" },
        orgType: { type: "array", items: { type: "string" }, description: "e.g. ['Federal Government']" },
        orgSlug: { type: "string" },
        publisher: { type: "string" },
        keyword: { type: "array", items: { type: "string" } },
        hasDownload: { type: "boolean" },
        after: { type: "string", description: "paging cursor from a previous nextCursor" },
        maxResources: { type: "number", default: 4, maximum: 12 },
        limit: { type: "number", default: 10, maximum: 25 },
      },
    },
    handler: datagovSearch,
  },
];

export const OPENDATA_DOMAIN: CatalogDomain = {
  id: "opendata",
  label: "Open Data Portals (Socrata catalog/query · data.gov · Chicago · Illinois · Cook/DuPage)",
  source:
    "Socrata Discovery API + SODA (data.cityofchicago.org, data.illinois.gov, datacatalog.cookcountyil.gov and any *.gov/*.us Socrata host) and the data.gov OpenSearch catalog — all live, keyless (SOCRATA_APP_TOKEN optional), cached in-memory 2–6h for metadata. DuPage County has no Socrata portal.",
  tools: [
    { name: "socrata_catalog_search", backing: "live-api", probe: "unprobed", note: "api.us.socrata.com Discovery API; default domains Chicago + IL + Cook" },
    { name: "socrata_query", backing: "live-api", probe: "unprobed", note: "generic SoQL; government-domain allowlist; limit ≤ 100" },
    { name: "socrata_dataset_columns", backing: "live-api", probe: "unprobed", note: "/api/views/<id>.json, cached 6h" },
    { name: "chicago_business_licenses", backing: "live-api", probe: "unprobed", note: "r5kz-chrr + owners ezma-pppn, daily" },
    { name: "chicago_building_permits", backing: "live-api", probe: "unprobed", note: "ydr8-5enu, daily; reported_cost wealth signal" },
    { name: "il_open_data_presets", backing: "live-api", probe: "unprobed", note: "5 curated data.illinois.gov datasets" },
    { name: "datagov_search", backing: "live-api", probe: "unprobed", note: "catalog.data.gov/search (OpenSearch); CKAN API retired" },
  ],
};

export const OPENDATA_CHECKS: Array<{ name: string; tool: string; args: any; note?: string }> = [
  { name: "opendata: Socrata catalog 'business licenses' (Chicago)", tool: "socrata_catalog_search", args: { q: "business licenses", domains: ["data.cityofchicago.org"], limit: 3 }, note: "expect r5kz-chrr first" },
  { name: "opendata: Chicago permits ≥ $5M (last 12m)", tool: "chicago_building_permits", args: { minCost: 5000000, limit: 3, contacts: 2 }, note: "defaults to last 12 months; expect NEW CONSTRUCTION / RENOVATION rows with OWNER contacts" },
  { name: "opendata: data.gov search 'college scorecard'", tool: "datagov_search", args: { q: "college scorecard", orgType: ["Federal"], limit: 2 }, note: "expect Department of Education dataset with ZIP/XLSX resources" },
];
