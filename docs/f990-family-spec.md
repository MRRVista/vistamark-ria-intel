# Form 990 e-file XML family — design spec

**Status:** SPEC — pre-build. Phase 0 spike gates everything below.
**Author:** drafted 2026-07-06, per Matt ("Go").
**Family name:** `f990` (distinct from `irs_eo` = BMF bands, and `propublica_org_990` = live per-EIN API).
**Why:** BMF gives asset *bands*; the 990 e-file XML gives exact investment assets, Schedule D endowment balances, investment income, and — the killer field — investment-management fees paid (Part IX line 11f). One tool call answers: *"Illinois nonprofits with >$25M invested, paying >50bps, whose endowment shrank last year."*

---

## 1. Source data (VERIFY in Phase 0 — hosting has drifted before)

- IRS publishes Form 990-series e-file XML as bulk downloads on IRS.gov ("Form 990 series downloads"): yearly ZIP bundles (hundreds of thousands of XML files each) plus annual index files. The old AWS `irs-form-990` S3 bucket with per-object access was retired; per-object URLs can no longer be assumed.
- Forms in the corpus: **990** (full), **990-EZ** (small orgs), **990-PF** (private foundations), 990-T/990-N (out of scope).
- Schema versions drift by tax year (efile TY schemas, ~2013v3.x onward is the practical floor). Element names change across versions — the parser must be version-tolerant by design, not by patch.
- Volume: roughly 400–500K e-filings/year. Full history is millions of files, tens of GB uncompressed. **We never download bulk ZIPs inside a serverless function.**

**Phase 0 spike (≤1 hour, GO/NO-GO):**
1. Locate current yearly index files + ZIP URLs on IRS.gov; record exact URLs.
2. `curl -I` the ZIPs — confirm `Accept-Ranges: bytes` and stable `Content-Length`.
3. Pull 3 sample XMLs spanning schema years (e.g. 2015, 2019, 2023); confirm the 12 core fields (§4) resolve on all three, for both 990 and 990-PF.
4. Decide ingest transport per §2 outcome table.

## 2. Ingest transport — RemoteZip range reads (primary)

ZIP central directories live at the end of the archive. Plan:

- **`RemoteZip` helper** (`lib/f990/remote-zip.ts`): range-fetch the tail → parse central directory → enumerate entries `{name, offset, compressedSize, method}` → on demand, range-fetch one entry's bytes and inflate (`zlib.inflateRaw`). Each filing XML is ~50–500KB, so a worker batch of hundreds is comfortably inside serverless memory/time.
- Every yearly ZIP becomes a random-access archive; **no bulk download ever happens**.

| Phase 0 finding | Transport decision |
|---|---|
| Ranges supported (expected) | RemoteZip, as above |
| Ranges NOT supported | Fallback A: desk-agent preprocessing — the overnight automation PC downloads ZIPs, extracts, uploads per-file XML (or pre-parsed narrow CSV) to Azure Blob; server ingests from Blob. Fallback B (on-demand only, no bulk history): ProPublica per-object XML for single-EIN enrichment. |

## 3. Scope gating — don't parse dust

Parsing ~500K filings/year is pointless when OCIO prospects are a thin slice. Two-stage gate:

1. **Enqueue gate (pre-parse):** only enqueue index entries whose EIN appears in our existing `irs_eo` (BMF) table with **asset code ≥ $1M band** — the filter we get for free before touching any XML. Enqueue ordered **newest tax year first, largest BMF band first**, so the highest-value rows land in the DB immediately while the tail drains.
2. **Store gate (post-parse):** persist the row only if `total_assets_eoy ≥ F990_MIN_ASSETS` (default $1,000,000) **or** `investments_total_eoy ≥ F990_MIN_INVESTMENTS` (default $250,000). Below-gate parses record `status='below_threshold'` in the index ledger (not silently dropped — tonight's lesson).
3. **990-EZ: skipped in v1** (`status='skipped_ez'`) — EZ filers are below prospecting size by definition. **990-PF: fully in v1** — private foundations are prime OCIO prospects and have their own XPath map.

**Backfill target: last 5 tax years** (env `F990_BACKFILL_YEARS=5`). With the BMF gate, that's roughly 1.5–2M candidate filings; ordering makes the top of the market usable within days even though the tail takes months.

## 4. Postgres schema

**`f990_filings`** — one narrow row per `(ein, tax_period_end, form_type)`, latest amendment wins (upsert on conflict, keep newest `object_id`):

| column | source | notes |
|---|---|---|
| `ein`, `tax_year`, `period_end`, `form_type` | index | PK basis; form_type ∈ {990, 990PF} |
| `object_id`, `filed_date`, `schema_version` | index/header | provenance + drift debugging |
| `org_name`, `state`, `city`, `website` | header/Part I | denormalized for query speed |
| `total_assets_eoy`, `total_liabilities_eoy`, `net_assets_eoy` | 990 Part X / PF Part II | NULL when unreported — never 0 |
| `investments_total_eoy` | 990 Part X lines 11+12+13 / PF Part II 10a–c+13 | the headline prospecting number |
| `cash_eoy` | Part X lines 1+2 | |
| `total_revenue`, `contributions`, `program_revenue` | Part VIII / PF Part I | |
| `investment_income` | Part VIII line 3 + 7d net gain / PF equivalents | |
| `total_expenses` | Part IX / PF Part I | |
| `invest_mgmt_fees` | **Part IX line 11f** | displacement targeting; PF: Part I line 16b-ish — map in Phase 0 |
| `legal_fees`, `accounting_fees` | Part IX 11b/11c | cheap to grab while there |
| `endow_eoy_y0..y4`, `has_endowment` | Schedule D Part V cols (a)–(e) | 5-year end-balance vector in-row; trend math needs no joins |

Indexes: `(ein, tax_year DESC)`, `(state, investments_total_eoy DESC)`, `(invest_mgmt_fees DESC)`, trigram on `org_name` (match existing family conventions). Computed at query time: `mgmt_fee_bps = invest_mgmt_fees / NULLIF(investments_total_eoy,0) * 10000`.

**`f990_index`** — ingest ledger and unit of resumability: `{object_key, ein, tax_period, form_type, zip_url, entry_offset, entry_size, status, attempts, error, parsed_at}`. `status ∈ pending | parsed | below_threshold | skipped_ez | error`. This ledger is what makes pipelineHealth honest for a months-long backfill.

**Phase 3 (deferred): `f990_people`** — Part VII Section A rosters (name, title, comp, role flags), threshold-gated, ~top-25 rows per filing. Board-roster search = the nonprofit `find_alumni`. Deferred because it multiplies row count ~15× — revisit against Neon storage after Phase 1 lands.

## 5. Parser — version drift is the design center

- `lib/f990/parser.ts` with **concept resolvers**: each field is an ordered list of candidate XPaths (current schema names first, legacy fallbacks behind). Same philosophy as the EDGAR stale-tag fallback already in this repo.
- `fast-xml-parser` (streaming-light, namespace-tolerant); no DOM-heavy deps.
- Numerics validated + clamped to column widths (the DOL 5500 lesson, pre-applied).
- **Unresolved-concept accounting:** every worker run records per-field resolution-miss counts in its run record. A schema-version we've never mapped shows up as a visible error count in `pipelineHealth`, never as silent NULLs. (Tonight's database_status lesson, encoded from day one.)

## 6. Crons, workers, and pipelineHealth

- **`f990-index`** — weekly, Sat 06:00 UTC. Discovers new yearly ZIP releases, refreshes indexes, enqueues per §3 gate. Run family `f990-index`.
- **`f990-worker`** — every 6h. Processes up to `F990_BATCH` (default 800) pending entries with a soft time-stop at ~250s; writes run record `{parsed, below_threshold, skipped_ez, errors, resolutionMisses}`. Run family `f990`.
- **`POST /api/admin/refresh-f990?batch=N`** (Bearer `CRON_SECRET`) — manual accelerator. The desk-agent can loop this overnight to chew backfill at 10–20× cron pace. Backfill speed is a knob, not a promise.
- Both families surface in `database_status.pipelineHealth` automatically (existing run-record pattern). Randall's self-diagnosis doctrine covers them with zero prompt changes.
- Verify: Vercel plan `maxDuration` ceiling for the worker route (config `maxDuration: 300`).

## 7. Tool surface (57 → 60)

1. **`f990_search`** — filters: `state`, `name`, `min/max_investments`, `min_total_assets`, `min_mgmt_fee_bps`, `min_endowment`, `endowment_change_pct` (y0 vs y2/y4), `tax_year`, `form_type`; sort keys `investments|mgmt_fee_bps|endowment|revenue`; paginated. Returns computed `mgmt_fee_bps`. THE prospecting tool — fee-outlier and distressed-endowment screens are parameter combinations, not extra tools.
2. **`f990_lookup`** — by EIN: all stored years' financials + endowment vector + provenance. Description cross-links `irs_eo_lookup` (band context) and `propublica_org_990` (older years, PDFs).
3. **`f990_endowment_trend`** — dedicated screen: orgs above a size floor whose endowment declined ≥N% over M years, by state. (Foldable into search mechanically, but a named tool routes better in Randall's head and in demos.)

Empty-table behavior: `total: 0` responses include the standard ingest-state hint; `database_status` tells the rest.

## 8. Battery (36 → 39)

- `f990_search` state=IL min_investments=25M returns >0 rows (post-backfill-start).
- `f990_lookup` on a stable large EIN (University of Chicago, 36-2177139 — already a battery reference org) returns ≥1 year with non-NULL `investments_total_eoy`.
- `pipelineHealth` contains families `f990` and `f990-index` with a latest run.

## 9. Config

`F990_MIN_ASSETS=1000000`, `F990_MIN_INVESTMENTS=250000`, `F990_BATCH=800`, `F990_BACKFILL_YEARS=5`, `F990_INDEX_URL_BASE=<Phase 0>` — all in README + `.env.example`. No new secrets; admin route reuses `CRON_SECRET`.

## 10. Ship checklist (Phase 1 exit)

- [ ] Phase 0 spike notes appended to this doc (URLs, range support, sample-parse results)
- [ ] Migration + `lib/f990/{remote-zip,parser,ingest}.ts` + worker/index crons + admin route
- [ ] `f990_search` + `f990_lookup` registered; battery 39/39 on a fresh deployment URL
- [ ] README family section + tool count + errata
- [ ] Randall self-knowledge **v1.7**: routing-map entry + freshness line (BOTH `lib/self-knowledge.ts` and the `.md` mirror — the mirror rule is now law)
- [ ] Phase 2: `f990_endowment_trend` + Sch D hardening. Phase 3 decision: `f990_people` vs Neon budget.

## 11. Risks

| risk | mitigation |
|---|---|
| IRS hosting/URL drift | Phase 0 verifies; index cron alerts via pipelineHealth error if index fetch 404s |
| No range support on ZIPs | desk-agent → Azure Blob preprocessing fallback (§2) |
| Schema-version gaps | resolver miss-counts in run records — visible, never silent |
| Neon storage growth | narrow rows ≈ <1GB for 2M filings; people table deferred behind a measured decision |
| Amended/duplicate filings | latest-wins upsert on `(ein, tax_period, form_type)` |
| Vercel time limits mid-batch | per-entry ledger commits; worker is resumable at any kill point |
