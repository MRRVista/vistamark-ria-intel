# legal-pros — Legal Professionals (Chicago-area attorneys by practice area)

Catalog id `legalpros`. Exports `LEGALPROS_TOOLS`, `LEGALPROS_DOMAIN`, `LEGALPROS_CHECKS` from `index.ts`. 11 tools, 9 keyless selftest probes (all pass cold from the sandbox in ≤ 4 s, 2026-10-24).

**Why this family exists:** Illinois attorneys are licensed by the ARDC, not IDFPR, so `idfpr_licensee_search` never returns lawyers. The ARDC registry has no practice-area field, so practice area comes from specialty-society directories (peer-elected = quality filter), Leading Lawyers (Illinois-only, peer-recommended), DOL 5500 Schedule C (who plans actually pay for legal work) and federal dockets; ARDC is the verification layer run last.

| Practice area | Tools | Builder README |
|---|---|---|
| Trusts & estates / elder | `actec_fellow_search`, `cepc_member_search`, `naela_il_search` | [README-directories-estate-family.md](README-directories-estate-family.md) |
| Family / matrimonial | `aaml_il_fellow_search`, `collaborative_divorce_il_search` | same |
| ERISA / employee benefits | `acebc_fellow_search`, `dol_sch_c_legal_counsel` (DB, code 29) | [README-directories-erisa-general.md](README-directories-erisa-general.md), [README-derived.md](README-derived.md) |
| Any | `leading_lawyers_search` (15 presets), `courtlistener_counsel` (federal RECAP; `COURTLISTENER_TOKEN` lifts the 125/day anonymous throttle) | same |
| Verification | `ardc_lawyer_lookup` — licence status, firm, admission date, malpractice flag, discipline | erisa-general README |
| Doctrine | `legal_pros_playbook` — routing per practice area + guardrails | derived README |

**Typical chain:** directory tool (name, city, practice area) → `ardc_lawyer_lookup` (firm + status; ACEBC publishes no firm/contact) → `irs990_boards_of_person` (board overlap) → `apollo_people_search` / `hunter_email_finder` → `zerobounce_validate` → `prospects_upsert` with `source:legalpros:<tool>`.

**Guardrails (in every tool note):** public directory/registry records, not consent to contact; professional/firm contact only; cite dataset + as-of date; "listed in / serves alongside" language only; draft-then-approve applies.

**Not built:** Chicago Bar Association and ISBA member directories (login-only; CEPC's full member list likewise — its public Services Directory is used instead), Illinois NAELA chapter site (unreachable; national NAELA search covers it), Cook/DuPage circuit-clerk dockets (no API; paid feeds such as UniCourt would be the programmatic path), Avvo/Martindale/Super Lawyers (ToS).

**Sandbox quirks worth knowing from Vercel:** collaborativedivorceillinois.org serves a SiteGround captcha page to non-proxied egress (handler detects and throws — confirm Vercel's IP gets 200); NAELA is an iMIS viewstate postback with a mandatory session cookie; Leading Lawyers is a ColdFusion POST that 500s unless every form field is sent (4–10 s cold, cached 12 h); ARDC is a 4-step anti-forgery flow (search → PageKey → grid → details) and was fully reachable; CourtListener anonymous calls 429 on shared egress.

---

# ⤷ README-directories-estate-family.md

## legal-pros · directories-estate-family

Module: `lib/legal-pros/directories-estate-family.ts`
Exports: `DIRECTORIES_ESTATE_FAMILY_TOOLS`, `DIRECTORIES_ESTATE_FAMILY_CATALOG`, `DIRECTORIES_ESTATE_FAMILY_CHECKS`
(+ handlers `actecFellowSearch`, `aamlIlFellowSearch`, `collaborativeDivorceIlSearch`, `cepcMemberSearch`, `naelaIlSearch`,
constants `ACTEC_PRACTICE_AREAS`, `CDI_ROLES`, `CEPC_CATEGORIES`).

All five tools are keyless and read public directory listings. Verified live from the sandbox on **2026-10-24**
with a `.mts` smoke script (`npx tsx`), after discovering each site's request shape with `curl` and its own JS.

Shared output shape: `{ dataSource, asOf, returned, total, …filters, rows[], note }`; each row
`name, firm, city, state, zip, practiceAreas[], phone?, email?, website?, profileUrl, source, extras{}`.
Every result's `note` ends with the guardrail (public listings ≠ consent to contact; professional/firm contact only;
cite dataset + as-of; "listed in / serves alongside" language). Default `limit` 25, max 100 (NAELA max 60).

### Sandbox network note (affects CDI and the checks)

Node's `fetch` from the sandbox egresses directly (`34.56.135.7`) while `curl` honours `HTTPS_PROXY`
(`160.79.106.x`). Collaborative Divorce Illinois' host (SiteGround "sgcaptcha" shield) blocks the direct Node IP
with an HTTP 202 captcha interstitial but accepts the proxy IP; the other four hosts accept both. The smoke run
therefore used `NODE_USE_ENV_PROXY=1 npx tsx …` for CDI/CEPC/NAELA. From Vercel this is moot (ordinary egress).

---

### actec_fellow_search — ACTEC Fellows (trusts & estates)

**Endpoint**: `GET https://www.actec.org/wp-json/mg/v1/directory` (WordPress REST route from the `mg-starter` theme;
backed by a Lucene-style search index). Companion `GET /wp-json/mg/v1/directory-facets` only returns the
`address_country` facet (28 values) — it is not needed and not called.

**Parameters** (read from `main.0553802f.js`, the directory Pinia store `fetchContent`):

| param | notes |
|---|---|
| `query` | Lucene clauses joined with ` AND `. Field names: `address_state` (full name, e.g. `"Illinois"`; `"IL"` → 0), `address_city` (phrase; server rewrites to `search_city`), `address_zip` (`60521` exact or `6052*` prefix), `last_name` / `first_name` (`Smith*` prefix or `"Smith"` phrase; server rewrites to `search_last`), `organization` (prefix `ArentFox*`; phrase works; case-insensitive), `practice_areas:("A" OR "B")`, `membership_type:"Fellow"`. Empty query = `*`. |
| `page` | 1-based; default page size 10 |
| `showall=true` | page size becomes 300 (whole result set for IL) — we always send it |
| `zip` + `radius` | miles; distance-sorted; replaces the `address_zip` clause |
| `mode` | `list` (default) or `map` (different shape — not used) |
| `_wpnonce` | sent by the site's JS but **not required** (verified: all calls succeed without it) |

The server always appends `AND (address_type:work1 OR address_type:work2) AND NOT address_type:home…` so only
work addresses come back. Response: `{ hits, lastPage, pageSize, currentPage, result: [ {title, first_name, last_name,
organization, address_city, address_state, address_zip, address_line1/2, phones, email, website, url, practice_areas
("A|B|C"), membership_type, is_fellow ("True"/"False"), year_elected, law_schools, practice_jurisdictions, …} ] }`.
Spouse/birth-year fields exist upstream and are deliberately **not** surfaced.

**Verified live 2026-10-24**: nationwide `hits` 2,177; `address_state:"Illinois"` → 97 (90 `membership_type` Fellow,
2 Elected Fellow Fall, 2 Retired, 2 Academic, 1 Honorary); IL + Chicago → 75; `address_zip:6052*` → 2 (Oak Brook,
Hinsdale); `zip=60521&radius=15` → 4; `radius=25` → 82; `last_name:Lord*` → 1; `organization:arentfox*` → 10;
`practice_areas:"Fiduciary Litigation"` + IL → 15. Vistamark UA accepted (200). Latency 0.5–1.1 s. Cached 12 h.

**Tool behaviour**: `state` default Illinois (2-letter codes mapped to full names; `ANY` for nationwide but then
city/zip/lastName/firm is required); `fellowsOnly` (default true) hides retired/honorary/academic rows locally and
says so in `note`; refuses an empty filter set.

**Not verified / check from Vercel**: nothing blocking. `hits` > 300 would be truncated (only possible for
nationwide queries — the note says to narrow).

---

### aaml_il_fellow_search — AAML Illinois Chapter Fellows (family / matrimonial)

**Endpoint**: `GET https://api.membershipworks.com/v2/directory?_rf=Members&ord=lnm` with header **`X-Org: 35637`**
(the `data-org` attribute on `https://aaml-illinois.org/find-a-lawyer/`'s `#SFctr` widget div, embedded via
`https://cdn.membershipworks.com/mfm.js`). Without `X-Org` the API answers 400. `Source-Url` header is optional.
Extra params the widget supports: `tag=<text>` (name/keyword search, verified `tag=Ventrelli` → 1), and
`adr[rad]=<miles>&adr[ad2]=<zip>` for radius search (not used — roster is small enough to filter locally).

Response: `{ typ:"a", usr:[ {uid, nam, biz, phn:[…], web, adr:{ad1, ad2?, cit, cot (county), sta, zip, con, loc}, lgo} ], _st:{…} }`.
Profiles have no email field. Profile deep link: `https://aaml-illinois.org/find-a-lawyer/#!biz/id/<uid>`.

**Verified live 2026-10-24**: 89 fellows; Chicago 57; zip prefix `605` → 5; `name:"Ventrelli"` → 1. Vistamark UA 200.
~250 ms. The whole roster is cached 12 h and filtered locally (city exact, zip prefix, county/firm substring, name words).

**Not verified**: `_st` contains a Google Maps key and card template — ignored. If AAML-IL changes platform the
`usr` check throws a clear error.

---

### collaborative_divorce_il_search — Collaborative Divorce Illinois roster

**Endpoint**: GravityView REST (WordPress) on view **261** ("Members – Full List (Public)", Gravity Forms form 2):

* list: `GET https://collaborativedivorceillinois.org/wp-json/gravityview/v1/views/261/entries.html?limit=200&mode=all[&filter_11=<Role>][&filter_6_3=<City>][&gv_search=<text>]`
  — returns a JSON-encoded HTML string containing `<meta http-equiv="X-Item-Total" content="N">` and one
  `<div id="gv_list_<entryId>" class="gv-list-view">` per member (name in `.profileListName`, roles as `<li>`).
  `entries.json` exists too but only exposes name + role fields (`"1"` name parts, `"11"` role checkboxes), so the
  HTML variant is used to get entry ids.
* detail: `GET …/views/261/entries/<id>.json` → `{ custom: "<strong>Phone:</strong> … <strong>Email:</strong> …",
  "6": {"6.1" street, "6.3" city, "6.4" state, "6.5" zip}, "custom(2)": website anchor, "custom(3)": bio HTML }`.

Filters discovered from the search widget: `filter_11` = Practice Areas select (`Attorney`, `Coach`, `Financial
Specialist`, `Child Specialist`, `New Collaborator/Recent Law School Graduate`, `Affiliate`), `filter_6_3` = City
text, `gv_search` = full-text (matches name, firm, address, zip, bio). **`mode=all` is required** for `filter_*` to be
honoured on the REST route (without it the server ignores them and returns all 127).

**Verified live 2026-10-24** (through the proxy IP): total 127; Attorney 97; Attorney+Chicago 33; Attorney+Hinsdale 1;
Financial Specialist 13; `gv_search=Krolikowska` 1; `gv_search=60062` 2. Detail fetch ~0.9 s each, run 6-wide
(`detailLimit` default min(limit,25), max 40). Cached 12 h (list) / 24 h (entry).

**Quirks**: browser-like UAs (`Mozilla/5.0 … Chrome/124`) got HTTP/2 PROTOCOL_ERROR / connection reset from the
shield on this network; the plain Vistamark UA (politeFetch default) is what works — do **not** pass `BROWSER_UA`.
The direct sandbox Node IP gets the `sgcaptcha` 202 page; the handler detects it and throws an actionable error.
Firm is not a structured field — the detail bio's first `<strong>` is used as a hint only when it is not the
person's own name (so `firm` is frequently null; website/email domain is the better firm signal).

**Check from Vercel**: that Vercel's egress is not on the shield's block list (expect 200; if 202 captcha, the
fallback is to open `profileUrl`s manually).

---

### cepc_member_search — Chicago Estate Planning Council public Services Directory

CEPC's **member directory is login-only** (`/members/directory` → "You must be logged in"). The public, opt-in
**Services Directory** is what this tool reads (NAEPC council-site platform, server-rendered HTML):

* category list: `GET https://www.cepcweb.org/council/services-directory/<catId>[/<zip5>]` —
  `#serviceDirectoryListings` with `<h4>Featured Listings</h4>` / `<h4>Additional Listings</h4>` and
  `<div class="serviceDirectoryListing clear"><strong><a href="/council/services-directory/member/<id>">Name[, Title]</a></strong><br /> Firm</div>`.
  The zip filter is an exact 5-digit path segment (the page's JS does `location = '/council/services-directory/17/' + zip`);
  no prefix/radius; no match → "There are currently no listings for this category."
* member page: `GET /council/services-directory/member/<id>` — name, firm, address block, `Phone: … Fax: …`,
  `Website: <a href="…">`. Email is behind a "Send a Message" iframe form and is **not** exposed (by design).

Category ids (from the index page): Attorney at Law 17 · Estate Planning & Administration 18 · Trust & Estate
Administration 19 · Wealth Management Services 20 · Elderly & Disability Services 21 · Life Insurance 22 ·
Charitable Giving 23 · Federal & State Tax Litigation 41 · Retirement Plan Admin. & Consulting 52 · Retirement Services 53 ·
Accounting & Tax Preparation 15 · Appraisers & Valuation 16.

**Verified live 2026-10-24**: Attorney at Law 140 listings (3 featured); zip 60606 → 47; zip 60521 → 0 (empty-state
parsed correctly); Wealth Management + firm "Northern" → 18 before firm filter / 3 shown; member page detail
(address → city/state/zip, phone, website) parsed for 3 rows in ~2.5 s total. Vistamark UA 200. Cached 12 h / 24 h.

**Tool behaviour**: `details` default **false** (one request per row); `name` word match and `firm` substring are local.
`city` is unknown without details (shown as "Chicago area" or null when a zip was given).

---

### naela_il_search — NAELA Find a Lawyer (elder law / special needs)

NAELA runs iMIS (ASP.NET WebForms). Public "Basic Search" at
`https://www.naela.org/Web/Shared_Content/Directories/Find-a-Lawyer.aspx` is a distance search from a zip.

**Request shape** (discovered by reading the form and iterating with curl):

1. `GET` the page → capture **Set-Cookie** (`ASP.NET_SessionId`, `__RequestVerificationToken`, `__cf_bm`…) and the
   hidden `__*` inputs (`__VIEWSTATE`, `__RequestVerificationToken`, `__WPPS`, `__CTRLKEY`, `__SHIFTKEY`).
2. `POST` same URL, `application/x-www-form-urlencoded`, with those hidden fields plus
   `…$Sheet0$Input0$TextBox1=<zip>` (Zip Code), `…$Sheet0$Input1$DropDown1=<miles>` (Distance: 1/5/10/15/25/50/100;
   we send 100 and filter locally), `…$Sheet0$Input3$TextBox1=<zip>` (**"StartZip Equals" — also required**, else
   "You must enter a valid value for all required filters"), `…$Sheet0$SubmitButton=Find`.
   Prefix: `ctl01$TemplateBody$WebPartManager1$gwpciDirectoryCCO$ciDirectoryCCO$DistanceQueryMenu$ResultsGrid$`.
   The other visible controls (site search box, "ZipCode Equals" listbox) can be omitted. **Cookies are mandatory**:
   without the session cookie the POST answers 302 to the same page with no results.
3. Paging: re-POST the new page's hidden `__*` fields plus `…$Grid1$ctl00$ctl03$ctl01$ctl28= ` ("Next Page" submit).
   `__EVENTTARGET=…ctl09` etc. (Go to Page N) also works. Page size is 20 (the RadComboBox page-size change via
   `__EVENTTARGET`/ClientState did **not** take effect — stays 20). We fetch up to 3 pages (60 nearest).

**Result rows**: `<div class="jcFALRow …">` with `class="H4"` name link to `/Shared_Content/Directories/Profile.aspx?id=N`,
`LocRight` "City, ST" + `Proximity` "N miles away", `Member Since`, `Experienced in N Practice Areas`, `tel:` link,
and a `Contact Information` block (firm, street, "City, ST zip", phone). Note Telerik emits `<div  class="H4">`
with two spaces — regexes are attribute-loose. Practice-area names and "Licensed In" are filled client-side
(`<span id="<id>lst">`) and are **not** available; `practiceAreaCount` is surfaced instead. Footer reports
`4001 items in 201 pages` = the whole NAELA membership sorted by distance, so `total` in our output is the local
match count and `naelaMembersNationwide` carries 4001.

**Verified live 2026-10-24**: 60521 → page 1 = 20 rows (3.3 mi Countryside → 127 mi Muskegon), 11 within 25 mi in IL;
60603 two pages = 40 rows; Next-Page and Go-to-Page-3 postbacks returned pages 2/3 with increasing distances;
`name:"Wilson"` local filter → 1. 2.5–4.6 s per call (GET + 1–3 POSTs). Vistamark UA accepted. Cached 6 h per (zip, pages).

**Fragility / check from Vercel**: ASP.NET viewstate + cookies + Cloudflare `__cf_bm` — the most likely of the five
to break. The handler uses `politeFetch` directly for the POST (`redirect:"manual"`, `retries:0`) and reads
`Headers.getSetCookie()` (Node 18.14+/20+; fine on Vercel Node 20/22). If Vercel's IP triggers a Cloudflare
challenge the GET will have no `__VIEWSTATE` and the tool throws "landing page had no __VIEWSTATE". Excluded from
`_CHECKS` for that reason and because it runs 3–6 s cold.

---

### Dropped / not built

* **CEPC full member directory** — login-only; only the public Services Directory is read (see above).
* **ilnaela.org** (Illinois NAELA chapter) — `CONNECT … 502` from the sandbox proxy (host unreachable/blocked here);
  national NAELA search covers Illinois members with a Chapter field on profiles, so not needed.
* ACTEC `directory-facets` — only `address_country`; practice-area list was derived from the IL result set instead
  and hard-coded as `ACTEC_PRACTICE_AREAS` (18 values).

### Checks exported (`DIRECTORIES_ESTATE_FAMILY_CHECKS`)

| name | tool | args | cold time seen |
|---|---|---|---|
| legalpros: ACTEC Illinois fellows (Hinsdale/Oak Brook zips) | actec_fellow_search | `{zip:"6052",limit:3}` | ~1 s |
| legalpros: AAML Illinois fellows in Chicago | aaml_il_fellow_search | `{city:"Chicago",limit:3}` | ~0.3 s |
| legalpros: Collaborative Divorce IL attorneys (list only) | collaborative_divorce_il_search | `{role:"Attorney",city:"Hinsdale",details:false,limit:3}` | ~2.5 s (proxy IP) |
| legalpros: CEPC services directory attorneys 60606 | cepc_member_search | `{zip:"60606",limit:3}` | ~1.2 s |

`naela_il_search` intentionally omitted from the checks.

# ⤷ README-directories-erisa-general.md

## legal-pros · directories-erisa-general

Module: `lib/legal-pros/directories-erisa-general.ts`
Exports: `ERISAGENERAL_TOOLS`, `ERISAGENERAL_CATALOG`, `ERISAGENERAL_CHECKS`, handlers `acebcFellowSearch`, `leadingLawyersSearch`, `ardcLawyerLookup`, preset map `LL_PRESETS`.

All three tools are keyless, live HTML scrapes (regex + `stripTags`, no cheerio), fetched with `BROWSER_UA`, cached 6–24 h via `cached()`. Every response is `{ dataSource, asOf, query, returned, total, rows, note }`. Results are public directory/registry records, not consent to contact; only professional/firm contact details are returned.

Live verification date: **2026-10-24** from the sandbox (proxy egress). All three hosts answered 200 to both the Vistamark UA and the browser UA; no Akamai/Cloudflare challenge, no 429s seen across ~40 requests.

---

### `acebc_fellow_search` — American College of Employee Benefits Counsel

**Endpoint** `GET https://www.acebc.com/fellows?fullname=<name>&state=<ST>&topics=<1-12>&is_expert_witness=1&is_mediator=1&is_speaker=1&search-submit=Search`
(the `search-submit` param is what distinguishes a search from the empty landing page — without it the page returns the blank form). No auth. The all-fellows roll is also at `/employee-benefits-attorneys` (583 rows) but the tool refuses unfiltered calls.

**Result structure** `<table id="search-results">`; per `<tr>`: `td.column1` = `<a href="https://www.acebc.com/profiles/<slug>">Last, First M.</a>` + `<span>` status badges (H Honorary, CF Charter, F Fellow, E Emeritus, D Deceased, M In Memoriam); `td.column2` = `City, ST`; `td.column3` = `Topic | Expert Witness | Mediator | Speaker<br />…` (self-designated). No paging. Profile pages carry only `<h1>Name</h1><h2>City, ST</h2>` + bio — **no firm, phone or email is published**; chain to `ardc_lawyer_lookup` for the registered firm.

**Topic ids** 1 DB Plans · 2 DC Plans · 3 IRAs · 4 Exempt/Governmental · 5 Multiemployer · 6 Health & Welfare · 7 Fiduciary/Other Title I · 8 IRC · 9 PBGC · 10 Executive Compensation · 11 Fringe Benefits · 12 Actuarial.

**Verified live** `{state:"IL"}` → 36 upstream rows, 34 after dropping Deceased/In Memoriam (default); `{state:"IL", city:"Chicago", topic:"DC Plans"}` → 3; `{name:"Adams"}` → 2 (nationwide). ~250–600 ms. Row ≈ 250 chars; 50 rows ≈ 8.6 K chars — keep `limit` ≤ 25 for Randall.

**Quirks** city filter is client-side (upstream has no city field). Names are reordered from "Last, First" to "First Last"; `lastName` is kept internally for ARDC chaining.

---

### `leading_lawyers_search` — Leading Lawyers (leadinglawyers.com)

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

### `ardc_lawyer_lookup` — Illinois ARDC Lawyer Search (iardc.org)

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

### Checks (`ERISAGENERAL_CHECKS`)
- `acebc_fellow_search {state:"IL", limit:3}` — 1 GET, <1 s.
- `leading_lawyers_search {practiceArea:"estate", city:"Hinsdale", limit:3}` — 1 POST, ~5 s cold (CF is slow; under the 10 s budget in all runs, flag if Vercel egress is slower).
- `ardc_lawyer_lookup {lastName:"Hughes", firstName:"Benjamin", includeDetails:false, limit:3}` — 3 sequential requests, ~0.6 s.

### What to check from Vercel
1. ARDC: confirm the anti-forgery cookie round-trips through Node `fetch` on Vercel (the sandbox did; `getSetCookie()` is used with a `set-cookie` fallback).
2. Leading Lawyers: cold POST latency (4–10 s here) vs the 25 s timeout; whether the CF server rate-limits the Vercel IP.
3. ACEBC: nothing special — plain GET.

# ⤷ README-derived.md

## legal-pros / derived.ts

Three tools: a Postgres rollup of Schedule C legal providers, a CourtListener RECAP
counsel search, and the family's static routing doctrine. Exports
`DERIVED_TOOLS`, `DERIVED_CATALOG`, `DERIVED_CHECKS`; handlers `dolSchCLegalCounsel`,
`courtlistenerCounsel`, `legalProsPlaybook` are also exported for direct use.

Verified from the sandbox on 2026-10-24 (see per-tool notes; `npx tsc --noEmit` clean).

---

### dol_sch_c_legal_counsel  (backing: postgres)

**What it is.** Firms coded **29 = Legal** on Form 5500 Schedule C Part I Item 2
(providers paid $5,000+ by a plan), grouped by `provider_name_norm` + `provider_ein`,
with distinct-plan count, distinct-sponsor count, total comp, total plan assets, filing
year span and the top 3 sponsors (by plan assets) per firm.

**Tables / joins.** `dol_sch_c_providers p` (migration 0009) `LEFT JOIN plans pl`
(0002; `JOIN` when `sponsorState` is given) `LEFT JOIN dol_sch_h_i shi` (0010, only
when `schHTableExists()`), i.e. the same `assetsJoin` shape as
`lib/filings-people/schedule-c.ts`. Assets = `COALESCE(pl.tot_assets_eoy_amt,
shi.tot_assets_eoy_amt)` because DOL dropped the F_5500 total in the 2024 files.
`normalizeProviderName` and `SCH_C_ROLE_CODES.legal` are imported from
`schedule-c-parse.ts`; `assetsJoin` / `missingTable` / `emptyResponse` are private in
schedule-c.ts so small copies live in derived.ts.

**SQL shape.** A `per_plan` CTE collapses to one row per (norm, ein, ack_id) first (a
firm listed twice on one Schedule C — direct + indirect lines — would otherwise
double-count plan assets), then the outer query aggregates per firm with
`mode() WITHIN GROUP` for the display name/city/state, `COUNT(*) OVER ()` for `total`,
`HAVING COUNT(*) >= minPlans`, `LIMIT/OFFSET`. A second query ranks sponsors with
`ROW_NUMBER() OVER (PARTITION BY norm, ein ORDER BY assets DESC NULLS LAST ...)` and
keeps `rn <= 3`. Code match is the same whole-token regex as `roleCondition`:
`p.service_codes ~ '(^|,)(29)(,|$)'`.

**Args.** `state` (firm's state as filed; default `IL`; `ANY`/`ALL` to drop), `city`
(ILIKE exact), `sponsorState` (plan sponsor mail state; forces inner join to plans),
`filingYear`, `minPlans` (default 1), `nameContains` (normalized LIKE on
`provider_name_norm`), `providerEin`, `sortBy` plans|comp|assets, `limit` ≤100
(default 25), `offset`. An unbounded call (`state:'ANY'` with no other filter) returns
`{error}`.

**Empty / missing handling.** `DATABASE_URL` unset → `{empty:true, note}` with the
ingest hint. Relation missing (42P01) → same shape. Table present but no rows → same
shape ("ingest has not run"). Rows present but no match → `returned:0, total:0, note`.

**Verified 2026-10-24.** `DATABASE_URL` is NOT set in the sandbox, so the SQL was run
against a throwaway local **Postgres 16** (`/usr/lib/postgresql/16/bin`, port 54329)
with `pg_trgm`, migrations 0002 + 0009 + 0010 applied verbatim, and 8 synthetic
Schedule C rows across 4 plans (`DATABASE_DRIVER=pg`). Confirmed: grouping merges
"Seyfarth Shaw LLP" / "SEYFARTH SHAW, LLP" under one (norm, ein) while the EIN-less
"Seyfarth Shaw" stays a separate row (by design — EIN is part of the key); the two
Seyfarth lines on plan A1 count as 1 plan with comp summed (45,000) and assets counted
once; non-legal providers (Fidelity, codes 15,64) are excluded; a provider coded `29,16`
matches; `sponsorState:'WI'` returns only the WI-sponsored plan; `nameContains` with
suffixes ("Seyfarth Shaw LLP") normalizes to `SEYFARTH SHAW`; a plan with no Schedule H
row yields `totalPlanAssetsUsd:null, plansWithAssets:0`; the `plans.spons_dfe_name IS
NULL` fallback to `plan_name` works; no-match returns `returned:0`; `DATABASE_URL`
unset returns `empty:true`.

**Not verified.** Neon HTTP driver behaviour for the CTE + `mode()` + window query
(drizzle `sql` raw, single statement, no transaction — same pattern as schedule-c.ts, so
expected fine). Real-data performance: the per_plan CTE scans all code-29 rows for the
state; `dol_sch_c_name_norm_idx` / `dol_sch_c_year_idx` help, `service_codes ~` does not
use an index. ~265k Schedule C rows/year of which Legal is a small slice, so should be
sub-second; check from Vercel once refresh-dol-sch-c has run (`/api/selftest` check
"legalpros: Sch C legal counsel IL"). Note `plans.spons_dfe_name` is null in current
ingests (DOL renamed the column) — the tool falls back to `plan_name`, which usually
embeds the sponsor.

---

### courtlistener_counsel  (backing: live-api)

**Endpoint.** `GET https://www.courtlistener.com/api/rest/v4/search/` with
`type=r` (RECAP federal dockets), `order_by=dateFiled desc`, `court` (default `ilnd`),
`q`, optional `filed_after` / `filed_before`, and the front-end sidebar filters
`atty_name` / `party_name` (the operators page says `party:` / `attorney:` inside `q`
must not be mixed with document fields, and that the sidebar filters are the supported
route; the API "uses the same GET parameters as the front end"). Auth: anonymous or
`Authorization: Token $COURTLISTENER_TOKEN`. Cached 1 h (`cached()`), one paced 429
retry via `jsonWithBackoff`.

**Presets.** `erisa` → `q=(suitNature:791 OR "ERISA")` (PACER nature-of-suit 791 =
Labor: E.R.I.S.A.); `probate_trust` → trustee / breach of trust / probate AND estate|trust;
`family` → divorce / dissolution / custody / marital settlement / domestic relations;
`custom` → `q` only. A free `q` is ANDed with the preset. At least one of preset / q /
attorney / party is required.

**Response mapping (field names as documented on
courtlistener.com/help/api/rest/search and help/search-operators).** Per result:
`caseName`, `court_id` (fallback `court`), `dateFiled`, `dateTerminated`,
`docketNumber`, `suitNature`, `cause`, `assignedTo`, `party[]`, `attorney[]`, `firm[]`,
`docket_absolute_url` (fallback `absolute_url`), `recap_documents[0].description|snippet`.
`party`/`attorney`/`firm` are docket-level multi-value fields; the handler accepts either
arrays or `;`-joined strings and tallies them into `topAttorneys` / `topFirms` across the
returned dockets. `count` → `totalMatches` (±6 % above 2,000 per docs).

**Verified 2026-10-24.** Two anonymous calls succeeded between throttle windows
(`preset:'erisa', court:'ilnd'`): HTTP 200, `count` 32,132, 20 results/page, newest
dockets 2026-10-20 / 2026-10-19 (Fox Valley Laborers H&W Fund v. Seyller's; Chicago &
Vicinity Laborers' Pension Fund v. Paving Zone). Actual `type=r` result keys observed:
`assignedTo, assigned_to_id, attorney, attorney_id, caseName, case_name_full, cause,
chapter, court, court_citation_string, court_id, dateArgued, dateFiled, dateTerminated,
docketNumber, docket_absolute_url, docket_id, firm, firm_id, jurisdictionType,
juryDemand, meta, pacer_case_id, party, party_id, recap_documents, referredTo,
referred_to_id, suitNature, trustee_str`; `recap_documents[]` carries `description,
short_description, snippet, entry_date_filed, document_number, absolute_url, ...`.
`party`, `attorney`, `firm` are **arrays of plain strings** (e.g. Rusbuldt v. Mondelez
Global LLC → `attorney: ["Mason A Barney"]`, `firm: ["Siri & Glimstad LLP"]`), with
parallel `*_id` arrays. On a fresh 20-docket page only 1 docket had attorney/firm and 3
had `suitNature` (RECAP often has only the case header for new filings), so
`topAttorneys` / `topFirms` are sparse unless `filedBefore` pushes to older dockets.
Most other attempts in the session answered **HTTP 429 "Request was throttled. Rate
limit exceeded: 125/day. Expected available in N seconds"** — the sandbox shares an IP.
The error surfaces as `CourtListener rate-limited (HTTP 429) after retry — anonymous
access is throttled per IP ...; set COURTLISTENER_TOKEN`.

**Not verified.** (1) That `atty_name` / `party_name` are honoured by the API endpoint
(they are the front-end form names; the search-API doc says to copy front-end GET
params; the operators page says sidebar filters, not `attorney:` in `q`, are the
supported route). From Vercel: set `COURTLISTENER_TOKEN`, call `{attorney:'Seyfarth'}`
and confirm results narrow. (2) `probate_trust` / `family` presets were not exercised
live (quota) — same endpoint, only `q` differs. (3) The wiki page https://wiki.free.law/c/courtlistener/help/api/rest/v4/search
could not be fetched from the sandbox (fetch permission not granted); the equivalent
pages on courtlistener.com/help/ were used instead.

**Coverage caveat baked into descriptions/notes.** Illinois circuit courts (Cook County
Probate, Domestic Relations, Chancery) are not on CourtListener, so `probate_trust` and
`family` return federal spill-over only; the directory tools are the discovery path for
those practice areas.

---

### legal_pros_playbook  (no network)

Static object: purpose, licensing note (attorneys are not in IDFPR; ARDC licenses them;
`ardc_lawyer_lookup` is verification, run last), routing per practice area (ERISA →
`dol_sch_c_legal_counsel` + `acebc_fellow_search` + `leading_lawyers_search` +
`courtlistener_counsel erisa`; T&E → `actec_fellow_search` + Leading Lawyers + CEPC/NAELA
if present; family → `aaml_il_fellow_search` + `collaborative_divorce_il_search`; other →
`courtlistener_counsel` custom), data notes (Schedule C $5k threshold and free-text names,
CourtListener state-court gap, anonymous throttle), six guardrails (public records ≠
consent; professional contact only; cite dataset + as-of; ARDC before outreach; referral
marketing not advice, routed through outreach guardrails; respect directory terms / no bulk
dumps), and a 5-step workflow. Optional `practiceArea` narrows `routing` by keyword
(erisa|benefit|401|pension → ERISA; estate|trust|probate|elder → T&E; family|divorce|
matrimon|custod → family; else other). Verified: `{practiceArea:'divorce'}` returns the
single family route and 6 guardrails.

---

### Checks (`DERIVED_CHECKS`)

- `legalpros: playbook (static)` — no network.
- `legalpros: Sch C legal counsel IL (tolerates empty/missing table)` — `{state:'IL',
  limit:3}`; `empty:true` until the ingest runs.

`courtlistener_counsel` is deliberately **not** in the checks: the host throttles the
shared IP and the check would burn the 125/day anonymous budget.

### Catalog notes

`DERIVED_CATALOG` marks `dol_sch_c_legal_counsel` as `postgres`, the other two as
`live-api` (the playbook has no backing; `live-api` is the closest allowed `ToolBacking`
and the note says "static doctrine, no network").
