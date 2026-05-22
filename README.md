# Vistamark Intel

A unified intelligence database for RIA prospecting, nonprofit research, retirement-plan analysis, and macro/rate context — built on public SEC, IRS, DOL, ProPublica, FRED, and U.S. Treasury data and exposed to Claude via the Model Context Protocol (MCP).

## Data domains

- **RIA intelligence (Form ADV)** — weekly ingest of the SEC IAPD bulk feed (~17K SEC-registered investment advisers). Firms, advisors, AUM history, custodians, private funds.
- **Nonprofit intelligence** — monthly IRS Exempt Organizations Business Master File (1.7M+ tax-exempt orgs) + live ProPublica Nonprofit Explorer for full 990 financial history.
- **Retirement plan intelligence (Phase 2)** — annual DOL Form 5500 ERISA filings (~800K plans/year). Sponsor, administrator, plan type, asset levels, participant counts, 401(k)/DB flags.
- **Macro / rates (Phase 3)** — FRED passthrough for any of the 800K+ economic series; pre-built Treasury yield curve tool; Treasury Fiscal Data for outstanding debt and avg rates.

## Setup

### 1. Connect Postgres in Vercel dashboard

Storage tab → Create Database → Neon (Postgres) → **Launch plan** ($19/mo, 10 GB storage). The full schema lands at ~3–4 GB so the free 0.5 GB tier is too tight once nonprofit + 5500 data is loaded.

### 2. Environment variables

| Name | Required | Purpose |
|------|----------|---------|
| `DATABASE_URL` | yes | Auto-injected by the Neon integration |
| `ACCESS_TOKEN` | yes | Required header on every MCP request |
| `CRON_SECRET` | yes | Authenticates manual cron triggers and migration |
| `FRED_API_KEY` | for Phase 3 | Free key at https://fred.stlouisfed.org/docs/api/api_key.html |
| `DOL_5500_YEAR` | optional | Override which year to ingest (default = current year − 2) |

Redeploy after setting env vars.

### 3. Apply schema + first ingest

```bash
BASE="https://<your-deploy>.vercel.app"

# Apply migrations (idempotent)
curl -X POST "$BASE/api/admin/migrate" -H "Authorization: Bearer $CRON_SECRET"

# Form ADV (~3–5 min)
curl -X POST "$BASE/api/cron/ingest-adv" -H "Authorization: Bearer $CRON_SECRET"

# IRS BMF — 6 regions × ~90s each
for region in eo1 eo2 eo3 eo4 eo_pr eo_xx; do
  curl -X POST "$BASE/api/admin/refresh-irs-bmf?region=$region" \
    -H "Authorization: Bearer $CRON_SECRET"
done

# DOL Form 5500 — defaults to year (current - 2); ~3-5 min
curl -X POST "$BASE/api/admin/refresh-dol-5500" -H "Authorization: Bearer $CRON_SECRET"
```

Crons keep everything fresh:

| Cron | Schedule (UTC) | Purpose |
|------|----------------|---------|
| `ingest-adv` | Mondays 06:00 | Weekly Form ADV refresh |
| `refresh-irs-bmf` | Wednesdays 04:00 | Next region in 6-region rotation |
| `refresh-dol-5500` | Thursdays 05:00 | Re-pull latest plan year (catches amendments) |

## Claude.ai connector

- URL: `https://<your-deploy>.vercel.app/api/mcp`
- Header: `ACCESS_TOKEN: <your-token>`

## MCP tools (19 total)

### RIA intelligence (Form ADV)

| Tool | Purpose |
|------|---------|
| `search_rias` | Multi-filter RIA search (state, AUM range, client mix, services, custody) |
| `get_ria_profile` | Full firm dossier — ADV fields, AUM history, advisors, custodians, private funds |
| `search_advisors` | Find individual IARs by name or current firm |
| `find_alumni` | Find advisors who used to work at a firm and where they went |
| `get_aum_history` | Time series of AUM, accounts, employees for one firm |
| `firms_using_custodian` | List firms using a given custodian |
| `top_rias_by` | Leaderboard by AUM, accounts, employees, or IAR count |
| `database_status` | Freshness — firm count, latest feed, last ingest |

### Nonprofit intelligence

| Tool | Purpose | Source |
|------|---------|--------|
| `propublica_org_search` | Keyword search with state / NTEE / subsection filters | ProPublica live API |
| `propublica_org_990` | Full 990 filing history time series | ProPublica live API |
| `irs_eo_lookup` | Fast EIN-based IRS BMF lookup | Local Postgres |
| `irs_eo_search` | Multi-filter prospecting — state, subsection, NTEE prefix, asset bands | Local Postgres |

### Retirement plans (DOL Form 5500)

| Tool | Purpose |
|------|---------|
| `dol_plan_search` | Plan prospecting — sponsor name/EIN/state, 401(k), DB flag, asset and participant ranges |
| `dol_plan_lookup` | Plan dossier by ACK_ID or (sponsorEIN + planNumber) across years |

### Macro / rates

| Tool | Purpose | Source |
|------|---------|--------|
| `fred_series_search` | Keyword search for any FRED series | FRED API |
| `fred_get_series` | Observations for a series, with date filter + transformation | FRED API |
| `fred_yield_curve` | Full Treasury curve (1M–30Y) with computed 10Y-2Y and 10Y-3M spreads + inversion flags | FRED |
| `treasury_avg_rates` | Average rates on outstanding Treasury debt by security type | Treasury Fiscal Data |
| `treasury_debt_outstanding` | Total debt outstanding by security class | Treasury Fiscal Data |

## Example flows

- *"401(k) plans in Illinois over $50M"* → `dol_plan_search` (state=IL, is401k=true, minAssetsEoy=50000000)
- *"501(c)(3) in Chicago with assets over $10M"* → `irs_eo_search` (state=IL, city=Chicago, subsection=3, minAssetCode=8)
- *"How inverted is the curve?"* → `fred_yield_curve` (no args)
- *"10Y Treasury, last 5 years monthly"* → `fred_get_series` (seriesId=DGS10, frequency=m, observationStart=2021-01-01)

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Form ADV + IRS BMF + ProPublica 990s | shipped |
| 2 | DOL Form 5500 (ERISA retirement plans) | shipped |
| 3 | FRED + Treasury passthroughs | shipped |
| 4 | EDGAR 13F + N-PORT filings | planned |
| 5 | IPEDS endowments + NACUBO cohort returns | planned |
| 6 | Form 5500 Schedule C (service-provider relationships) | planned |

Internal — Vistamark Investments LLC.
