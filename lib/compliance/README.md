# Compliance Screening family (`lib/compliance/`)

Onboarding screens for an RIA's clients, prospects and counterparties. Six live,
keyless tools; every upstream verified from the sandbox on 2026-10-22. Exports
`COMPLIANCE_TOOLS`, `COMPLIANCE_DOMAIN` (catalog id `compliance`), `COMPLIANCE_CHECKS`.

| Tool | Source | Cold / warm | Cache |
|---|---|---|---|
| `ofac_sdn_search` | OFAC SDN + Consolidated CSVs | ~2.5 s / <0.4 s | 12 h |
| `ofac_sdn_status` | same + SLS publication history | ~2.5 s / 10 ms | 12 h / 6 h |
| `fincen_msb_search` | FinCEN MSB full-list export | ~3.5–4.5 s / <0.3 s | 24 h |
| `occ_enforcement_search` | OCC EASearch JSON export | ~9–13 s / <0.1 s | 12 h |
| `sec_pause_list` | SEC PAUSE Drupal pages | ~1.5–2 s / <0.1 s (+details) | 24 h |
| `cftc_red_list` | CFTC RED List page | ~0.3 s / 3 ms (+details) | 24 h |

Name matching (`common.ts`): NFD-strip diacritics, lowercase, drop punctuation and
corporate boilerplate (Inc/LLC/OOO/JSC/…), then per-token best Jaro-Winkler coverage
(order-insensitive, so "PUTIN, Vladimir" ≈ "Vladimir Putin") with a whole-string JW floor.
Scores 0–100; defaults `minScore` 80 (OFAC/PAUSE/RED) or 85 (MSB/OCC). Verdicts are
`NO_MATCH` / `POSSIBLE_MATCH_REVIEW` (≥minScore) / `POTENTIAL_MATCH` (≥95).

## OFAC — `ofac_sdn_search`, `ofac_sdn_status`

* Files (legacy CSV, no header, `-0- ` = null), served by the **Sanctions List Service**:
  `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/{SDN,ADD,ALT,CONS_PRIM,CONS_ADD,CONS_ALT}.CSV`
  Each 302s to a presigned `*.s3.us-gov-west-1.amazonaws.com` URL (1 h expiry) — follow redirects.
  Sizes: SDN 5.7 MB (19,471 rows), ADD 1.7 MB, ALT 1.1 MB, CONS_* ≈ 0.4 MB. ~1.4 s each in parallel.
  The identical files at `https://www.treasury.gov/ofac/downloads/sdn.csv` (+ `add.csv`, `alt.csv`,
  `consolidated/cons_*.csv`, `sdn_comments.csv`) also work but took ~10 s each from here — kept as a note, not used.
* SDN.CSV columns: ent_num, name, type (individual|vessel|aircraft|blank=entity), programs (`A] [B` separated),
  title, call_sign, vess_type, tonnage, grt, vess_flag, vess_owner, remarks (DOB/POB/nationality/IDs are free text in remarks — parsed for individuals).
* 93 ent_nums appear on BOTH lists (e.g. Rosneft uid 17022: SSI Directive 2 + SDN under EO 14024); records are merged, `list: "SDN+CONSOLIDATED"`.
* Publication date: `GET https://sanctionslistservice.ofac.treas.gov/changes/history/{YYYY}/{M}` → JSON `[{publicationID, datePublished}]`.
  Also JSON: `/sanctions-programs` (75 codes), `/sanctions-lists`. `/changes/latest` and `/entities[?list=…|/{id}]` are XML (full
  list is 110 MB; no name filter) — not used. Enhanced/Advanced XML exports (110–128 MB) exist but are unnecessary for name screening.
* `https://sanctionssearch.ofac.treas.gov/` (the web Sanctions List Search) is ASP.NET WebForms (`__VIEWSTATE` POST, no JSON API; `/api/search` 404). Confirmed — not scriptable.
* No rate limit observed. Counts on 2026-10-21 publication: 19,471 SDN + 486 Consolidated; 7,637 individuals, 1,568 vessels, 342 aircraft.

## FinCEN MSB — `fincen_msb_search`

* `https://www.fincen.gov/msb-registrant-search` only iframes `https://msb.fincen.gov/` (PHP app).
* Full-list export: `POST https://msb.fincen.gov/retrieve.msb.list.php` with body `site=AA` →
  200, `Content-Type: application/vnd.ms-excell` (sic) but the body is a **UTF-8 tab-separated text file** (5.4 MB):
  header row, 34,276 registrant rows, blank line, then a legend/disclaimer trailer (stop at the first blank line).
  ZIP is Excel-quoted (`'60521`). Columns: LEGAL NAME, DBA NAME, STREET ADDRESS, CITY, STATE, ZIP, MSB ACTIVITIES (Form 107
  codes 401–499), STATES OF MSB ACTIVITIES, ALL STATES & TERRITORIES & FOREIGN FLAG (A/B/C/D, may be combined e.g. `AD`),
  FOREIGN LOCATION, # OF BRANCHES, AUTH SIGN DATE, RECEIVED DATE.
* The guessed `fincen.gov/sites/default/files/shared/msb_list.csv` is a 404 (and `/system/files/...`).
* Per-record search form (`msbstateselector.php`, POST fields `SrchBusinessName`, `SrchMSBState`, …) exists but the full list is simpler and complete.
* Only current registrations; no `Last-Modified` header. No rate limit observed.

## OCC Enforcement — `occ_enforcement_search`

* `https://apps.occ.gov/EASearch/` (ASP.NET MVC). The "Save As" control exposes a full JSON export:
  `GET https://apps.occ.gov/EASearch/Search/ExportToJSON?q=&isAdv=true` → JSON array of 6,071 actions (3.4 MB, 1987→2026-10).
  Also `ExportToCsv`, `ExportToXML`, `ExportToPdf`. Params: `q`, `startDteMin/Max`, `termDteMin/Max` (MM/DD/YYYY),
  `indOnly/instOnly/activeOnly/terminatedOnly` (true|false), `tps=<TypeCode>` (repeatable), `sms=<SubjectMatter>`, `isAdv=true`
  (needed for the advanced filters to apply). We pull the whole list once and filter locally.
* Row fields: Institution, CharterNumber, Company, Individual, Location "City, ST", TypeCode, TypeDescription, Amount,
  StartDate, StartDocuments[], TerminationDate, TerminationDocuments[], DocketNumber, SubjectMatters[] (populated since 2012).
  Document IDs ("2008-022", "AA-ENF-2026-46") → `https://occ.gov/static/enforcement-actions/ea{ID}.pdf` (verified 200). Some rows carry a literal "N/A" doc id — filtered.
* **WAF quirk:** every path under `/EASearch` returns `302 Security Redirect → https://www.occ.treas.gov/` on a random ~50 % of
  requests, independent of UA / Accept / Referer / cookie (measured 6/12 across recipes). The module fetches with `redirect: "manual"`
  and retries up to 8× (250 ms+ backoff; 1.2 s+ on 5xx — one 503 burst was seen). A real UA with a contact email is required
  (no UA at all also 302s). `/EASearch/?q=…` HTML search works the same way (10 rows/page, `pgsz` up to 1000).
* Type codes: CMP, FA, C&D, Prohibition, REST, 1829, Notice, PCAD, SEC, GLBA, CD, Suspension, SASO. 1829 notifications before
  2022-12-23 are omitted upstream. The static `occ.gov/static/ots/enforcement/ots-enforcement-order-listing.xlsx` (legacy OTS) is not used — OTS actions are already in EASearch.

## SEC PAUSE — `sec_pause_list`

* `https://www.sec.gov/enforcement-litigation/public-alerts-unregistered-soliciting-entities?page=N` — Drupal view, 100 rows/page
  (`items_per_page` ignored), 17 pages = 1,690 entries (1,216 Unregistered Soliciting Entities, 238 Fictitious Regulators,
  230 Impersonators of Genuine Firms, 6 uncategorized). No CSV/JSON. Server-side filters exist
  (`field_display_title_value=<contains>`, `field_article_sub_type_secart_value=Public Alerts-{UnregisteredSolicitingEntities|
  ImpersonatorsofGenuineFirms|FictitiousRegulators}`) but we scrape all pages (8 concurrent, ~1.5 s total) for fuzzy matching.
* Detail page `/public-alerts-unregistered-soliciting-entities/<slug>`: `field--name-field-publish-date` (alert date),
  `field--name-field-public-alerts-contact` (claimed address/phone/website), `field--name-body` (narrative; names the genuine
  CRD/SEC-registered firm when an impersonator). Fetched on demand for the top 5 hits (`details:false` to skip).
* SEC requires a descriptive User-Agent (politeFetch's passes); stay ≤10 req/s. Rows are alphabetical — there is no "recent" ordering.

## CFTC RED List — `cftc_red_list`

* `https://www.cftc.gov/LearnAndProtect/RedList` is a **404**; the live page is
  `https://www.cftc.gov/LearnAndProtect/Resources/Check/redlist.htm` (Drupal view `registration_deficient`, 10 rows/page, 29 pages).
  `?items_per_page=All` returns everything in one ~200 KB page (280 entities, latest entry 2025-05-29).
  Rows: `<time datetime="YYYY-MM-DD">` + `<a href="/REDlist/node/N">Company</a>`. `/views/ajax?view_name=registration_deficient…`
  also answers (Drupal AJAX JSON wrapping HTML) but is not needed.
* Node pages (`/REDlist/node/N`) give Web address, Origin, Owned and Operated by, Type of Offerings — parsed on demand for top 5 hits.
* No rate limit observed (Cloudflare in front). Tool named `cftc_red_list` (the brief's `cftc_reparations_sanctions` was a working title; the RED list is a registration-deficiency list, not reparations).

## Dropped: FDIC Enforcement Decisions & Orders (`fdic_enforcement_search`)

* `https://orders.fdic.gov/s/` is a Salesforce Experience Cloud (Aura) site. From this sandbox: curl fails TLS
  (`unable to get local issuer certificate` — the server sends only the leaf, no DigiCert EV RSA CA G2 intermediate) and Node
  `fetch` gets `503 upstream connect error ... remote connection failure` from the proxy. With the intermediate manually appended
  the HTML loads, but the data lives behind Aura `/s/sfsites/aura` POSTs with undocumented, deploy-specific descriptor/fwuid
  tokens — no stable public API. The monthly press releases (`fdic.gov/news/press-releases/YYYY/fdic-publishes-<month>-enforcement-actions`)
  link only back to `orders.fdic.gov/s/press-release-orders?prYear=&prMonth=&prDate=` (same Aura app); no CSV/XLSX list is published.
  FDIC's BankFind API (`banks.data.fdic.gov`, already used by `lib/fdic`) has no enforcement dataset.
* Not built rather than faked. Workaround for users: OCC covers national banks/thrifts here; for state non-member banks use the
  orders.fdic.gov UI or FFIEC/state regulator sites manually.

## Not verifiable from the sandbox

* Whether the OCC WAF behaves the same from Vercel's egress (the 302 coin-flip may be IP-reputation based). If a cold call exceeds
  the 60 s budget, raise the retry cap or pre-warm via selftest.
* Lambda memory: the OFAC dataset (~20k entities with prepared tokens) is ~60–80 MB resident; OCC ~15 MB; MSB ~25 MB. Fine for 1 GB.
* `ofac_sdn_status.listPublished` relies on the SLS history endpoint for the current/previous month; it returns null (not an error) if that endpoint is down.

## Env vars introduced

None (all sources keyless).
