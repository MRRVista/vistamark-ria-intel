# Physicians & Health Economy family (`lib/health-pro/`)

Catalog id `healthpro`. Five live, keyless tools over CMS public data. Purpose: physicians are a
dense HNW cohort (Hinsdale 60521 alone has ~550 IDFPR-licensed physicians, see `lib/local-wealth`);
this family supplies the canonical national professional record (NPPES), industry payments
(Open Payments) and Medicare billing scale (utilization) as prominence / wealth signals, plus
the hospital landscape. **Professional data only**: practice (LOCATION) addresses are returned,
NPPES MAILING addresses are dropped (except business-looking ones on an `nppes_lookup`).

| Tool | Source | Cold latency (sandbox, 2026-10-22) |
|---|---|---|
| `nppes_search` | NPI Registry API v2.1 | 0.2–0.7 s |
| `nppes_lookup` | NPI Registry API v2.1 | < 0.1 s |
| `cms_open_payments` | openpaymentsdata.cms.gov DKAN datastore | 1.5–4 s by NPI/name; **20–60 s** ZIP ranking |
| `cms_medicare_provider_utilization` | data.cms.gov data-api | 0.4–4 s |
| `cms_hospital_general_info` | data.cms.gov/provider-data DKAN datastore | ~2 s |

All endpoints below were called live from the sandbox through the agent proxy with the Vistamark
User-Agent via `politeFetch`/`jsonFetch`. No env vars introduced.

## 1. NPPES NPI Registry — `nppes_search`, `nppes_lookup`

- Endpoint: `https://npiregistry.cms.hhs.gov/api/?version=2.1&<criteria>` (JSON, keyless).
  Verified: `postal_code=60521&limit=200&skip=1200`, `number=1003074519`,
  `postal_code=60521*&taxonomy_description=Orthopaedic Surgery&enumeration_type=NPI-1`.
- Params used: `number`, `first_name`, `last_name`, `organization_name`, `taxonomy_description`,
  `city`, `state`, `postal_code`, `enumeration_type`, `use_first_name_alias`, `limit` (≤200),
  `skip` (≤1000). Trailing `*` wildcard allowed after ≥2 chars in names and postal codes.
- Quirks: errors are HTTP 200 with `{"Errors":[...]}` (we throw). `state` cannot be the only
  criterion. Hard cap 1,200 rows per criteria set (skip ≤ 1000). Updated weekly. No documented
  rate limit; we cache 6 h per query string.
- Output trimming: search rows ~250 chars (`fields="brief"` ~100 chars, up to 45/call; standard max 16);
  default 12 rows. `nppes_lookup` adds all taxonomies + license numbers, other identifiers,
  Direct-messaging endpoints (`affiliationHint` = endpoint domain, often the employing group,
  e.g. `dulyhealthandcare.direct-ci.com`).

## 2. CMS Open Payments — `cms_open_payments`

- Site is DKAN 2. **Working** endpoints from the sandbox:
  - Metastore: `GET https://openpaymentsdata.cms.gov/api/1/metastore/schemas/dataset/items`
    (200; used once by hand to pin dataset ids — not called at runtime).
  - Search: `GET /api/1/search?fulltext=General%20Payments` (200).
  - Datastore query: `GET /api/1/datastore/query/{datasetId}/0?conditions[0][property]=covered_recipient_npi&conditions[0][value]=…&conditions[0][operator]==&properties[]=…&limit=500&schema=false&count=false`
    (200). GROUP BY aggregates work with the `{resource:"t",property}` form plus
    `properties[i][expression][operator]=sum|count`, `groupings[i]`, `sorts[i]`.
  - **Not working**: `/api/1/datastore/sql?query=[SELECT …]` → 400 "Invalid query string" for
    every form tried (bracketed and plain). Not used. The brief's earlier 403 on `/api/1/metastore`
    did not reproduce with the Vistamark UA.
- Dataset ids (metastore identifiers, `modified` 2026-06-30): General Payment Data PY2019
  `4e54dd6c-…`, 2020 `a08c4b30-…`, 2021 `0380bbeb-…`, 2022 `df01c2f8-…`, 2023 `fb3a65aa-…`,
  2024 `e6b17c6a-2534-4207-a4a1-6746a14911ff`, 2025 `fb0b1734-1410-429d-92f6-3f4b35218e5e`;
  Covered Recipient Profile Supplement `23160558-6742-54ff-8b9f-cac7d514ff4e` (full ids in
  `open-payments.ts`). CMS refreshes each June (new PY) and January (corrections) — bump
  `GENERAL_PAYMENTS` / `LATEST_PROGRAM_YEAR` then.
- Limits/quirks: `limit` ≤ 500 (JSON-schema 400 above). `count=true` forces a COUNT(*) on a
  ~14M-row table — avoided. Filtering by NPI is indexed (1–2 s, aggregates ~2 s); filtering by
  `recipient_zip_code` or by last name alone is a full scan (ZIP group-by 30–58 s observed;
  name+state LIKE 35 s). So name resolution goes through the small Profile Supplement
  (3 s), and ZIP ranking is cached 24 h with a 58 s timeout and is labelled slow in the
  description. If the lambda budget is tight, call it once to warm the cache.
- Modes: `npi` (per-year totals, by nature, top manufacturers, products, largest 5 lines; >500
  lines falls back to server aggregates), `last_name`+`state` (+first_name/city → candidates or
  auto-resolve), `zip` (rank). Ownership/research payment datasets are not wired (ids listed in
  the metastore if wanted later: 2024 Ownership `9ac4f7f8-b6e4-4d80-8410-4aba7e71dd02`).

## 3. Medicare Physician & Other Practitioners — `cms_medicare_provider_utilization`

- Catalog: `https://data.cms.gov/data.json` (17.9 MB; parsed once by hand). Yearly dataset ids
  pinned in `medicare.ts` (`BY_PROVIDER` 2019–2024, `BY_PROVIDER_SERVICE` 2021–2024).
  2024 vintage: by Provider `8889d81e-2ee7-448f-8713-f071038289b5`, by Provider & Service
  `92396110-2aed-4d63-a6a2-5d6207d46a29` (released 2026-05-21). New vintages appear each spring
  — add the id from data.json.
- Endpoint: `https://data.cms.gov/data-api/v1/dataset/{id}/data?filter[Rndrng_NPI]=…&size=…&offset=…&sort=-Tot_Mdcr_Pymt_Amt&column=A,B,C`;
  `…/data/stats?filter[…]` → `{found_rows,total_rows}`. Complex filters:
  `filter[x][condition][path]=Rndrng_Prvdr_Type&filter[x][condition][operator]=CONTAINS&filter[x][condition][value]=Orthopedic`
  (also `STARTS_WITH`). Keyless, JSON array; no documented rate limit; cached 6–24 h.
- Verified: zip 60521 → 416 providers, top = Paramjit Chopra M.D. (Interventional Radiology,
  $5.0M Medicare paid 2024); NPI trend 2022–2024; state+provider_type sort; last-name
  STARTS_WITH; empty NPI → `[]` (returns `found:false` with suppression note).
- Caveats: Part B FFS only (no Medicare Advantage / commercial / facility); providers with ≤10
  beneficiaries suppressed; `Rndrng_Prvdr_Type` uses CMS specialty names ("Orthopedic Surgery",
  not NPPES "Orthopaedic Surgery").

## 4. Hospital General Information — `cms_hospital_general_info`

- Endpoint: `https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?conditions[0][property]=zip_code&conditions[0][value]=60521&…`
  (DKAN, keyless, 200). Supports `like` (`605%`, `%ADVENTHEALTH%`), `count=true` is cheap
  (~5.4k rows). Verified: zip 60521 → UChicago Medicine AdventHealth Hinsdale (CCN 140122,
  5-star, voluntary non-profit); IL + ownership~Physician → Ingalls Memorial; zip_prefix 605.
- Quirk: `hospital_overall_rating` is text ("Not Available"), so `min_rating` filters
  client-side after an over-fetch. The provider-data metastore item endpoint returned no
  `modified` date; Care Compare refreshes quarterly.

## Self-test probes (`HEALTHPRO_CHECKS`)
1. `nppes_search` orthopaedic surgeons in 60521 (~0.7 s)
2. `cms_medicare_provider_utilization` top billers in 60521 (~3.6 s cold, two requests)
3. `cms_hospital_general_info` zip 60521 (~2 s)

## Not verified / known gaps
- Open Payments ZIP-ranking latency from Vercel's egress is unmeasured; the sandbox saw 29–58 s.
- Rate limits for all four hosts are undocumented; none throttled during ~60 smoke calls.
- Open Payments Research/Ownership payment files and the NPPES monthly bulk file are not wired.
