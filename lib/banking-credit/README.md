# Mortgage, Credit Unions & Consumer Finance (`bankcredit`)

Seven keyless, live tools over three federal sources. Use cases: jumbo-mortgage
lender share in DuPage / Hinsdale (who affluent households borrow from), credit-union
competitors around 60521, and reputational screens on custodians, banks and servicers.
FDIC BankFind lives in `lib/fdic` and is not duplicated here.

| Tool | Source | Cold latency | Cache |
|---|---|---|---|
| `hmda_aggregations` | HMDA Data Browser `/view/aggregations` | 0.3–1 s | 12 h |
| `hmda_jumbo_lenders` | HMDA Data Browser `/view/csv` (streamed) + `/view/filers` | 1–3 s DuPage (6 MB), ~2–4 s Cook (28 MB) | 24 h |
| `hmda_lender_lookup` | `/view/filers` + `/v2/public/institutions` | 0.1–0.6 s | 24 h |
| `ncua_credit_union_search` | mapping.ncua.gov JSON API | 0.1–1 s (profiles fetched 6-wide) | 12 h |
| `ncua_call_report` | ncua.gov quarterly 5300 zip (~8 MB) | 2–6 s cold, ms warm | 24 h |
| `cfpb_complaints` | CCDB API `/` + `/_suggest_company/` | 1–4 s | suggest 24 h |
| `cfpb_complaint_trends` | CCDB API `/` size=0 per period | 0.5–1.5 s | 6 h |

All verified live from the sandbox on 2026-10-22 (smoke script:
`scratchpad/builders/banking-credit-smoke.ts`). No env vars introduced.

## 1. HMDA Data Browser API (CFPB/FFIEC)

Docs: https://ffiec.cfpb.gov/documentation/api/data-browser/ — keyless, no stated rate limit.
Responses are gzip-encoded (curl needs `--compressed`; Node `fetch` inflates automatically).

* `GET https://ffiec.cfpb.gov/v2/data-browser-api/view/aggregations?years=2024&counties=17043&actions_taken=1`
  Rules learned the hard way (the sandbox's bare `states=IL&years=2023` got a 400):
  * `years` is required; one geography family (`counties` | `states` | `msamds`) and/or `leis`.
  * **At least one and at most two "HMDA data" filters** (`actions_taken`, `loan_purposes`,
    `loan_types`, `lien_statuses`, `total_units`, `dwelling_categories`, `loan_products`,
    `construction_methods`, `races`, `sexes`, `ethnicities`). Zero →
    `provide-atleast-one-filter-criteria`; three → `provide-two-or-less-filter-criteria`.
    The tool defaults to `actions_taken=1` and throws a clear error on >2.
  * Multi-valued filters return one `{count,sum,...}` row per value combination;
    several `years` in one request are summed, so the tool issues one call per year.
  * `sum` is total `loan_amount` in USD (public LAR amounts are $10k-bucket midpoints).
  * Verified: DuPage 2024 originations 15,885 / $5.27B; IL 2024 207,609 / $56.8B; 2025 already
    partially populated (quarterly filers), so `years=2025` works but is incomplete.
* `GET …/view/csv?years=2024&counties=17043&actions_taken=1` → 301 to
  `files.ffiec.cfpb.gov/data-browser/datasets/<year>/filtered-queries/one-year/<hash>.csv`.
  99 columns incl. `lei, loan_amount, conforming_loan_limit (C/NC/NA), loan_purpose, lien_status,
  occupancy_type, business_or_commercial_purpose, total_units, interest_rate, property_value,
  income ($k), census_tract`. The tool streams the body line by line (never buffers the file),
  keeps a per-LEI reducer plus a 40-row top-loan heap, so memory is flat (~175 MB RSS incl. tsx).
  Jumbo flag = `conforming_loan_limit == "NC"` (FHFA limit; 2024 baseline $766,550, table in
  `CONFORMING_LIMIT`) or `min_loan_amount` override. Defaults: originated, first lien, 1–4 units,
  non-business, purposes 1/31/32. DuPage 2024: 10,825 qualifying originations, 642 jumbo (5.9 % of
  count, 18.6 % of $), avg jumbo $1.25M; top jumbo lenders Huntington, Fifth Third, Guaranteed Rate.
  Cook 2024 (28 MB) streamed in ~2 s. MSA-level pulls (Chicago MD ≈ 100k+ rows) work but are slower.
* `GET …/view/filers?years=2024` → `{institutions:[{lei,name,count,period}]}` (~5k filers, 120 KB).
  Used for LEI→name in both jumbo and lookup tools (names are HMDA respondent names).
* `GET https://ffiec.cfpb.gov/v2/public/institutions/<LEI>/year/<year>` → agency code, respondent
  name/city/state, taxId, emailDomains, hmdaFiler/quarterlyFiler flags. `assets`, `rssd`, `parent`,
  `topHolder` are `-1`/blank for most filers (returned as null). The GLEIF helper in `lib/gleif`
  is not imported (its exports are tool handlers, not a plain resolver); descriptions point the
  model to `gleif_entity_profile` for hierarchy.

Not available: quarterly HMDA data API (`/v2/data-browser-api/view/quarterly`) was not needed;
census-tract → place-name mapping (the model must supply Hinsdale tract GEOIDs if it wants to
restrict to the village; county + `include_tracts` is the practical path).

## 2. NCUA

### Credit Union Locator / Research API (mapping.ncua.gov)
The site is an Angular SPA; `GET /api/CreditUnion/GetCreditUnions` (the URL in the brief) just
returns the 12 KB app shell. Real endpoints, recovered from `main-*.js` and verified:

* `POST /api/ResearchCreditUnion/GetDetailSearch` body
  `{cuName,city,state,zipCode,cuType:"1"|"2",cuStatus:"A"|"I",fomType,lowIncome,isMdi,skip,take}`
  → `{totalResultCount,results:[{charterNumber,name,city,state,isCorporate,isActive}]}`.
  `city` is matched against the HQ mailing city (uppercase); `zipCode` matches mailing ZIP only;
  inactive (merged/liquidated) charters come back with blank city/state.
* `POST /api/ResearchCreditUnion/GetQuickSearch` `{charter:<int>,skip,take}` (charter must be a JSON int).
* `POST /api/Search/GetSearchLocations` — branch locator radius search; body shape is the SPA's
  `Xs` class (`searchText, rdSearchType:"zipcode"|"cuname"|"cunumber"|"address"|"city"|"state",
  rdSearchRadiusList:<miles 2/5/10/15/25/50>, is_* booleans, skip, take, sort_item, sort_direction`)
  → `{latitude,longitude,valid,list:[branch…],totalResults}`. The tool dedupes branches to one row
  per credit union (nearest branch kept). 60521 @ 10 mi → 24 branches / ~15 credit unions
  (Western Springs FCU, GreenState, Midwest Coalition of Labor, NuMark, Credit Union 1, …).
* `GET /api/CreditUnionDetails/GetCreditUnionDetails/<charter>` → profile JSON (assets, members,
  type FCU/FISCU, status, charter/insured dates, FOM, peer group, address, phone, website, CEO,
  `callReportCycleDates`). ~0.3 s; 404/`isError` for unknown charters.
* `GET /api/DataQuery/GetCurrentCycle` → `"2026-06-30T00:00:00"` (used to pick the latest zip).
* `GetDownloadCallReport` / `GetDownloadProfile` return a PDF as a JSON byte array — not used.
  fpr.ncua.gov (Financial Performance Report) is an ASP.NET postback app with no JSON API.

### 5300 Call Report quarterly files
`https://ncua.gov/files/publications/analysis/call-report-data-YYYY-MM.zip` (MM = 03/06/09/12;
~8 MB; 2026-06 is current, 2026-09 404s until ~late November). Comma-delimited text tables;
the tool loads `FOICU.txt` (identity: CU_NUMBER, CU_NAME, CITY, STATE, ZIP, RSSD, CU_TYPE,
PEER_GROUP, LIMITED_INC, IsMDI, YEAR_OPENED), `FS220.txt` (ACCT_010 assets, 025B loans, 018
shares, 083 members, 084 potential members, 041B delinquent ≥60d, 300 provision, 380 dividends,
340 interest on borrowings, 550/551 charge-offs/recoveries, 671 non-interest expense, 860C
borrowings, 068 uninsured shares, 031A/B loans granted YTD), `FS220A.txt` (Acct_997 net worth,
Acct_998 net-worth ratio, 115 interest income, 117 non-interest income, 661A net income) and
`FS220L.txt` (ACCT_703A first-lien 1-4 family, 386A junior lien, 386B other RE, 563A first-lien
rate). `AcctDesc.txt` documents every account. **Units quirk:** Acct_998 and loan-rate accounts
are stored in basis points (917 = 9.17 %, 575 = 5.75 %) — converted to decimals. YTD income is
annualized by quarters elapsed; ratios use period-end (not average) assets, so they differ a few
bp from NCUA's FPR. Alliant (67955) 2026-06: $20.0B assets, NW 9.17 %, ROA 0.95 %, first
mortgages $6.9B (43 % of loans). State ranking mode: IL has 188 credit unions / $77.6B.
Memory: the zip is parsed with `adm-zip` (already a dependency); ~60 MB peak, well under budget.

## 3. CFPB Consumer Complaint Database API

Base `https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/` —
the **trailing slash is required**; without it (or with `format=json`) you get the HTML app
shell / 404. Keyless, CC0, ~18.6M complaints, `_meta.last_updated` daily. OpenAPI spec:
https://raw.githubusercontent.com/cfpb/ccdb5-api/main/swagger-config.yaml.

* `GET /?company=…&product=…&issue=…&state=…&zip_code=…&date_received_min=…&search_term=…
  &size=25&frm=0&sort=created_date_desc&no_aggs=false&no_highlight=true` — Elasticsearch-style
  response: `hits.total.value`, `hits.hits[]._source` (product, sub_product, issue, sub_issue,
  company, state, zip_code, date_received, company_response, timely, submitted_via, tags,
  company_public_response), `aggregations` (product→sub_product, issue→sub_issue, company,
  state, company_response, timely, submitted_via, tags, company_public_response).
  Facets are computed with UI "post-filter" semantics (each facet excludes its own filter), so
  the tool restricts facet buckets to the applied filter values to keep them consistent with
  `total`. `company` must be the exact CCDB string (`CHARLES SCHWAB CORPORATION, THE`), so the
  tool resolves free text through `/_suggest_company/?text=…` (prefix matcher; it tries shorter
  leading-word prefixes and only accepts suggestions containing every word — "Fidelity
  Brokerage" resolves to nothing rather than to FNIS). Repeated params = OR.
* **Narratives are not available programmatically**: `has_narrative=true` filters, but
  `complaint_what_happened` is absent from `_source` (and `/ <id>` detail), and
  `field=complaint_what_happened` is rejected. Narratives are only in the bulk CSV download.
* **`/trends` is not deployed** (documented in older ccdb5-api versions; now returns the app
  shell). `cfpb_complaint_trends` instead issues one `size=0&no_aggs=true` count per period
  (0.5 s each, 6 in parallel, cached 6 h) — 12 months ≈ 1–1.5 s.
* Observed volumes: ZIP 60521 since 2024 = 191 complaints (92 % credit-reporting disputes);
  Schwab last 90 days = 85 (86 % checking/savings); IL mortgage complaints last 12 months = 1,193.

## Caveats / not verified
* HMDA 2025 is partial (quarterly filers only) until the June 2026 annual release — descriptions
  say so. 2026 conforming limit in the table ($832,750) is the FHFA announcement value.
* NCUA endpoints are an undocumented SPA backend; the request shapes could change without notice
  (the tool fails loudly with the upstream status). No rate limits observed at 6-wide parallelism.
* CFPB `search_term` matches structured fields only (not narrative text) via the public index.
* Nothing here needs an API key; nothing hit 429 from the shared proxy IP during testing.
