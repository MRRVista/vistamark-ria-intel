# Open Data Portals family (`lib/open-data/`)

Catalog id `opendata`. The escape hatch for any public dataset without a dedicated VistaIntel family: discover it (Socrata Discovery API or data.gov), read its column dictionary, then query it with SoQL — plus dedicated Chicago licenses / permits tools and five curated Illinois presets.

All sources are live and keyless. `SOCRATA_APP_TOKEN` (already an env name in the repo, optional) is sent as `X-App-Token` on every Socrata request when present and only raises the throttling ceiling. No new env vars.

| Tool | Source | Verified |
|---|---|---|
| `socrata_catalog_search` | `GET https://api.us.socrata.com/api/catalog/v1?q=&domains=&only=datasets&limit=&order=` | 2026-10-22 |
| `socrata_query` | `GET https://<domain>/resource/<4x4>.json?$select&$where&$order&$group&$limit&$offset&$q` | 2026-10-22 |
| `socrata_dataset_columns` | `GET https://<domain>/api/views/<4x4>.json` | 2026-10-22 |
| `chicago_business_licenses` | data.cityofchicago.org `r5kz-chrr` (+ owners `ezma-pppn`) | 2026-10-22 |
| `chicago_building_permits` | data.cityofchicago.org `ydr8-5enu` | 2026-10-22 |
| `il_open_data_presets` | data.illinois.gov `serf-cewv`, `iu6r-a89d`, `2hsr-n93j`, `yrzn-vwcw`, `vbnw-q5s8` | 2026-10-22 |
| `datagov_search` | `GET https://catalog.data.gov/search?q=&per_page=&sort=&org_type=…` and `GET https://catalog.data.gov/api/dataset/<slug>` | 2026-10-22 |

Shared code: `common.ts` (domain allowlist, SODA/metadata fetch with readable Socrata errors, row compaction). It re-exports `soqlStr`/`soqlLike`/`num`/`str`/`clampLimit`/`strList` from `lib/local-wealth/socrata.ts` and `cached()` from `lib/research/common.ts` — nothing outside this folder was edited.

## Socrata Discovery API

- Keyless, fast (<1 s). `only=datasets` excludes charts/maps/filtered views. Supported `order` values: `relevance`, `page_views_total`, `updatedAt` (`data_updated_at` is rejected with 400 — the tool maps `updated` → `updatedAt`).
- **data.illinois.gov is a vanity CNAME for `illinois-edp.data.socrata.com`.** The Discovery index only knows the canonical name: `domains=data.illinois.gov` returns 0 results; the tool rewrites it (`DOMAIN_ALIASES`). Both hosts serve `/resource` and `/api/views` identically, so `socrata_query` accepts either. `search_context=data.illinois.gov` also works but is not needed.
- **DuPage County has no Socrata portal.** `data.dupageco.org` does not resolve (DNS) and the Discovery API answers `{"error":"Domain not found: data.dupageco.org"}`. `dupage.data.socrata.com` resolves but returns 404. DuPage parcel data continues to come from the DuPage GIS path in `lib/local-wealth` (`dupage_parcel_sales`). The family label keeps "Cook/DuPage" as requested; the DuPage half is served by data.illinois.gov PTAX-203 filings.
- `data.sfgov.org` 301-redirects to `data.sf.gov` (both allowlisted). `data.cms.gov` is **not** Socrata any more (its `/api/views` 404s; it has its own `data-api/v1`), kept on the allowlist only because the brief asked. `opendata.utah.gov` is decommissioned.
- Default domains: `data.cityofchicago.org`, `illinois-edp.data.socrata.com`, `datacatalog.cookcountyil.gov`. Cached 2 h.

## `socrata_query` allowlist and injection posture

Allowed hosts: exact `datacatalog.cookcountyil.gov`, `publicreporting.cftc.gov`, `data.cms.gov`, `data.ny.gov`, `data.sf.gov`/`data.sfgov.org`, `data.cdc.gov`, `data.illinois.gov`, `illinois-edp.data.socrata.com`; suffixes `*.cityofchicago.org`, `*.socrata.com`, `*.gov`, `*.us`. Scheme/path are stripped; anything else throws before any network call. Dataset ids must match `^[a-z0-9]{4}-[a-z0-9]{4}$`.

SoQL clauses are passed through as `$select/$where/$order/$group/$q` query parameters — Socrata parses them server-side and the datasets are read-only public tables, so there is no write surface. The dedicated tools (`chicago_*`, `il_open_data_presets`) build SoQL themselves with `soqlStr`/`soqlLike` escaping. `limit` is clamped to 100 (default 25); rows are compacted (point/location objects → `{lat,lon}`, strings cut at 240 chars) to stay under the 6 000-char tool budget — a 100-row query on a wide dataset can still exceed it, so the description tells the model to use `columns`.

Socrata 400s are rewritten into a one-line message (`No such column: tax_year`) without the echoed full SELECT list; 404 / 403 / 429 get hints.

## Chicago Data Portal

- `r5kz-chrr` Business Licenses: ~1.21 M rows, 37 columns, updated daily (`rowsUpdatedAt` 2026-10-22). `license_status` distribution: AAI 1,129,322 (issued), AAC 78,988 (cancelled), REV 1,469, REA 13, INQ 1. "Active" = `license_status='AAI' AND expiration_date >= today` (AAI alone includes expired historical licenses). Name search uses `upper(x) like '%X%'` on legal_name + DBA (0.5–3 s; one cold 14 s outlier seen in testing). Owner search queries `ezma-pppn` Business Owners (account_number → owner names/titles) first, then `account_number in (...)` on licenses (≤100 accounts).
- `ydr8-5enu` Building Permits: 122 columns, 2006–present, daily. `reported_cost` is applicant-reported; up to 15 contact slots (type/name/city/state/zip — `OWNER`, `ARCHITECT`, `CONTRACTOR-GENERAL CONTRACTOR`, `EXPEDITOR`, `ELECTRICAL CONTRACTOR` …). **There is no site ZIP column** — `zip` filters contact_1/contact_2 zips. Address parsing: `1060 W ADDISON` → `street_number=1060 AND street_direction='W' AND street_name like '%ADDISON%'`. Type/cost-only scans default to the last 12 months. 802 permits ≥ $1 M were issued in 2026 YTD at verification time.

## Illinois presets (data.illinois.gov)

The State portal has ~300 datasets, mostly IDPH health tables and FY disbursement spreadsheets. After a full listing, the finance-relevant ones not already served elsewhere are:

| preset | id | note |
|---|---|---|
| `insurance_producers` | `serf-cewv` | DOI insurance producers by ZIP / line of authority. **Snapshot dated 2024-06-13, not refreshed** — flagged in output. count(*) timed out once at 25 s (large table); filtered queries take 1–4 s. |
| `state_employee_pay` | `iu6r-a89d` | 103,780 current State employees with YTD gross; refreshed ~monthly. |
| `lobbying_clients` | `2hsr-n93j` | SoS lobbying entities × clients, 5 years, daily. |
| `sales_tax_revocations` | `yrzn-vwcw` | IDOR revoked sales/use tax certificates, monthly; distress flag. |
| `cook_transfer_forms` | `vbnw-q5s8` | 2.96 M Cook/Chicago transfer-declaration forms (consideration, mortgage, deed type, township) keyed by `declaration_id` → join to `it54-y4c6` (`il_ptax_transfers`) for address. Daily. |

Not included: PTAX-203 (`it54-y4c6`) and IDFPR (`pzzh-kp68`) — already in `lib/local-wealth`. IDOR property-tax statistics, ISBE and IL Comptroller local-government finance data are **not on the Socrata portal** (Comptroller publishes via its own warehouse, ISBE via static files). Illinois Treasurer unclaimed property (ICash) is not Socrata either.

## data.gov

The CKAN endpoint from the brief (`/api/3/action/package_search`) — and every `/api/3/*` path — returns **404** as of 2026-10-22; `catalog.data.gov` is now a custom OpenSearch service with an OpenAPI spec at `https://catalog.data.gov/openapi.json`. Working endpoints:

- `GET /search?q=&per_page=(1..1000)&sort=relevance|popularity|last_harvested_date&org_type=&org_slug=&publisher=&keyword=&theme=&has_download=&after=` → `{after, results[], sort}`; each result has `slug,title,description,organization{name,organization_type,slug},publisher,keyword[],theme[],last_harvested_date,popularity,dcat{modified,distribution[{title,format,mediaType,downloadURL}],landingPage,…}`.
- `GET /api/dataset/<slug_or_id>` → `{total, results[1]}`.
- `Accept: application/json` is required (HTML otherwise). Keyless, no observed rate limiting, 100–350 ms. `q` is AND-matched on every term, so "SOI tax stats zip code" returns nothing while "IRS zip code" finds *Individuals, ZIP Code Data* — the description tells the model to keep queries short. There is no result total in the search response; paging is by the `after` cursor (surfaced as `nextCursor`).

## Could not verify from the sandbox

- Behaviour with `SOCRATA_APP_TOKEN` set (none configured here); anonymous requests never 429'd during testing.
- `data.cms.gov` / `data.ny.gov` / `data.cdc.gov` were only probed for reachability (`/api/views.json` 200 for NY and CDC), not queried through the tools.
- Whether data.gov's OpenSearch API will keep the `/search` JSON contract stable — it is undocumented beyond `openapi.json`.

Smoke script: `/tmp/claude-0/-home-claude/b833aeaa-ec20-51c6-be5f-ea01232783a0/scratchpad/builders/open-data-smoke.ts` (25 calls incl. the 3 CHECKS, all passing; every result < 3.3 k chars).
