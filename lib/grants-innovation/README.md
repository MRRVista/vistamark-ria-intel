# grants-innovation — Research Grants, Patents & Higher-Ed

Catalog id `grants`. Exports `GRANTS_TOOLS`, `GRANTS_DOMAIN`, `GRANTS_CHECKS` from `index.ts`.
Complements `lib/usaspending` (all-agency dollars by recipient) and `lib/ipeds` (endowment
history): this family answers *who* — PIs, inventors, registrants — and *what is fundable*.

| Tool | Source | Auth | Verified live (sandbox, 2026-10-22) |
|---|---|---|---|
| `nih_reporter_search` | NIH RePORTER v2 | none | yes |
| `nih_reporter_publications` | NIH RePORTER v2 | none | yes |
| `nsf_awards_search` | NSF Awards API v1 | none | yes |
| `grants_gov_search` | Grants.gov Search2 + fetchOpportunity | none | yes |
| `patentsview_search` | PatentsView PatentSearch | `PATENTSVIEW_API_KEY` | **no** — host unreachable + no key |
| `college_scorecard` | College Scorecard (api.data.gov) | `DATA_GOV_API_KEY` | yes, with `DEMO_KEY` |
| `sam_entity_search` | SAM.gov Entity Management v3 | `DATA_GOV_API_KEY` | **no** — HTTP 404 from sandbox |

Env vars introduced: `PATENTSVIEW_API_KEY` (new), `DATA_GOV_API_KEY` (already reserved in root README).
Keyed tools throw `"<KEY> not configured — …"` before any network call.

## NIH RePORTER v2
- `POST https://api.reporter.nih.gov/v2/projects/search` — GET returns 405. Body `{criteria, limit, offset, include_fields, sort_field, sort_order}`.
- Criteria used: `pi_names:[{any_name|first_name|last_name}]`, `org_names` (substring), `org_cities`, `org_states`, `fiscal_years`, `award_amount_range:{min_amount,max_amount}`, `advanced_text_search:{operator,search_field,search_text}`, `activity_codes`, `is_active`.
- `sort_field`: `award_amount | fiscal_year | project_start_date`. limit ≤ 500, offset ≤ 14,999. `meta.total` = hit count.
- `POST /v2/publications/search` with `criteria.core_project_nums` or `criteria.pmids` → `{coreproject, pmid, applid}` only (no titles).
- Rate limit: undocumented, ~1 req/s polite. Refresh weekly. Cached 12h / 24h.
- Quirk: one record per fiscal-year award, so a 5-year R01 appears five times; `totals*` are page-level only.
- Quirk: `meta.properties.URL` comes back as `https:/reporter…` (single slash) — fixed in output.

## NSF Awards API v1
- `GET https://api.nsf.gov/services/v1/awards.json?keyword=&piFirstName=&piLastName=&awardeeName="…"&awardeeCity=&awardeeStateCode=&dateStart=MM/DD/YYYY&dateEnd=&rpp=25&offset=N&printFields=…`
- `offset` is a **0-based record offset** (offset=1 skips the first record — not a page number). `response.metadata.totalCount` is the hit count.
- `activeAwd` is a response field but **not** an accepted filter (400 "Invalid Parameter(s) {activeAwd}") — `active_only` filters client-side on the returned page.
- `abstractText` is returned regardless of `printFields` (dropped). Amounts are strings of whole USD; dates MM/DD/YYYY.
- Keyless, no documented rate limit; fast (~100–300 ms). Cached 12h.

## Grants.gov
- `POST https://api.grants.gov/v1/api/search2` body `{keyword, oppStatuses:"forecasted|posted", agencies:"NEH|IMLS", fundingCategories, eligibilities, cfda, rows, startRecordNum, sortBy:"openDate|desc"}` → `data.hitCount`, `data.oppHits[]`, facet arrays (`agencies`, `fundingCategories`, `eligibilities`, `oppStatusOptions`).
- `POST /v1/api/fetchOpportunity` `{opportunityId:<number>}` → `data.synopsis` (or `data.forecast`) with `estimatedFunding`, `awardCeiling`, `awardFloor`, `numberOfAwards`, `responseDate`, `applicantTypes[]`, `synopsisDesc`.
- Keyless. Response includes a JWT `token` field (session token, ignored). Cached 6h.

## PatentsView PatentSearch — UNVERIFIED
- `POST https://search.patentsview.org/api/v1/patent/` header `X-Api-Key`, body `{q, f, s, o:{size}}`; 45 req/min/key; free key via the PatentsView service desk.
- Query built from docs + ropensci client examples: fields `patent_id, patent_title, patent_date, patent_type, patent_num_times_cited_by_us_patents, inventors.inventor_name_first/last, inventors.inventor_city/state, assignees.assignee_organization, assignees.assignee_individual_name_first/last, assignees.assignee_city/state`; operators `_begins`, `_contains`, `_text_any`, `_gte/_lte`, `_and/_or`. Response `{patents[], total_hits, error}`.
- Sandbox: every request to `search.patentsview.org` failed at the proxy (`CONNECT tunnel failed, response 502`), and the official docs page could not be fetched (fetch permission timed out: https://search.patentsview.org/docs/docs/Search%20API/SearchAPIReference/). First production call with a key should confirm field names; errors surface the upstream message verbatim.

## College Scorecard
- `GET https://api.data.gov/ed/collegescorecard/v1/schools?api_key=…&school.name=…&fields=…&per_page=…&sort=latest.student.size:desc`; `school.degrees_awarded.predominant__range=2..4` keeps degree-granting schools; `latest.student.size__range=N..` for min size.
- Verified with `DEMO_KEY` (shared demo key, 30 req/h): `school.endowment.begin/end`, `latest.earnings.10_yrs_after_entry.median`, `latest.cost.avg_net_price.overall` etc. all populate. Production: 1,000 req/h per key. Annual release. Cached 24h.
- Note: `school.name` is a substring match (`Northwestern` matched Northwestern State U of Louisiana first; sort by size and use the full name).

## SAM.gov Entity Management v3 — UNVERIFIED
- `GET https://api.sam.gov/entity-information/v3/entities?api_key=…&legalBusinessName=&ueiSAM=&cageCode=&physicalAddressCity=&physicalAddressProvinceOrStateCode=IL&physicalAddressZipPostalCode=&primaryNaics=&registrationStatus=A&includeSections=entityRegistration,coreData,assertions&page=&size=` per https://open.gsa.gov/api/entity-api/.
- Rate limit is the binding constraint: **10 requests/day** for a personal api.data.gov key with no SAM.gov role, 1,000/day with a role or system account. Tool caches 24h and does not retry.
- Sandbox: `api.sam.gov` returned HTTP 404 with an empty body for every path (v2, v3, opportunities, exclusions, with and without `DEMO_KEY`); `https://api.data.gov/sam/...` returned 429 OVER_RATE_LIMIT. Likely an egress/UA block on the shared sandbox IP; mapping (`entityData[].entityRegistration / coreData.physicalAddress / assertions.goodsAndServices.naicsList`, `totalRecords`) follows the spec and needs a first production call to confirm.

## Selftest probes (`GRANTS_CHECKS`)
NIH Hinsdale IL (~0.5 s), NSF Hinsdale IL (~0.3 s), Grants.gov NEH posted (~0.4 s), College Scorecard (fails fast without `DATA_GOV_API_KEY`).
Smoke script: `/tmp/claude-0/-home-claude/b833aeaa-ec20-51c6-be5f-ea01232783a0/scratchpad/builders/grants-innovation-smoke.ts`.
