# legal-pros · directories-estate-family

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

## Sandbox network note (affects CDI and the checks)

Node's `fetch` from the sandbox egresses directly (`34.56.135.7`) while `curl` honours `HTTPS_PROXY`
(`160.79.106.x`). Collaborative Divorce Illinois' host (SiteGround "sgcaptcha" shield) blocks the direct Node IP
with an HTTP 202 captcha interstitial but accepts the proxy IP; the other four hosts accept both. The smoke run
therefore used `NODE_USE_ENV_PROXY=1 npx tsx …` for CDI/CEPC/NAELA. From Vercel this is moot (ordinary egress).

---

## actec_fellow_search — ACTEC Fellows (trusts & estates)

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

## aaml_il_fellow_search — AAML Illinois Chapter Fellows (family / matrimonial)

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

## collaborative_divorce_il_search — Collaborative Divorce Illinois roster

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

## cepc_member_search — Chicago Estate Planning Council public Services Directory

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

## naela_il_search — NAELA Find a Lawyer (elder law / special needs)

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

## Dropped / not built

* **CEPC full member directory** — login-only; only the public Services Directory is read (see above).
* **ilnaela.org** (Illinois NAELA chapter) — `CONNECT … 502` from the sandbox proxy (host unreachable/blocked here);
  national NAELA search covers Illinois members with a Chapter field on profiles, so not needed.
* ACTEC `directory-facets` — only `address_country`; practice-area list was derived from the IL result set instead
  and hard-coded as `ACTEC_PRACTICE_AREAS` (18 values).

## Checks exported (`DIRECTORIES_ESTATE_FAMILY_CHECKS`)

| name | tool | args | cold time seen |
|---|---|---|---|
| legalpros: ACTEC Illinois fellows (Hinsdale/Oak Brook zips) | actec_fellow_search | `{zip:"6052",limit:3}` | ~1 s |
| legalpros: AAML Illinois fellows in Chicago | aaml_il_fellow_search | `{city:"Chicago",limit:3}` | ~0.3 s |
| legalpros: Collaborative Divorce IL attorneys (list only) | collaborative_divorce_il_search | `{role:"Attorney",city:"Hinsdale",details:false,limit:3}` | ~2.5 s (proxy IP) |
| legalpros: CEPC services directory attorneys 60606 | cepc_member_search | `{zip:"60606",limit:3}` | ~1.2 s |

`naela_il_search` intentionally omitted from the checks.
