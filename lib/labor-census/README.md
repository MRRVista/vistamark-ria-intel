# Labor & Demographics family (`lib/labor-census/`)

BLS and Census sources for territory context around Hinsdale (ZCTA 60521), DuPage County (17043) and Cook County (17031). Catalog id `laborcensus`.

| Tool | Upstream (verified live 2026-10-22) | Auth | Cache |
|---|---|---|---|
| `bls_series` | `POST https://api.bls.gov/publicAPI/v2/timeseries/data/` → `v1/timeseries/data/` → `GET v2/timeseries/data/<id>?startyear&endyear` | keyless; `BLS_API_KEY` optional | 1h |
| `bls_popular` | `GET https://api.bls.gov/publicAPI/v2/timeseries/popular[?survey=LA]` + static alias map | keyless | 24h |
| `bls_qcew_county` | `https://data.bls.gov/cew/data/api/<year>/<1-4|a>/area/<FIPS>.csv`, `…/cew/doc/titles/industry/industry_titles.csv`, `…/area/area_titles.csv` | keyless | 24h / 7d |
| `census_acs_profile` | `https://api.census.gov/data/<year>/acs/acs5/profile?get=…&for=…&in=…&key=…` | **`CENSUS_API_KEY` required** | 7d |
| `census_acs_variable` | `https://api.census.gov/data/<year>/acs/acs5[/profile|/subject|/cprofile]?…` + `…/variables/<VAR>.json` | key required (labels keyless) | 7d |
| `census_cbp` | `https://api.census.gov/data/<year>/cbp?get=NAME,NAICS2017_LABEL,ESTAB,EMP,PAYANN&for=county:043&in=state:17&NAICS2017=52&LFO=001&EMPSZES=001&key=…` | key required | 7d |
| `census_geocode` | `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=…&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json` (and `/coordinates?x=&y=`) | keyless | 7d |

## Env vars
- `BLS_API_KEY` (optional) — free at https://data.bls.gov/registrationEngine/. Raises v2 to 500 queries/day, 20 years, 50 series/query and enables `catalog:true` titles.
- `CENSUS_API_KEY` (**required** for the three Census data tools) — free and instant at https://api.census.gov/data/key_signup.html. The tools throw `CENSUS_API_KEY not configured — …` before any network call when it is missing.

## BLS timeseries notes
- Quotas are per egress IP: v2 keyless and v1 each allow 25 queries/day, 10 years, 25 series. From this sandbox the v2 POST counter was already tripped on first use ("daily threshold … reached") because the IP is shared; v1 POST tripped shortly after. Single-series `GET v2/timeseries/data/<id>` kept answering, so the loader cascades v2-keyed/keyless POST → v1 POST → per-series GET and reports which path served (`source`). Vercel's shared egress will behave the same way; set `BLS_API_KEY` in production.
- `years` is capped at 10 (BLS silently truncates). Annual-average rows (M13, Q05) are dropped before change math. `preliminary:true` mirrors footnote code P (LAUS county/state latest months).
- Alias ids verified live: LNS14000000, LNS13327709, LNS11300000, LNS12300000, CES0000000001, CES0500000001, CES5500000001, CES0500000003, CES0500000011, CES0500000002, CUUR0000SA0, CUSR0000SA0, CUUR0000SA0L1E, CUSR0000SA0L1E, CUUR0000SA0E, CUUR0000SEHA, CUURS23ASA0, WPSFD4, WPUFD4, EIUIR, JTS000000000000000JOL/QUR/HIR, CIU1010000000000A, CIU2010000000000A, PRS85006092, PRS85006112, LASST170000000000003, LAUMT171698000000003, LAUCN170430000000003, LAUCN170310000000003.
- `popular` endpoint returns ids only (no titles) — the built-in alias map carries titles/units.

## QCEW notes
- A county slice is ~350 KB / ~2,000 rows (every ownership × NAICS level × size class). Only `size_code 0` rows are used. State slices (`17000`) are ~2,700 rows and include 6-digit NAICS; small counties suppress many 6-digit cells (`disclosure_code N` → `suppressed:true`, zeros).
- Newest quarter is found by probing back from the quarter before the current one (2026 Q1 was newest on 2026-10-22; 2026 Q2 404s). Annual averages: 2025 available. Each row carries BLS's own over-the-year changes (`oty_*`), surfaced as `yoy`.
- QCEW is on **NAICS 2022**: investment advice is `523940` (CBP, still on NAICS 2017, uses `523930`). `5239` "other financial investment activities" is the stable RIA/family-office bucket in both.
- `area_titles.csv` header is `area_fips` (not `area_code`).

## Census notes
- **Keyless access is gone.** Every data request without `key=` 302-redirects to `https://api.census.gov/data/missing_key.html` (HTTP 200, text/html, title "Missing Key"); a bad key redirects to an "Invalid Key" page. The loader follows redirects, detects the HTML and throws a clear error. Metadata (`variables.json`, `geography.json`, `/variables/<VAR>.json`, `data.json`) and the Geocoder remain keyless and were verified live.
- Vintages present in `data.json` on 2026-10-22: `acs/acs5/profile` 2015–2024 (2024 is newest), `cbp` 2014–2023, `zbp` only through 2018 (ZIP-level CBP lives inside `cbp` via `for=zip code:NNNNN` from 2019). Newest vintage is auto-detected by probing `variables/NAME.json` (cached 1 day).
- All 35 curated profile variables (DP02/DP03/DP04/DP05 codes in `census.ts`) were checked against the 2024 `profile/variables.json` labels. Sentinel values ≤ -222222222 are returned as null.
- **Not verified from the sandbox (no key available):** the actual keyed data responses for ACS profile, ACS variable and CBP. Query shapes follow the published `examples.json` (`for=county:043&in=state:17`, `for=zip code tabulation area:60521`, CBP predicates `LFO=001&EMPSZES=001&NAICS2017=52`). First production run with `CENSUS_API_KEY` set should confirm the JSON array shape and ZCTA/zip geographies.
- Geocoder: `layers=all` is needed to get ZCTA, MSA, block group and school districts; the default layer set omits them. Verified for 15 Salt Creek Ln, Hinsdale (DuPage 17043, tract 8446.01, ZCTA 60521, place 1735307, CD IL-4) and for a 60521 coordinate pair.

## Smoke
`npx tsx /tmp/claude-0/-home-claude/b833aeaa-ec20-51c6-be5f-ea01232783a0/scratchpad/builders/labor-census-smoke.ts` — BLS, QCEW and Geocoder cases pass live; Census data cases fail fast with the configured-key error.
