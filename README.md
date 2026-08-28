# Vistamark Intel

A unified intelligence layer for RIA prospecting, nonprofit/endowment research, retirement-plan analysis, institutional-market intelligence, and macro/rate context — normalized Postgres (Neon) plus live public APIs, exposed to Claude via the Model Context Protocol (MCP). **64 tools across 16 dataset families.** Queried in production by Randall, Vistamark's AI associate.

## Data domains

**DB-backed (Neon Postgres, scheduled ingests):**

- **Form ADV (SEC IAPD)** — weekly ingest; ~23.7K SEC-registered advisers. Firms, advisors, AUM history, custodians, private funds, alumni tracking.
- **IRS Exempt Organizations BMF** — 6-region rotation; 1.7M+ tax-exempt orgs with asset/income/revenue bands.
- **DOL Form 5500** — annual ERISA filings (sponsor, plan type, assets, participants, 401(k)/DB flags). Thursday refresh cron + manual admin backfill.
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

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/mcp` | `ACCESS_TOKEN` header | MCP JSON-RPC (initialize, tools/list, tools/call) |
| `GET /api/selftest` | none | Read-only diagnostic battery (39 checks). `?only=` substring filter, `?t=` per-check timeout (1000–9000ms). Gate or remove after validation. |
| `GET /api/market-brief` | none | The morning composite, served for the vistamark-m365 pre-market digest cron. Aggregated public macro data only — same exposure posture as selftest. |

## Setup

### Environment variables

| Name | Required | Purpose |
|------|----------|---------|
| `DATABASE_URL` | yes | Auto-injected by the Neon integration |
| `ACCESS_TOKEN` | yes | Required header on every MCP request |
| `CRON_SECRET` | yes | Authenticates manual cron/admin triggers |
| `FRED_API_KEY` | yes (macro tools) | Free key — https://fred.stlouisfed.org |
| `EODHD_API_TOKEN` | yes (eodhd_* tools) | EODHD API token — https://eodhd.com |
| `DOL_5500_YEAR` | optional | Override ingest year (default = current − 2) |
| `EIA_API_KEY` / `BLS_API_KEY` / `DATA_GOV_API_KEY` | future | Reserved for the keyed-API expansion tier |

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

### Scheduled crons (vercel.json)

| Cron | Schedule (UTC) | Purpose |
|------|----------------|---------|
| `ingest-adv` | Mon 06:00 | Weekly Form ADV refresh |
| `refresh-irs-bmf` | Wed 04:00 | Next region in the 6-region rotation |
| `refresh-dol-5500` | Thu 05:00 | Re-pull latest plan year |
| `refresh-ipeds` | daily 06:00 | IPEDS freshness check |
| `refresh-nacubo` | Feb 15 yearly | Annual NACUBO study refresh |
| `refresh-13f` | quarterly (1st, 08:00) | **Stub** — returns 200, no-op; real 13F loads are manual admin ingests |

`database_status` reports per-pipeline health: each ingest family's latest run, errors sorted first with redacted error messages — a failing scheduled ingest surfaces there instead of failing silently. A family absent from `pipelineHealth` has never created a run record, meaning its handler is not being reached.

## MCP tools (64 total)

RIA / Form ADV (8) · Nonprofit (4) · Macro & Treasury (10, incl. `macro_market_signals`, `fred_batch_latest`, `morning_market_brief`, `treasury_daily_cash`, `treasury_daily_flows`) · DOL 5500 (2) · Endowments & NACUBO (7) · SBA PPP (2) · USAspending (2) · SEC 13F (2) · FDIC (3) · OFR (3) · EDGAR (6) · GLEIF (2) · BDC (3) · Public pensions (3) · EODHD market data (7: `eodhd_search`, `eodhd_eod_prices`, `eodhd_quote`, `eodhd_dividends_splits`, `eodhd_fundamentals`, `eodhd_news`, `eodhd_screener`)

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

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Form ADV + IRS BMF + ProPublica 990s | shipped |
| 2 | DOL Form 5500 | shipped |
| 3 | FRED + Treasury + macro signals + Daily Treasury Statement + morning brief | shipped |
| 4 | IPEDS endowments + NACUBO cohort benchmarks | shipped |
| 5 | FDIC, OFR, EDGAR suite (FTS/Form D/frames), GLEIF, BDC, PPD pensions, USAspending, GLEIF | shipped |
| 6 | 13F automated quarterly parse (cron currently a stub; manual admin ingest live) | pending |
| 7 | Keyed-API tier: EIA, BLS, Data.gov, CFTC COT | pending env keys |
| 8 | 990-PF / NCUA / FINRA verification batch | pending Randall channel |

Internal — Vistamark Investments LLC.
