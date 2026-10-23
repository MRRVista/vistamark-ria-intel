# IRS EO Extras — Publication 78 · Automatic Revocation · 990-N e-Postcard

Catalog id `irseox`. Postgres-backed (migration `0011_irs_eo_extras.sql`), loaded monthly by
`.github/workflows/irs-eo-extras-ingest.yml` → `scripts/irs-eo-extras-ingest.ts` → `lib/irs-eo-extras/ingest.ts`.
Admin status: `GET /api/admin/irs-eo-extras` (Bearer `CRON_SECRET`, `ACCESS_TOKEN`, or session).

## Sources (verified live 2026-10-22 from the sandbox)

Index page: https://www.irs.gov/charities-non-profits/tax-exempt-organization-search-bulk-data-downloads
All keyless, no rate limit observed, `Accept-Ranges: bytes`, one `.txt` entry per zip, CRLF, **no header row**, pipe-delimited.

| dataset | URL | zip / txt | rows | Last-Modified seen |
|---|---|---|---:|---|
| pub78 | https://apps.irs.gov/pub/epostcard/data-download-pub78.zip | 30 MB / 102 MB | 1,428,501 | 2026-10-13 |
| revocation | https://apps.irs.gov/pub/epostcard/data-download-revocation.zip | 48 MB / 148 MB | 1,247,425 | 2026-10-13 |
| 990n | https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip | 93 MB / 286 MB | 1,549,385 | 2026-10-19 |

### Layouts (as shipped; counted over every line)

**Pub 78** — 6 fields: `EIN|name|city|state|country|deductibility codes`. Country is a full name
("United States", "Canada"). Codes are a comma list; observed: PC 1.255M, PF 119K, EO 15.6K, SOUNK 14.2K,
POF 9.4K, SO 7.3K, `EO,LODGE` 3.2K, GROUP 2.5K, FORGN 726, UNKWN 408, SONFI 306 + combinations. One row per EIN.

**Auto-Revocation** — 12 fields: `EIN|name|DBA|address|city|state|zip|country|exemption type|revocation date|posting date|reinstatement date`.
Dates `DD-MON-YYYY`. Exemption type = BMF subsection as 2-digit text (`03` 831K, `04` 171K, `00` 38K = unknown).
183K rows carry a reinstatement date (usually equal to the revocation date = retroactive reinstatement).
(ein, revocation_date) is unique. There is **no** reinstatement-type column; `reinstatement_type` is reserved/NULL.

**990-N** — 26 fields: `EIN|tax year|name|gross receipts ≤$50K (T/F)|terminated (T/F)|period begin|period end|website|officer name|officer addr1|addr2|city|province|state|zip|country|org addr1|addr2|city|province|state|zip|country|DBA1|DBA2|DBA3`.
Dates `MM-DD-YYYY`. **One row per EIN** (the most recent postcard; 1,549,385 rows = 1,549,386 distinct EINs
less one blank). 5 rows have 27–28 fields because the free-text *website* contains `|`; the parser folds
the extras back into website. Tax years 2007–2025; 2025 = 589K, 2024 = 227K. 57K terminated.
Foreign addresses put the state in *province* and a country code in *country* (`AF` seen for Maine… the IRS field is messy).
Some zips are 9 digits without a dash; the tools match on a 5-digit prefix.

## Loader

* Streams the zip entry via the central directory + `zlib.createInflateRaw` → `readline`; never buffers the inflated text (adm-zip would). ~8 s to parse 1.55M 990-N lines.
* `INSERT … SELECT FROM unnest($1::text[], …)` in 10K-row batches into `<table>_new`; indexes built there; then `DROP` live + `RENAME` + rename indexes/PK to canonical names in one transaction (full refresh, readers never see a partial table).
* Guards: zero rows → abort; new count < 80% of live → abort unless `--force-swap`; field overflow is clipped to column width (zip 32, state 8, country 8, city 128).
* Ledger `irs_eo_extras_loads` + `ingest_runs` rows with source `irs-eo-extras/<dataset>`.
* Local timing (Postgres 16, same box): revocation 58 s (24 load + 32 index), pub78 73 s (33 + 39), 990n 95 s (45 + 50). Against Neon expect several minutes per dataset; `statement_timeout` is 30 min.

## Tools

| tool | what |
|---|---|
| `irs_pub78_lookup` | EIN or name+state → eligible?, decoded codes (PC 50%, PF 30%, SO/SONFI…). A miss returns revocation / 990-N / BMF context. |
| `irs_revocation_search` | ein / name / state / city / zip / exemptionType / revokedFrom-To / reinstated; `reinstated` flag per row. |
| `irs_990n_search` | ein / name / officerName / state / city / zip / taxYear / minTaxYear / hasWebsite; terminated excluded by default. |
| `irs_990n_officers_search` | surname (exact last token) or full name (trigram) + state/zip (required) → small-org principal officers. |
| `irs_eo_extras_status` | migration applied?, row counts, latest load per dataset, 990-N by tax year, revocations by year. |

Officer street address (`officer_address1/2`) is stored but never selected by any tool.
All queries are `to_regclass`-guarded: before migration 0011 or the first load they return `tableReady:false` with an empty list.

## Not verified from the sandbox

* Neon-side timing of the trigram index builds on 1.5M rows (local: ≤ 50 s per dataset).
* `scripts/migrate.ts` itself was not run against the local Postgres (it speaks the Neon HTTP protocol); the identical splitter was run over `pg` and 0011 applied cleanly 0000→0011 on a fresh database, twice.
