# Advisor & Broker Records family (`lib/regulatory/`)

Live, keyless, per-person and per-firm regulatory records. Complements `lib/adv` (bulk Form ADV in Postgres): use `search_rias` / `search_advisors` for AUM, fees and roster-scale queries, and these tools for the live CRD/IARD record of one person or firm and for SEC enforcement screens.

| Tool | Upstream (verified live 2026-10-22) | Cache |
|---|---|---|
| `brokercheck_individual_search` | `GET https://api.brokercheck.finra.org/search/individual?query=&firm=&state=&city=&hl=false&nrows=&start=&r=25&wt=json` | 1h |
| `brokercheck_individual_detail` | `GET https://api.brokercheck.finra.org/search/individual/<crd>?hl=true&nrows=12&start=0&wt=json` | 6h |
| `brokercheck_firm_search` | `GET https://api.brokercheck.finra.org/search/firm?query=&hl=false&nrows=&start=&wt=json` | 1h |
| `brokercheck_firm_detail` | `GET https://api.brokercheck.finra.org/search/firm/<crd>?hl=true&nrows=12&start=0&wt=json` (+ one people-index call for headcount) | 6h |
| `iapd_individual_search` | `GET https://api.adviserinfo.sec.gov/search/individual?...` (same params) | 1h |
| `iapd_individual_detail` | `GET https://api.adviserinfo.sec.gov/search/individual/<crd>?...` | 6h |
| `iapd_firm_detail` | `GET https://api.adviserinfo.sec.gov/search/firm/<crd>?...` | 6h |
| `sec_litigation_releases` | RSS `https://www.sec.gov/enforcement-litigation/litigation-releases/rss` (newest 25); listing `https://www.sec.gov/enforcement-litigation/litigation-releases?populate=<kw>&year=YYYY|All&month=M|All&page=N` (100/page); LR page `/enforcement-litigation/litigation-releases/lr-NNNNN` for summaries | 1h / 2h / 24h |
| `sec_admin_proceedings` | RSS `https://www.sec.gov/enforcement-litigation/administrative-proceedings/rss`; listing `https://www.sec.gov/enforcement-litigation/administrative-proceedings?populate=&year=&month=&page=` | 1h / 2h |

## FINRA search engine (BrokerCheck + IAPD)

Both hosts front the same Elasticsearch-style engine; only the field prefixes differ.

- **Auth / limits**: none. ~60 calls in a few minutes from the sandbox never hit a real quota. A `Referer: https://brokercheck.finra.org/` header is sent for politeness.
- **Soft errors come back as HTTP 200** with `{errorCode:-1, errorMessage, hits:null}`. `engineGet()` in `common.ts` retries twice on the body (1.5s, 3.5s) then throws with the message.
  - `"Exceeded limit"` is **not** a rate limit: BrokerCheck returns it whenever `state=` is sent without `r=`. We always send `r=25`.
  - `"Search unavailable, please try again later"` = an unsupported param (`filter=`, `includePrevious=`, `sort=`). Not sent.
  - `"query can't be empty"` = no `query` and no `firm`.
- **Filters that work server-side**: `query` (name), `firm` (CRD or name; `query` may be empty to list a roster), `state`, `city` (with `state`). `zip`, `radius`, `location` are accepted but ignored (totals unchanged), so `zip` is applied client-side (exact zip, then same 3-digit prefix) over the first 50 hits.
- **Search hit fields**: `ind_source_id` (CRD), names, `ind_bc_scope` / `ind_ia_scope` (Active | InActive | NotInScope | Expanded), `ind_bc_disclosure_fl` (BC) / `ind_ia_disclosure_fl` (IAPD), `ind_approved_finra_registration_count`, `ind_industry_cal_date` (BC) / `ind_industry_cal_date_iapd`, `ind_current_employments` (BC) / `ind_ia_current_employments` (IAPD). On the IAPD host, BD-only reps show no current firms; on the BC host, IA-only people often lack the industry start date (years come from the detail call instead).
- **Detail payload is double-encoded**: `hits.hits[0]._source.content` (BC) or `.iacontent` (IAPD) is a JSON string. Keys: `basicInformation`, `currentEmployments`, `currentIAEmployments`, `previousEmployments`, `previousIAEmployments`, `disclosures[]` (`eventDate`, `disclosureType`, `disclosureResolution`, `disclosureDetail{Type, Allegations, Disposition, Sanctions, Broker Comment…}`), `stateExamCategory` / `principalExamCategory` / `productExamCategory`, `registrationCount`, `registeredStates`, `registeredSROs`. IAPD adds `iaDisclosures` (counts by type) and `branchOfficeLocations` with lat/long.
- **Firm detail**: BC `content` has `basicInformation` (firmType, formedState/Date, firmSize, districtName, regulator, SEC numbers), `firmAddressDetails`, `disclosures[{type,count}]`, `registrations`, `directOwners`. IAPD `iacontent` has `registrationStatus`, `noticeFilings`, `orgScopeStatusFlags`, `brochures`, `advFilingDate`, `crs.fileId`. Firm search hits carry the address as a stringified JSON blob (`firm_address_details`). Headcount is not in either document; `firmDetail()` reads `hits.total` of `/search/individual?firm=<crd>`.
- A non-existent CRD returns `hits.total: 0` (not 404) → clear "no record returned" error.

## SEC enforcement (sec.gov)

- **UA**: sec.gov rejects anonymous UAs; `politeFetch` sends `Vistamark Intel (vistamark-ria-intel; mrice@vistamarkllc.com)` (override with `VISTAMARK_USER_AGENT`). Fair-use limit is 10 req/s; we make ≤ 1 + 3 pages + 6 summary fetches per call.
- The legacy `/rss/litigation/litreleases.xml` and `/rss/litigation/admin.xml` now 301 to the URLs above (via an HTML meta-refresh, so the canonical URLs are used directly).
- RSS: 25 items; `<title>` = respondents, `<dc:creator>` = release number, `<link>` = LR page (litigation) or order PDF (admin).
- Listing (Drupal view): rows are `<tr class="pr-list-page-row">` with `<time datetime>`, respondents link, `Release No.`, `File Number` (admin) and "See Also" PDFs (complaints, judgments, distribution plans). `year`/`month` filter server-side (e.g. 2026/9 → 39 rows). `populate` searches respondent names/titles, **returns 0 rows when combined with a year**, and its index is shallow (e.g. "Advisers" → 14 rows, newest 2022; "Chicago" → 9). So keyword runs use `year=All`, apply year/month/since/until locally, and re-check the keyword against the respondent string.
- LR detail pages are HTML; `includeSummary` strips the `field--name-body` article and returns from "Litigation Release No. …" onward (default 600 chars, max 6 pages per call). AP orders are PDFs and are linked, not parsed.

## Dropped: `finra_disciplinary_search`

FINRA Disciplinary Actions Online (`finra.org/rules-guidance/oversight-enforcement/finra-disciplinary-actions-online`) is a Drupal **POST webform** (`fda_search`, `firms`, `individuals`, `case_id`, `document_type`, `from_date`, `to_date`, `form_build_id`, `terms_of_service` checkbox) with results rendered server-side; GET query strings return the blank form. There is no JSON endpoint on www.finra.org (`/api/...` paths 404), and `api.finra.org` (FINRA Query API) returns 401 without an API token and has no public disciplinary-action dataset. Per-person FINRA actions are already covered by the `Regulatory` disclosures in `brokercheck_individual_detail`; firm-level counts by `brokercheck_firm_detail`. Monthly Disciplinary Action Reports exist only as PDFs.

## Not verified from the sandbox

- Behaviour under sustained load (> 1 call/s) from the Vercel egress IPs — FINRA may throttle differently than it did the proxy IP.
- The BrokerCheck `start` offset beyond the first few pages (tested to `start=0` only; the engine caps `nrows` at 50 in practice).
- Form CRS link pattern `https://reports.adviserinfo.sec.gov/crs/crs_<crd>.pdf` is the pattern the public site uses; not fetched here.

## Smoke

`npx tsx /tmp/claude-0/-home-claude/b833aeaa-ec20-51c6-be5f-ea01232783a0/scratchpad/builders/regulatory-smoke.ts` — all nine tools + the three `REGULATORY_CHECKS` passed on 2026-10-22 (each < 0.7 s warm, < 2 s cold; largest payload 3.6 KB).
