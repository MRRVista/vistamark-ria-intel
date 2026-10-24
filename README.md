# Vistamark Intel

A unified intelligence layer for RIA prospecting, nonprofit/endowment research, retirement-plan analysis, institutional-market intelligence, and macro/rate context — normalized Postgres (Neon) plus live public APIs, exposed to Claude via the Model Context Protocol (MCP). **234 tools across 41 dataset families.** Queried in production by Randall, Vistamark's AI associate.

## Data domains

**DB-backed (Neon Postgres, scheduled ingests):**

- **Form ADV (SEC IAPD)** — weekly ingest; ~23.7K SEC-registered advisers. Firms, advisors, AUM history, custodians, private funds, alumni tracking.
- **IRS Exempt Organizations BMF** — 6-region rotation; 1.7M+ tax-exempt orgs with asset/income/revenue bands.
- **IRS Form 990 e-file returns** — every e-filed 990 / 990-EZ / 990-PF from the IRS TEOS bulk XML (index years 2021→current, ~750K returns/yr): financial summary (revenue, expenses, assets, net assets, invested securities, Schedule D endowment, investment-management fees paid — Part IX 11f) **plus every officer / director / trustee / key employee listed in Part VII** — the national nonprofit board-member index (`irs990_persons`, ~8 people per return, trigram-indexed on a normalized name; 990-PF rows carry the person's address). Loaded by the **`IRS 990 ingest` GitHub Actions workflow** (monthly, 8th) — not a Vercel cron, because one IRS batch is 50–500 MB. Ledger in `irs990_batches`; status at `GET /api/admin/irs990`.
- **DOL Form 5500** — annual ERISA filings (sponsor, plan type, assets, participants, 401(k)/DB flags). Thursday refresh cron + manual admin backfill.
- **DOL Form 5500 Schedule C** (v0.32, migration 0009) — every service provider paid by a plan (recordkeepers, consultants, investment advisers) with EIN, service codes and direct/indirect compensation, joined to the plan. Loaded by `POST /api/admin/refresh-dol-sch-c` (manual; ~265K rows for 2024 in ~25 s). Answers "who is the incumbent adviser on this plan" and "which plans pay this consultant".
- **IPEDS Finance Survey Part H** — ~6,400 Title IV institutions' endowments, FY2003-04 onward, with peer sets, percentile ranks, and growth analytics.
- **NACUBO** — public NCSE/NTSE benchmark aggregates by cohort.
- **SBA PPP / SEC 13F** — schema live; loaded via manual admin ingests (the quarterly 13F cron is currently a deliberate no-op stub).

**Live-API (no local ingest):**

- **ProPublica Nonprofit Explorer** — full 990 filing histories.
- **FRED** — series search/fetch, full yield curve, batch latest, and a curated 22-indicator macro market-signals layer (six pillars + computed net liquidity = WALCL − RRP − TGA).
- **Treasury FiscalData** — avg rates, debt outstanding, and the Daily Treasury Statement: daily TGA cash and daily deposits/withdrawals incl. the withheld individual/FICA payroll signal (negation-guarded category matching).
- **Morning market brief** — one-call pre-market composite (signals + daily TGA + fiscal flows + curve + OFR FSI) with ready-to-send briefMarkdown.
- **FDIC BankFind** — bank search, quarterly financials, failure history.
- **OFR** — daily Financial Stress Index + Short-Term Funding Monitor series.
- **SEC EDGAR** — company lookup/filings, XBRL concepts with freshness-aware tag fallback, cross-market concept frames, full-text search (2001+), Form D exempt-offering search.
- **GLEIF LEI** — global entity resolution + corporate family trees.
- **BDC universe** — curated listed-BDC (BIZD-style) list with EDGAR-backed profiles and screens.
- **Public Plans Database** — the ~230 largest U.S. state/local pension plans, multi-year funding history.
- **USAspending** — federal awards by recipient + top-recipient screens.
- **EODHD** (keyed) — global market data: symbol search, EOD price history (adjusted), delayed real-time quotes (batch ≤15), dividends/splits, fundamentals (section-filtered), news with sentiment, cross-market screener.
- **Apollo.io** (keyed; Free plan includes API access) — B2B people/company search (free) and professional-email enrichment (1 credit per email found). Personal-email and phone reveal are off by default; `apollo_enrich_prospect` writes hits onto prospect rows as `unverified` with `append:apollo:tried` / `email:apollo` tags so nothing is re-billed.

**Synthesis / Triangulation, added in v0.34 (`lib/synthesis/`):** composite tools that call the other families in-process, in parallel, join on EIN / CRD / CIK / LEI / PIN or normalized name × geography, score the result and end with ranked outreach angles — each with a draft first line and the guardrail that governs it. Every composite reports `coverage` (which upstreams answered / failed / were skipped) so an absent signal is never read as an absent fact.

- **`prospect_360`** — one person across the prospect DB, the 990 board index, Section 16 insiders, Form D related persons, IDFPR licenses, Cook + PTAX parcel buyers/sellers, the employer's 5500 plans and (opt-in, free) Apollo. Identity is *confirmed* only when ≥2 independent sources agree; returns a 0–100 wealth-signal score with auditable weights (`SIGNAL_WEIGHTS`).
- **`org_360`** — one institution across 990 e-file, BMF, 5500 + Schedule C (the named incumbents), ADV, LEI, EDGAR, USAspending, PPP, ProPublica history; additive *in-play* score with every reason listed, finance-titled decision makers flagged.
- **`liquidity_event_radar`** — money in motion in a town/zip: Cook + PTAX sales, insiders by owner location, Form D persons by location, cross-referenced to the prospect DB (known / do-not-contact / client) and the 990 people index.
- **`relationship_graph`** — warm paths via shared board service (depth 1–2), intersected with the prospect DB; claims only "serves alongside".
- **`market_regime_brief`** — eight sources (FRED board, DTS, OFR, NY Fed, Atlanta Fed, Philly Fed, Shiller, Cboe, Damodaran) → seven pillar reads → one regime label (needs ≥3 pillars agreeing) → client talking points and a prospect hook.
- **`synthesis_playbooks`** — the doctrine and the hypothesis → fan-out → confirmation → angle recipes (also for questions with no composite yet: iCIO RIA screening, endowment benchmarking).

`/api/ask` carries the same doctrine in its system prompt, tells the model to call a composite first, gives composites a 16K-char result window and a 45s leash, raises the round cap to 12, and accepts `depth:"deep"` (8 rounds, full playbook).

**Live-API, added in v0.32 (all free and keyless unless marked):**

- **Research datasets** — Ken French library (FF3/FF5/momentum, any of ~300 files, 8 regions), AQR factors (QMJ, BAB, HML Devil, VME, TSMOM, Century), Damodaran implied ERP + industry WACC/multiples/betas, Shiller CAPE with percentiles, Cboe VIX/VIX9D/VIX3M/VIX6M/VVIX/SKEW with term structure.
- **Fed regional** — NY Fed reference rates (SOFR/EFFR/OBFR/TGCR/BGCR with percentiles and volumes), primary dealer statistics, ON RRP/SRP/SOMA, ACM term premia, yield-curve recession probability; Atlanta Fed GDPNow and Wage Growth Tracker; Philadelphia Fed Survey of Professional Forecasters.
- **International macro** — World Bank indicators, IMF World Economic Outlook (with projections) and IMF SDMX 3.0, OECD (CLI, rates, unemployment, CPI presets), BIS (policy rates, credit gaps, property prices, effective FX).
- **Market structure** — FINRA Reg SHO daily short volume, FINRA consolidated short interest, SEC fails-to-deliver; FINRA TRACE aggregates (keyed, free FINRA API credentials).
- **Funds & managers** — N-PORT holdings for any mutual fund/ETF, N-CEN service providers (advisers, sub-advisers, custodians, auditors), SEC Private Fund (Form PF) statistics from 2023Q4 xlsx, registered municipal advisors (Form MA).
- **Filings people** — insider Forms 3/4/5 by issuer or owner with owner-address filter, insiders by location (e.g. Hinsdale), Form D related persons, ADV Part 2 brochures by CRD.
- **Local wealth signals** — Cook County parcel sales (buyer/seller names, house characteristics), Illinois PTAX-203 transfer declarations statewide (weekly), DuPage sales via PTAX matched to county GIS owners (internal use only per DuPage terms), IDFPR licensees by zip/profession.
- **Contact tools** (keyed) — Hunter.io domain search / email finder / verifier (professional emails only) and ZeroBounce validation (the required check before anything sends).
- Not available free and programmatically, so not built: MSRB EMMA (paid feeds only), Illinois Secretary of State entity data (sold in bulk). (ARDC attorney lookup was later built in v0.35 — see Legal Professionals.) FEC contribution data is deliberately excluded (federal ban on commercial use).

**Live-API, added in v0.33 "data-everything" (keyless unless marked):**

- **Energy & commodities** — EIA API v2 any route + route browser (keyed `EIA_API_KEY`); CFTC Commitments of Traders (legacy/disaggregated/TFF, net positioning percentiles, crowded-trade gauge, market search); Baker Hughes weekly rig count.
- **Labor & demographics** — BLS series by id or alias (30 aliases incl. DuPage/Cook/Chicago-MSA unemployment, Chicago CPI; optional `BLS_API_KEY`), QCEW county wages by NAICS (investment advice 523940, LQ), Census ACS 5-yr wealth profile for any ZCTA/county/place with state+US comparison, any ACS variable, County Business Patterns, Census geocoder (address → FIPS/tract/ZCTA/districts). Census data calls need `CENSUS_API_KEY` (free; keyless access was removed in 2026).
- **Mortgage, credit unions & consumer finance** — HMDA aggregations + jumbo-lender share by county (streams the loan-level CSV; DuPage 2024 = 642 jumbo loans), HMDA lender lookup; NCUA credit-union search (ZIP radius), 5300 call-report financials/ratios; CFPB complaint database with facets and period trends.
- **Fed Board & Treasury markets** — Board press/speech/testimony feeds, FOMC calendar + statement text/vote, Board enforcement actions (1990→today JSON), Treasury auction results (stop yield, bid-to-cover, indirect/direct/dealer) + upcoming auctions, TIC major foreign holders, I/EE savings-bond rates.
- **Advisor & broker records** — FINRA BrokerCheck and SEC IAPD individual + firm search/detail (employments, exams, registrations, disclosures, ADV/CRS links), SEC litigation releases and administrative proceedings feeds.
- **Physicians & health economy** — NPPES NPI registry (by zip/taxonomy/name, practice address only), CMS Open Payments (industry payments by NPI/name/zip), Medicare Physician & Other Practitioners billing by NPI or zip ranking, Care Compare hospitals.
- **Research grants, patents & higher-ed** — NIH RePORTER projects + publications, NSF awards, Grants.gov opportunities; PatentsView (keyed `PATENTSVIEW_API_KEY`), College Scorecard and SAM.gov entities (keyed `DATA_GOV_API_KEY`).
- **Housing markets** — Zillow ZHVI by zip/city/county/metro (mid/top/bottom tier, streamed from the 125 MB zip file in ~1.5 s) + 34 other Zillow Research datasets (ZORI, inventory, price cuts, market heat, forecast), FHFA HPI (national/state/metro + ZIP5), Realtor.com monthly inventory by zip/county/metro; HUD fair market rents + USPS crosswalk (keyed `HUD_API_KEY`).
- **Open data portals** — Socrata Discovery catalog search, generic SoQL query against allow-listed government portals, dataset column metadata, Chicago business licenses (with owners) and building permits, curated Illinois presets (insurance producers, state pay, lobbying, sales-tax revocations, Cook transfer forms), data.gov catalog (new OpenSearch API — CKAN is gone).
- **News, entities & courts** — GDELT DOC 2.0 (articles + volume timeline), Google/Bing News RSS, Wikidata entity claims (occupation, employer, net worth…), Wikipedia summaries, CourtListener dockets/opinions (optional `COURTLISTENER_TOKEN`), OpenCorporates companies/officers (keyed `OPENCORPORATES_API_TOKEN`; anonymous tier no longer exists).
- **Digital assets** — CoinGecko prices, top markets, history stats, global snapshot (optional `COINGECKO_API_KEY`).
- **Sanctions & enforcement screening** — OFAC SDN + Consolidated fuzzy name screen with verdicts, list status; FinCEN MSB registrants; OCC enforcement actions (full JSON export); SEC PAUSE list of impersonators; CFTC RED list.
- Not available free and programmatically, so not built: FDIC enforcement orders (Salesforce app, no API), FINRA Disciplinary Actions Online (webform only), Illinois SOS business entities (bot-gated), MSRB EMMA. FEC remains excluded. (ARDC: built as a verification lookup in v0.35.)

**Legal Professionals, added in v0.35 (`lib/legal-pros/`):** Chicago-area attorneys by practice area for the referral-partner network — Illinois attorneys are licensed by the ARDC, not IDFPR, so this family fills the gap `idfpr_licensee_search` cannot. Trusts & estates: `actec_fellow_search` (ACTEC WP REST directory), `cepc_member_search` (Chicago Estate Planning Council public services directory), `naela_il_search` (NAELA Find-a-Lawyer by zip radius). Family law: `aaml_il_fellow_search` (AAML Illinois, 89 fellows), `collaborative_divorce_il_search` (Collaborative Divorce Illinois, 127 professionals). ERISA: `acebc_fellow_search` (American College of Employee Benefits Counsel) and `dol_sch_c_legal_counsel` (DB rollup of Schedule C service code 29 = Legal — which firms Illinois plans actually pay). Any practice area: `leading_lawyers_search` (Illinois peer-recommended, 15 presets incl. estate, employee_benefits, family, elder, tax) and `courtlistener_counsel` (federal RECAP dockets → counsel/firm tallies; `COURTLISTENER_TOKEN` recommended). `ardc_lawyer_lookup` verifies licence status, firm, admission date, malpractice flag and discipline — run it last. `legal_pros_playbook` carries the routing doctrine and guardrails. Nine keyless selftest probes.

**DB-backed, added in v0.33:**

- **DOL Form 5500 Schedule H/I** (migration 0010) — plan balance sheet, income statement and the 21-column EOY asset mix (mutual funds, CCT/PSA, employer securities, insurance GA, real estate…) for every large (H) and small (I) plan. DOL moved total assets out of `F_5500` in 2024, so `dol_plan_search` / Schedule C asset filters now COALESCE from this table. Loaded by `POST /api/admin/refresh-dol-sch-h` (~88K H + ~60K I rows for 2024 in < 1 min). Tools: `dol_plan_financials`, `dol_plans_by_asset_mix`, `dol_sch_h_status`.
- **IRS EO extras** (migration 0011) — Publication 78 deductibility status (1.43M), automatic revocations (1.25M, with reinstatements), and 990-N e-Postcard filers with officer name/city/zip (1.55M small orgs — a second board-member index). Loaded by the **`IRS EO extras ingest`** GitHub Actions workflow (monthly, 10th; reuses `IRS990_DATABASE_URL`). Tools: `irs_pub78_lookup`, `irs_revocation_search`, `irs_990n_search`, `irs_990n_officers_search`, `irs_eo_extras_status`.

**First-party (PII — token-or-session gated, never on an open endpoint):**

- **Prospects by zip code** — households + individuals funneled in from purchased lists, county assessor / voter exports, web forms, Randall, and the CRM. Dedupes on normalized email, then on name + USPS-normalized street + zip; households dedupe on address and carry the wealth signals (home value, purchase, year built, est. income/net-worth band). Every person carries consent flags (`email_opt_in`, `do_not_contact/email/call/mail`), lead status/score, source provenance, and an event log. Target zips live in `prospect_zips` (seeded with **60521 Hinsdale**). See [Prospects](#prospects-zip-code-database).

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/mcp` | `ACCESS_TOKEN` header | MCP JSON-RPC (initialize, tools/list, tools/call) |
| `GET /api/selftest` | none | Read-only diagnostic battery (113 checks; the keyed EIA/Census/Scorecard/HUD probes fail fast until their keys land). `?only=` substring filter, `?t=` per-check timeout (1000–9000ms). Gate or remove after validation. |
| `GET /api/market-brief` | none | The morning composite, served for the vistamark-m365 pre-market digest cron. Aggregated public macro data only — same exposure posture as selftest. |
| `GET/POST /api/prospects` | `ACCESS_TOKEN` or Entra session | Prospect database: search/filter, CSV download, VistaCRM feed (`?format=crm`), and intake — JSON records, inline CSV, raw CSV/TSV/XLSX body, or multipart file upload. |
| `GET/POST /api/ask` | `ACCESS_TOKEN` or Entra session | "Ask Randall" natural-language layer: a server-side tool loop over the MCP tools plus hosted **web search** (Anthropic `web_search` / OpenRouter `web` plugin) and an Ask-only `export_excel` tool that returns a real .xlsx as a download. `GET` is the capability probe and the **model roster** (Anthropic lineup + live OpenRouter catalog); `POST { question, provider?, model?, webSearch?, domains?, maxRounds?, history? }`. Any model id is accepted; Mythos-class primaries fail over to the Opus line on 429/5xx. |

## Setup

### Environment variables

| Name | Required | Purpose |
|------|----------|---------|
| `DATABASE_URL` | yes | Auto-injected by the Neon integration |
| `ACCESS_TOKEN` | yes | Required header on every MCP request |
| `CRON_SECRET` | yes | Authenticates manual cron/admin triggers |
| `FRED_API_KEY` | yes (macro tools) | Free key — https://fred.stlouisfed.org |
| `EODHD_API_TOKEN` | yes (eodhd_* tools) | EODHD API token — https://eodhd.com |
| `APOLLO_API_KEY` | yes (apollo_* tools) | Apollo.io API key — app.apollo.io → Settings → Integrations → API |
| `DOL_5500_YEAR` | optional | Override ingest year (default = current − 2); also the default Schedule C year |
| `FINRA_API_CLIENT_ID` / `FINRA_API_CLIENT_SECRET` | optional (`finra_trace_aggregates`) | Free FINRA API Console credentials; short volume and short interest need none |
| `HUNTER_API_KEY` | optional (hunter_* tools) | Hunter.io key — free tier available |
| `ZEROBOUNCE_API_KEY` | optional (zerobounce_* tools) | ZeroBounce key; `ZEROBOUNCE_API_BASE` picks the US/EU host |
| `SOCRATA_APP_TOKEN` | optional | Higher rate limits on Cook County / data.illinois.gov |
| `EIA_API_KEY` | yes (eia_* tools) | Free — https://www.eia.gov/opendata/register.php |
| `CENSUS_API_KEY` | yes (census_acs_*/census_cbp) | Free, instant — https://api.census.gov/data/key_signup.html (required on every data request since 2026) |
| `BLS_API_KEY` | optional (bls_*) | 500 req/day vs 25/day keyless per IP — https://data.bls.gov/registrationEngine/ |
| `DATA_GOV_API_KEY` | yes (college_scorecard, sam_entity_search) | Free — https://api.data.gov/signup |
| `PATENTSVIEW_API_KEY` | yes (patentsview_search) | Free — https://patentsview.org/apis/keyrequest |
| `HUD_API_KEY` | yes (hud_* tools) | Free token — https://www.huduser.gov/hudapi/public/register |
| `OPENCORPORATES_API_TOKEN` | yes (opencorporates_*) | OpenCorporates API token (no anonymous tier) |
| `COURTLISTENER_TOKEN` / `COINGECKO_API_KEY` | optional | Higher CourtListener / CoinGecko rate limits |
| `DOL_5500_SCH_H_BASE_URL` / `BAKER_HUGHES_RIG_XLSX_URL` | optional | Override upstream file locations if they move |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | yes (Ask layer) | At least one. `ANTHROPIC_MODEL` / `OPENROUTER_MODEL` pin the defaults the picker opens on. |
| `ASK_WEB_SEARCH` | optional | `0` turns hosted web search off by default (the console toggle still overrides per question). `ASK_WEB_SEARCH_MAX_USES` caps searches per answer (default 8). |
| `ASK_EXTRA_MODELS` | optional | JSON array of `{id,label,provider?,tier?,notes?}` to add models to the picker without a deploy. |

### First ingest (after schema migrate)

```bash
BASE="https://<your-deploy>.vercel.app"
curl -X POST "$BASE/api/admin/migrate" -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "$BASE/api/cron/ingest-adv" -H "Authorization: Bearer $CRON_SECRET"
for region in eo1 eo2 eo3 eo4 eo_pr eo_xx; do
  curl -X POST "$BASE/api/admin/refresh-irs-bmf?region=$region" -H "Authorization: Bearer $CRON_SECRET"
done
curl -X POST "$BASE/api/admin/refresh-dol-5500" -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "$BASE/api/admin/refresh-ipeds" -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "$BASE/api/admin/refresh-nacubo" -H "Authorization: Bearer $CRON_SECRET"
```

IRS 990 e-file returns load from GitHub Actions, not from a Vercel endpoint. Add the repository secret `IRS990_DATABASE_URL` (the Neon connection string), then run **Actions → IRS 990 ingest → Run workflow** (blank inputs = load every un-loaded batch for 2021→current, ~1–2 h per index year; or `batch = 2025_TEOS_XML_10A` for a 1-minute smoke test). The same script runs locally:

```bash
DATABASE_URL=... npx tsx scripts/irs990-ingest.ts --list              # index batches vs ledger
DATABASE_URL=... npx tsx scripts/irs990-ingest.ts --batch 2025_TEOS_XML_10A
DATABASE_URL=... npx tsx scripts/irs990-ingest.ts --years 2025,2026   # diff-load those years
```

### Scheduled crons (vercel.json)

| Cron | Schedule (UTC) | Purpose |
|------|----------------|---------|
| `ingest-adv` | Mon 06:00 | Weekly Form ADV refresh |
| `refresh-irs-bmf` | Wed 04:00 | Next region in the 6-region rotation |
| `refresh-dol-5500` | Thu 05:00 | Re-pull latest plan year |
| `refresh-ipeds` | daily 06:00 | IPEDS freshness check |
| `refresh-nacubo` | Feb 15 yearly | Annual NACUBO study refresh |
| `prospect-engine` | daily 00:00 & 01:00 (runs only at 7 PM Chicago) | 3 researched, personalized outreach drafts → Outlook Drafts |
| `refresh-13f` | quarterly (1st, 08:00) | **Stub** — returns 200, no-op; real 13F loads are manual admin ingests |
| `IRS 990 ingest` (GitHub Actions, not Vercel) | 8th 08:10 | Diff-loads new IRS TEOS 990 XML batches → `irs990_filings` / `irs990_persons`; writes `irs-990/<batch>` rows to `ingest_runs` |

`database_status` reports per-pipeline health: each ingest family's latest run, errors sorted first with redacted error messages — a failing scheduled ingest surfaces there instead of failing silently. A family absent from `pipelineHealth` has never created a run record, meaning its handler is not being reached.

## Prospects (zip-code database)

Migration `0006_prospects.sql` adds `prospect_zips`, `prospect_imports`, `prospect_households`, `prospects`, `prospect_events`. Apply with the normal migrate call (`POST /api/admin/migrate`, Bearer `CRON_SECRET`); it is idempotent and seeds 60521.

**Intake (all paths share one normalizer + merge):**

```bash
B="https://vistaintel.app"; T="$ACCESS_TOKEN"
# 1. Dry-run a county assessor export — read columnMap, sample, zipCounts, rejected before writing
curl -s -H "ACCESS_TOKEN: $T" -F "file=@dupage_60521.xlsx" -F "source=dupage-assessor-2026" -F "nameOrder=last-first" -F "dryRun=1" "$B/api/prospects"
# 2. Same call without dryRun to load it (restrictZips=1 skips rows outside active target zips)
curl -s -H "ACCESS_TOKEN: $T" -F "file=@dupage_60521.xlsx" -F "source=dupage-assessor-2026" -F "nameOrder=last-first" -F "restrictZips=1" "$B/api/prospects"
# 3. Raw CSV body (Excel "Save as CSV"), single-zip list with no zip column
curl -s -H "ACCESS_TOKEN: $T" -H "Content-Type: text/csv" --data-binary @list.csv "$B/api/prospects?source=list-broker:acme&defaultZip=60521"
# 4. A website form / Zapier lead
curl -s -H "ACCESS_TOKEN: $T" -H "Content-Type: application/json" -d '{"via":"form","record":{"firstName":"Gina","lastName":"Hall","email":"gina@example.com","zip":"60521","emailOptIn":true}}' "$B/api/prospects"
# 5. Work a lead
curl -s -H "ACCESS_TOKEN: $T" -H "Content-Type: application/json" -d '{"action":"update","id":42,"leadStatus":"meeting","note":"Lunch 9/10","actor":"mrice"}' "$B/api/prospects"
```

Column headers are auto-mapped by synonym (`Owner Name`/`Situs Address`/`Market Value`/`PIN` …); force with `columnMap={"Weird Header":"fullName"}`. Unmapped columns are kept in `raw`. Excel files are read natively (first sheet, or `sheet=`); legacy `.xls` is not — save as `.xlsx`/`.csv`. Bodies are capped at ~4.5 MB by Vercel (≈40k rows); split larger lists.

**Merge rules:** incoming non-null wins; `do_not_*` flags only ever turn on; `lead_status` is never demoted to `new` by an import; tags union; notes append; `wealth_signals` shallow-merge; first-seen `source`/`import_id` preserved.

**VistaCRM link:** `GET /api/prospects?format=crm` (or the `prospects_export_crm` tool) returns CRM-shaped contacts — `externalId` `vistaintel:prospect:<id>`, email only when contactable, phone/address suppressed under do-not-call/mail — defaulting to *not yet synced or changed since last sync*, so a VistaCRM puller can run it bare on a schedule. `&markSynced=1` stamps the batch; `POST {"action":"crm_ack","vistacrmContactIds":{"<id>":"<crmId>"}}` writes VistaCRM's ids back for a two-way link. Filter the feed with any search param (`zip=60521&minHomeValue=2000000&contactableByEmail=1`).

Tests: `DATABASE_DRIVER=pg DATABASE_URL=postgres://… npx tsx scripts/test-prospects.ts` (pure normalization checks run without a DB).

### Nonprofit outreach engine (nightly, two programs) — v0.29.0

`GET /api/cron/nonprofit-engine?program=matt|ryan` runs at **7:00 PM America/Chicago** (vercel.json fires 00:05Z/01:05Z for matt and 00:25Z/01:25Z for ryan; the handler runs only at 19:00 local) and produces **3 institutional nonprofit leads per principal per weekday evening**: endowments, foundations, and nonprofit retirement-plan sponsors, each with a researched, personalized Outlook draft in that principal's own mailbox and a **Lead in VistaCRM assigned to that principal** carrying the full enrichment.

Pipeline per lead: BMF+990 universe (program band/geo, ranked by geography → 990 Part IX 11f investment-mgmt fees paid → pool size; orgs never repeat across programs) → 990 Part VII board/officer roster cross-matched with **Apollo people search (LinkedIn-derived profiles: headline, employment history, linkedin_url)** → `apollo_person_enrich` professional-email reveal (status carried everywhere; `guessed` is flagged for verification) → web-search research pass hunting the program's **shared affinities** (Matt: Northwestern/Chicago; Ryan: Ohio State/Northwestern + Chicago/Cleveland/Akron/Columbus/Evanston) plus cross-board seats from the local 990 people index and Form 5500 plan facts → persona-driven draft with a plain-text `[FOR MATT: …]` / `[FOR RYAN: …]` bracket line, CAN-SPAM footer, and two real availability dates → Graph draft (never sent) → **VistaCRM Lead created only after the draft exists** (`POST /api/contacts`, coordinator = the principal, tags `nonprofit outreach` + `np-matt`/`np-ryan`, enrichment in `background` + a timeline note; 409 duplicate → note lands on the existing contact).

Targeting lives in `lib/nonprofit/programs.ts` (bands, zip-prefix geo, affinities, personas, banned phrases). Matt: IL hard (Chicago metro 600–609 first) + SE WI (530–535) + W MI (490–495) + NW IN (463–464), pools $20M–$200M. Ryan: IL/OH/WI/MI/IN whole-state, $25M–$110M, affinity-metro boost. Ledger in `np_leads` / `np_events` (migration 0008). Scheduled runs are ON by default; `NONPROFIT_ENGINE_ENABLED=0` pauses. Needs `VISTACRM_BRIDGE_SECRET` (same value as vistarandall's) for the CRM leg — until it lands, drafts still go out and the CRM step queues as `np_events` kind `crm_pending`. Manual run: `curl -H "Authorization: Bearer $CRON_SECRET" "https://vistaintel.app/api/cron/nonprofit-engine?program=matt&target=1&dryRun=1"`.

### Prospect engine (nightly drafts)

`GET /api/cron/prospect-engine` runs at **7:00 PM America/Chicago** year-round (vercel.json fires 00:00Z and 01:00Z; the handler runs only when it is 19:00 in Chicago) and produces **3 fully researched, personalized outreach drafts** from the untouched `60521` prospects, highest home value first.

Per candidate: one web-search-backed model call finds the person's *professional* footprint and any **published** professional email (with the URL it came from); no email → tagged `engine:no_published_email` and skipped. Emails are never pattern-guessed and never taken from social networks or people-search sites. A second call writes the note from `lib/prospects/persona.ts` (edit that file to change voice/facts), the banned-phrase list is enforced, and the CAN-SPAM footer (address + opt-out) is appended. Nothing is sent: drafts go to Outlook **Drafts** via Microsoft Graph when `MS_GRAPH_TENANT_ID` / `MS_GRAPH_CLIENT_ID` / `MS_GRAPH_CLIENT_SECRET` / `OUTREACH_MAILBOX` are set, otherwise they queue in `prospect_events` (kind `outreach_draft`) for `GET /api/prospect-outreach?status=pending` to pull and `POST /api/prospect-outreach {eventId, delivery}` to ack. Acking `sent` flips the lead to `contacted`.

Manual run: `curl -H "Authorization: Bearer $CRON_SECRET" "https://vistaintel.app/api/cron/prospect-engine?target=1&dryRun=1"`. Optional env: `OUTREACH_SENDER_NAME`, `OUTREACH_SENDER_TITLE`, `OUTREACH_FIRM_LEGAL`, `OUTREACH_FOOTER`, `PROSPECT_ENGINE_LOCAL_HOUR`.

## MCP tools (234 total)

RIA / Form ADV (8) · Nonprofit (9, incl. `irs990_filing_search`, `irs990_filing_get`, `irs990_board`, `irs990_people_search`, `irs990_boards_of_person`) · Macro & Treasury (10, incl. `macro_market_signals`, `fred_batch_latest`, `morning_market_brief`, `treasury_daily_cash`, `treasury_daily_flows`) · DOL 5500 (2) · Endowments & NACUBO (7) · SBA PPP (2) · USAspending (2) · SEC 13F (2) · FDIC (3) · OFR (3) · EDGAR (6) · GLEIF (2) · BDC (3) · Public pensions (3) · EODHD market data (7: `eodhd_search`, `eodhd_eod_prices`, `eodhd_quote`, `eodhd_dividends_splits`, `eodhd_fundamentals`, `eodhd_news`, `eodhd_screener`) · Apollo contact enrichment (6: `apollo_people_search`, `apollo_person_enrich`, `apollo_people_bulk_enrich`, `apollo_org_search`, `apollo_org_enrich`, `apollo_enrich_prospect`) · Prospects (9: `prospects_zip_summary`, `prospects_search`, `prospect_lookup`, `prospects_upsert`, `prospects_import_csv`, `prospect_update`, `prospect_zip_targets`, `prospects_export_crm`, `prospect_imports`) · Research Datasets (French · AQR · Damodaran · Shiller · Cboe) (7: `kfrench_factors`, `kfrench_dataset`, `aqr_factors`, `damodaran_erp`, `damodaran_industry`, `shiller_cape`, `cboe_vol_history`) · Fed Regional Banks (NY · Atlanta · Philadelphia) (8: `nyfed_reference_rates`, `nyfed_primary_dealer`, `nyfed_operations`, `nyfed_term_premia`, `nyfed_recession_probability`, `atlfed_gdpnow`, `atlfed_wage_tracker`, `philfed_spf`) · International Macro (IMF · OECD · BIS · World Bank) (7: `worldbank_indicator`, `worldbank_indicator_search`, `imf_weo`, `imf_indicator_list`, `imf_sdmx_series`, `oecd_series`, `bis_series`) · Market Structure (FINRA · SEC FTD) (4: `finra_short_volume`, `finra_short_interest`, `finra_trace_aggregates`, `sec_fails_to_deliver`) · Funds & Managers (N-PORT · N-CEN · Form PF · Form MA) (5: `nport_fund_search`, `nport_holdings`, `ncen_service_providers`, `formpf_statistics`, `form_ma_search`) · Filings People (Insiders · Form D · ADV Brochures · 5500 Sch C) (6: `insider_transactions`, `insider_by_location`, `formd_related_persons`, `adv_brochures`, `dol_sch_c_providers_by_plan`, `dol_sch_c_plans_by_provider`) · Local Wealth Signals & Contact Tools (Cook/DuPage · IDFPR · Hunter · ZeroBounce) (10: `cook_parcel_sales`, `dupage_parcel_sales`, `il_ptax_transfers`, `idfpr_licensee_search`, `hunter_domain_search`, `hunter_email_finder`, `hunter_email_verifier`, `hunter_account`, `zerobounce_validate`, `zerobounce_credits`) · Synthesis / Triangulation (6: `prospect_360`, `org_360`, `liquidity_event_radar`, `relationship_graph`, `market_regime_brief`, `synthesis_playbooks`) · Energy & Commodities (EIA · CFTC COT · Baker Hughes) (5: `eia_series`, `eia_browse`, `cftc_cot`, `cftc_cot_markets`, `baker_hughes_rig_count`) · Labor & Demographics (BLS · Census ACS/CBP · QCEW) (7: `bls_series`, `bls_popular`, `bls_qcew_county`, `census_acs_profile`, `census_acs_variable`, `census_cbp`, `census_geocode`) · Mortgage, Credit Unions & Consumer Finance (HMDA · NCUA · CFPB) (7: `hmda_aggregations`, `hmda_jumbo_lenders`, `hmda_lender_lookup`, `ncua_credit_union_search`, `ncua_call_report`, `cfpb_complaints`, `cfpb_complaint_trends`) · Fed Board & Treasury Markets (FOMC · press · auctions · TIC · savings bonds) (8: `fed_press_releases`, `fomc_calendar`, `fomc_statement`, `fed_enforcement_actions`, `treasury_auctions`, `treasury_upcoming_auctions`, `treasury_tic_holders`, `treasury_savings_bond_rates`) · Advisor & Broker Records (BrokerCheck · IAPD · SEC enforcement) (9: `brokercheck_individual_search`, `brokercheck_individual_detail`, `brokercheck_firm_search`, `brokercheck_firm_detail`, `iapd_individual_search`, `iapd_individual_detail`, `iapd_firm_detail`, `sec_litigation_releases`, `sec_admin_proceedings`) · Physicians & Health Economy (NPPES · CMS Open Payments · Medicare utilization) (5: `nppes_search`, `nppes_lookup`, `cms_open_payments`, `cms_medicare_provider_utilization`, `cms_hospital_general_info`) · Research Grants, Patents & Higher-Ed (NIH · NSF · Grants.gov · PatentsView · College Scorecard) (7: `nih_reporter_search`, `nih_reporter_publications`, `nsf_awards_search`, `grants_gov_search`, `patentsview_search`, `college_scorecard`, `sam_entity_search`) · Housing Markets (Zillow ZHVI · FHFA HPI · Realtor.com inventory) (6: `zillow_zhvi`, `zillow_dataset`, `fhfa_hpi`, `realtor_inventory`, `hud_fair_market_rents`, `hud_usps_crosswalk`) · Open Data Portals (Socrata catalog/query · data.gov · Chicago · Illinois · Cook/DuPage) (7: `socrata_catalog_search`, `socrata_query`, `socrata_dataset_columns`, `chicago_business_licenses`, `chicago_building_permits`, `il_open_data_presets`, `datagov_search`) · News, Entities & Courts (GDELT · Google News RSS · Wikidata/Wikipedia · CourtListener · OpenCorporates) (7: `gdelt_doc_search`, `news_rss_search`, `wikidata_entity_search`, `wikipedia_summary`, `courtlistener_search`, `opencorporates_search`, `opencorporates_officers`) · Digital Assets (CoinGecko) (4: `coingecko_prices`, `coingecko_markets`, `coingecko_history`, `coingecko_global`) · DOL 5500 Schedule H/I (plan financials & asset mix) (3: `dol_plan_financials`, `dol_plans_by_asset_mix`, `dol_sch_h_status`) · IRS EO Extras (Pub 78 · Auto-Revocation · 990-N e-Postcard officers) (5: `irs_pub78_lookup`, `irs_revocation_search`, `irs_990n_search`, `irs_990n_officers_search`, `irs_eo_extras_status`) · Sanctions & Enforcement Screening (OFAC · FinCEN MSB · OCC/FDIC enforcement · SEC PAUSE) (6: `ofac_sdn_search`, `ofac_sdn_status`, `fincen_msb_search`, `occ_enforcement_search`, `sec_pause_list`, `cftc_red_list`)

Call `tools/list` on `/api/mcp` for full schemas and descriptions.

## Example flows

- *"What's the pre-market picture?"* → `morning_market_brief` (no args)
- *"Which macro signals are firing?"* → `macro_market_signals`
- *"Daily TGA and the payroll tax tape"* → `treasury_daily_cash` / `treasury_daily_flows`
- *"401(k) plans in Illinois over $50M"* → `dol_plan_search` (state=IL, is401k=true, minAssetsEoy=50000000)
- *"Rank all SEC filers by Assets, Q4 2025"* → `edgar_concept_frame` (concept=Assets, year=2025, quarter=4)
- *"Who's raising credit funds this month?"* → `formd_search` (query='credit fund', startDate=…)
- *"UChicago endowment vs the national field"* → `endowment_percentile_rank` (instnm='University of Chicago')
- *"Illinois public pensions under 50% funded"* → `ppd_plan_search` (state=IL, maxFundedRatioPct=50)
- *"Who sits on the Hinsdale Community House board and how do I reach them?"* → 990 Part VII roster → `apollo_people_search` (personName + organizationNames) → `apollo_person_enrich` (apolloId) → validate → draft
- *"What do we have in 60521?"* → `prospects_zip_summary` → *"Homes over $2M we can email"* → `prospects_search` (zip=60521, minHomeValue=2000000, contactableByEmail=true)

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Form ADV + IRS BMF + ProPublica 990s | shipped |
| 2 | DOL Form 5500 | shipped |
| 3 | FRED + Treasury + macro signals + Daily Treasury Statement + morning brief | shipped |
| 4 | IPEDS endowments + NACUBO cohort benchmarks | shipped |
| 5 | FDIC, OFR, EDGAR suite (FTS/Form D/frames), GLEIF, BDC, PPD pensions, USAspending, GLEIF | shipped |
| 6 | 13F automated quarterly parse (cron currently a stub; manual admin ingest live) | pending |
| 7 | Keyed-API tier: EIA, BLS, Data.gov, CFTC COT | shipped (v0.33); EIA/Census/Data.gov/HUD keys pending |
| 8 | NCUA credit unions + BrokerCheck/IAPD records | shipped (v0.33) |
| 9 | IRS 990 e-file family — filings + Part VII people, GitHub Actions loader (v0.28.0) | shipped; first backfill pending `IRS990_DATABASE_URL` secret |
| 10 | 990-N e-Postcard / Pub 78 / auto-revocation files | shipped (v0.33, migration 0011); first load pending workflow run |
| 11 | DOL 5500 Schedule H/I plan financials (restores 2024 assets) | shipped (v0.33, migration 0010); load pending |
| 12 | Prospect ↔ board-member matcher (`prospect_affiliations`) across irs990_persons + irs_990n officers + insiders | next |
| 13 | Legal Professionals family — ACTEC, AAML-IL, Collaborative Divorce IL, CEPC, NAELA, ACEBC, Leading Lawyers, ARDC lookup, Sch C legal rollup, CourtListener counsel | shipped (v0.35) |

Internal — Vistamark Investments LLC.
