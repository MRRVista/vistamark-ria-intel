# legal-pros · directories-erisa-general

Module: `lib/legal-pros/directories-erisa-general.ts`
Exports: `ERISAGENERAL_TOOLS`, `ERISAGENERAL_CATALOG`, `ERISAGENERAL_CHECKS`, handlers `acebcFellowSearch`, `leadingLawyersSearch`, `ardcLawyerLookup`, preset map `LL_PRESETS`.

All three tools are keyless, live HTML scrapes (regex + `stripTags`, no cheerio), fetched with `BROWSER_UA`, cached 6–24 h via `cached()`. Every response is `{ dataSource, asOf, query, returned, total, rows, note }`. Results are public directory/registry records, not consent to contact; only professional/firm contact details are returned.

Live verification date: **2026-10-24** from the sandbox (proxy egress). All three hosts answered 200 to both the Vistamark UA and the browser UA; no Akamai/Cloudflare challenge, no 429s seen across ~40 requests.

---

## `acebc_fellow_search` — American College of Employee Benefits Counsel

**Endpoint** `GET https://www.acebc.com/fellows?fullname=<name>&state=<ST>&topics=<1-12>&is_expert_witness=1&is_mediator=1&is_speaker=1&search-submit=Search`
(the `search-submit` param is what distinguishes a search from the empty landing page — without it the page returns the blank form). No auth. The all-fellows roll is also at `/employee-benefits-attorneys` (583 rows) but the tool refuses unfiltered calls.

**Result structure** `<table id="search-results">`; per `<tr>`: `td.column1` = `<a href="https://www.acebc.com/profiles/<slug>">Last, First M.</a>` + `<span>` status badges (H Honorary, CF Charter, F Fellow, E Emeritus, D Deceased, M In Memoriam); `td.column2` = `City, ST`; `td.column3` = `Topic | Expert Witness | Mediator | Speaker<br />…` (self-designated). No paging. Profile pages carry only `<h1>Name</h1><h2>City, ST</h2>` + bio — **no firm, phone or email is published**; chain to `ardc_lawyer_lookup` for the registered firm.

**Topic ids** 1 DB Plans · 2 DC Plans · 3 IRAs · 4 Exempt/Governmental · 5 Multiemployer · 6 Health & Welfare · 7 Fiduciary/Other Title I · 8 IRC · 9 PBGC · 10 Executive Compensation · 11 Fringe Benefits · 12 Actuarial.

**Verified live** `{state:"IL"}` → 36 upstream rows, 34 after dropping Deceased/In Memoriam (default); `{state:"IL", city:"Chicago", topic:"DC Plans"}` → 3; `{name:"Adams"}` → 2 (nationwide). ~250–600 ms. Row ≈ 250 chars; 50 rows ≈ 8.6 K chars — keep `limit` ≤ 25 for Randall.

**Quirks** city filter is client-side (upstream has no city field). Names are reordered from "Last, First" to "First Last"; `lastName` is kept internally for ARDC chaining.

---

## `leading_lawyers_search` — Leading Lawyers (leadinglawyers.com)

**Endpoint** `POST https://www.leadinglawyers.com/search/search_results.cfm` (ColdFusion; `/search/` itself is an open Apache directory listing — the forms are `search_personal.cfm` and `search_business.cfm`). Content-type `application/x-www-form-urlencoded`. No auth, no session cookie needed.

**Form fields — every one must be present** or CF throws `UndefinedElementException: Element COUNTYIL is undefined in FORM` (HTTP 500; the tool surfaces that text):
`aol` (exact `<option value>` text of the practice area; leading/trailing spaces in the option values are ignored by the server), `state` (IL|MI|MO), `cityDefault`, `cityIL`, `cityMI`, `cityMO`, `zip`, `countyDefault`, `countyIL`, `countyMO`, `countyMI`, `LL=on` (Leading Lawyers tier), `EL=on` (Emerging Lawyers tier), `search_type` (personal|business — informational; the server returned identical rows for `Employee Benefits Law` under either value).

**Practice-area presets** (`LL_PRESETS`): estate → "Trust, Will & Estate Planning Law"; tax_individual → "Tax Law: Individual"; tax_business; employee_benefits → "Employee Benefits Law" (business form); family → "Family Law"; family_appellate; adr_family; adoption → "Adoption & Reproductive Technology Law"; elder → "Elder Law"; closely_held; nonprofit; real_estate_residential; securities; banking; ma. Free text via `aol`. Full option lists: 38 top-level personal categories, 73 business categories (sub-topics share the parent's value, so they are not separately searchable).

**Geography** city values are Title Case as in the `cityIL` select (569 IL cities incl. Hinsdale, Oak Brook, Burr Ridge, Clarendon Hills, La Grange, Western Springs — note "La Grange" with a space); `countyIL` has 102 IL counties; `zip` is a free text field. One of city/county/zip is required.

**Result structure** one page, no server paging (338 rows / 250 KB came back in one response). Four groups in order, each introduced by a banner `<img src="../images/LLlogo.png">` or `ELlogo.png`: LL members, EL members, LL listed, EL listed. Member rows: `<li><a href="../atty_profile.cfm?TOCUID=…"><strong><u>Name</u></a></strong></li>` then navy `<font>` city, phone, `mailto:`, firm (`colspan='3'`), website `<a href='http://…'>`, maroon `<font>` practice areas (`<br/>`-separated), and a `width='300'` cell of focus statements. Listed (non-member) rows: `<li><strong>Name</strong></li>`, city, firm, practice areas only. Footer `Results: <b>1 - N</b> of <strong>N</strong>`; zero results renders `Results: 0 - 0 for: IL within state AND … Please try your Search Again`.

**Verified live** (all 200):
| query | rows |
|---|---|
| estate × Hinsdale | 2 (1 member w/ phone+email+site, 1 listed) |
| employee_benefits × Chicago | 86 |
| estate × DuPage county | 42 |
| family × zip 60521 | 1 |
| family × Chicago | 332 (43 LL members, 16 EL members, 41 LL listed, 232 EL listed… tier counts verified via offset paging) |
| family × Chicago, LL only | 263 |
| Aviation Law × Hinsdale | 0 (clean empty) |

Latency 4–10 s per uncached POST (the CF server is slow); cached 12 h per field-set, so `offset` paging is free after the first call. 86 rows ≈ 26 K chars → default `limit` 25 (≈ 8 K) is the right ceiling for Randall; use `membersOnly:true` to get only rows with phone/email.

**Quirks** order within groups is random by design (site says "in no way a ranking"). Member tier is inferred from the preceding banner. `tier` can be null only if the banner markup changes. Phone/email/website exist only for paid member profiles. The `atty_profile.cfm?TOCUID=` page is a full bio (title tag `Name | Firm | City | County | Illinois attorney lawyer search`) — not fetched by the tool.

---

## `ardc_lawyer_lookup` — Illinois ARDC Lawyer Search (iardc.org)

**Not blocked from the sandbox** (SPEC anticipated possible blocking — it was not; all steps 200). ASP.NET MVC with anti-forgery tokens; four requests per cold lookup:

1. `GET /Lawyer/Search` → `Set-Cookie: __RequestVerificationToken=…` + hidden form token inside `<form id="lawyer-search-form">`.
2. `POST /Lawyer/SearchResults` (full form: `__RequestVerificationToken`, `IsRecentSearch=False`, `IncludeFormerNames=false`, `LastName`, `LastNameMatch=Exact|Phonetic`, `FirstName`, `Status=All|AuthorizedToPractice`, `LawyerCounty`, `City`, `State`, `Country`, `StatusChangeTimeFrame=Last30Days`, `BusinessLocation=All`, `County`, `JudicialCircuit`, `JudicialDistrict`, `StatusLastName`) → HTML page whose inline script carries `PageKey: "<guid>"` and the enum-int form of the query. **SearchGrid 500s without a PageKey minted by this step** (verified: fresh/random GUID → 500).
3. `POST /Lawyer/SearchGrid?rows=N&page=M` with `X-Requested-With: XMLHttpRequest`, cookie, and the int-coded fields (`LastNameMatch 0=Exact 1=Phonetic`, `Status 0=AuthorizedToPractice 1=All`, `StatusChangeTimeFrame 0`, `BusinessLocation 0`) → mvc-grid table: hidden id GUID, hidden include-former-names, Name (`<a class='show-lawyer-profile' data-id='<guid>'>Last, First M.</a>`), City, State, Date Admitted (M/D/YYYY), Authorized To Practice (Yes/No); `data-total-results", N` in the inline script; page sizes 5/10/25/50/75/100; "No Data Found" row when empty.
4. `POST /Lawyer/Details` `{id, includeFormerNames, __RequestVerificationToken}` → modal: Full Licensed Name, Registered Address (`<div>` per line; line 1 = firm when there is more than one line and it is not a street), Registered Phone, Registered Email ("Not available" when withheld), Date Admitted ("November 06, 2008"), Illinois Registration Status, Malpractice Insurance statement, "Public Record of Discipline and Pending Proceedings" panel (`<p>None</p>` or entries). `GET /Lawyer/PrintableDetails/<guid>?includeFormerNames=False` returns the same content with no cookie — used as `profileUrl`.

**Verified live**
| query | result |
|---|---|
| Hughes / Benjamin | 2 rows, both details loaded: firm "Sperling Kenny Nachwalter LLC", Chicago 60654, phone, admitted 2008-11-06, Active, malpractice true, discipline none; second row Lattice Legal P.C., Warsaw IN (IL-licensed, out of state) |
| Angliss | 1 row, Hinsdale, phone, details loaded |
| Smith, statewide, authorized, grid only | total 480, 100 rows in one grid page (~400 ms) |
| Smith × Hinsdale | 0 (clean "No Data Found") |

Cold lookup with 2 details ≈ 0.6–1.1 s. Grid + session cached 6 h per query; each lawyer's details cached 24 h by GUID.

**Not verified** a lawyer with actual public discipline entries (none found in the sampled names; the "Recent Disciplinary Actions" page lists PDFs, not profile links). The discipline parser takes every `<p>/<li>/<a>` inside the panel body that is not "None" — check the first disciplined hit from Vercel and tighten if the entries are nested differently. `malpracticeInsurance=false` wording ("does not maintain…") is also inferred, not observed. `County` vs `LawyerCounty`: the form's lawyer-address county is `LawyerCounty` (used); `County` belongs to the status-change search and is sent empty.

**Quirks** ARDC states registration changes post the next business day and that addresses are withheld for retired/inactive/deceased lawyers. Phonetic match and `authorizedOnly:false` work through the same enum ints. Common surnames need `firstName`/`city` — the grid caps at 100 per page and the tool fetches page 1 only.

---

## Checks (`ERISAGENERAL_CHECKS`)
- `acebc_fellow_search {state:"IL", limit:3}` — 1 GET, <1 s.
- `leading_lawyers_search {practiceArea:"estate", city:"Hinsdale", limit:3}` — 1 POST, ~5 s cold (CF is slow; under the 10 s budget in all runs, flag if Vercel egress is slower).
- `ardc_lawyer_lookup {lastName:"Hughes", firstName:"Benjamin", includeDetails:false, limit:3}` — 3 sequential requests, ~0.6 s.

## What to check from Vercel
1. ARDC: confirm the anti-forgery cookie round-trips through Node `fetch` on Vercel (the sandbox did; `getSetCookie()` is used with a `set-cookie` fallback).
2. Leading Lawyers: cold POST latency (4–10 s here) vs the 25 s timeout; whether the CF server rate-limits the Vercel IP.
3. ACEBC: nothing special — plain GET.
