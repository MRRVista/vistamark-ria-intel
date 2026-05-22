# Vistamark Intel

A unified intelligence database for RIA prospecting and nonprofit research, built on public SEC, IRS, and ProPublica data and exposed to Claude via the Model Context Protocol (MCP). Built and operated by Randall Stephens.

## What it does

- **RIA intelligence (Form ADV)** — Weekly ingest of the SEC IAPD bulk feed (~17K SEC-registered investment advisers). Normalized firms, advisors, AUM history, custodians, and private funds.
- **Nonprofit intelligence (Phase 1)** — Monthly ingest of the IRS Exempt Organizations Business Master File (1.7M+ tax-exempt orgs). Live ProPublica Nonprofit Explorer passthrough for full 990 financial history.
- Exposes 13 MCP tools across both domains for prospecting, alumni tracking, custodian lookups, AUM analysis, nonprofit search, and 990 deep-dives.

## Setup (one-time, ~2 minutes)

### 1. Connect Postgres in Vercel dashboard

Storage tab → Create Database → Neon (Postgres) → Free tier. Vercel auto-injects `DATABASE_URL` as an env var.

### 2. Add auth secrets

Settings → Environment Variables:

| Name | Value |
|------|-------|
| `ACCESS_TOKEN` | random string — required header on every MCP request |
| `CRON_SECRET` | random string — allows manual cron triggers and migration |

Redeploy.

### 3. Apply schema + first ingest

```bash
# Apply migrations (creates `nonprofits` + everything from v0.1)
curl -X POST "https://<deploy>.vercel.app/api/admin/migrate" \
  -H "Authorization: Bearer $CRON_SECRET"

# Ingest SEC Form ADV (~3–5 min)
curl -X POST "https://<deploy>.vercel.app/api/cron/ingest-adv" \
  -H "Authorization: Bearer $CRON_SECRET"

# Ingest IRS BMF — process one region at a time (~60–120s each).
# Loop through all 6 regions for full backfill:
for region in eo1 eo2 eo3 eo4 eo_pr eo_xx; do
  curl -X POST "https://<deploy>.vercel.app/api/admin/refresh-irs-bmf?region=$region" \
    -H "Authorization: Bearer $CRON_SECRET"
done
```

Crons keep everything fresh:

| Cron | Schedule | Purpose |
|------|----------|---------|
| `ingest-adv` | Mondays 06:00 UTC | Weekly Form ADV refresh |
| `refresh-irs-bmf` | Wednesdays 04:00 UTC | Picks next region in 6-region rotation |
| `refresh-13f` | 1st of Jan/Apr/Jul/Oct, 08:00 UTC | Quarterly 13F (stub) |

## Claude.ai connector

- URL: `https://<deploy>.vercel.app/api/mcp`
- Header: `ACCESS_TOKEN: <your-token>`

## MCP tools

### RIA intelligence (Form ADV)

| Tool | Purpose |
|------|---------|
| `search_rias` | Multi-filter RIA search (state, AUM range, client mix, services, custody) |
| `get_ria_profile` | Full firm dossier — ADV fields, AUM history, advisors, custodians, private funds |
| `search_advisors` | Find individual IARs by name or current firm |
| `find_alumni` | Find advisors who used to work at a firm and where they went (ex-Fiducient tracker) |
| `get_aum_history` | Time series of AUM, accounts, employees for one firm |
| `firms_using_custodian` | List firms using a given custodian (Schwab, Fidelity, Pershing, etc.) |
| `top_rias_by` | Leaderboard by AUM, accounts, employees, or IAR count |
| `database_status` | Freshness check — firm count, latest feed, last ingest |

### Nonprofit intelligence (Phase 1)

| Tool | Purpose | Data source |
|------|---------|-------------|
| `propublica_org_search` | Keyword search for tax-exempt orgs with state / NTEE / subsection filters | ProPublica live API |
| `propublica_org_990` | Full 990 filing history time series (revenue, expenses, assets) for one org | ProPublica live API |
| `irs_eo_lookup` | Fast EIN-based IRS BMF lookup | Local Postgres (monthly IRS bulk) |
| `irs_eo_search` | Powerful nonprofit prospecting — state, subsection, NTEE prefix, asset/income buckets, hard-dollar floors | Local Postgres (monthly IRS bulk) |

## Phase 1 example queries

- *"Find every 501(c)(3) in Illinois with assets over $10M, ranked by revenue."* → `irs_eo_search` with `state=IL`, `subsection=3`, `minAssetCode=8`, `sortBy=revenue_amt`
- *"Pull the 990 history for the MacArthur Foundation."* → `propublica_org_search` for "MacArthur" → `propublica_org_990` on the resulting EIN
- *"Look up EIN 36-3593942 against the IRS BMF."* → `irs_eo_lookup`
- *"Search ProPublica for community foundations in Illinois."* → `propublica_org_search` with `q="community foundation"`, `state=IL`

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Form ADV + IRS BMF + ProPublica 990s | **shipped (this release)** |
| 2 | Form 5500 (ERISA retirement plans) | planned |
| 3 | FRED + Treasury macro/yield-curve passthroughs | planned |
| 4 | EDGAR 13F + N-PORT filings | planned |
| 5 | IPEDS university endowments + NACUBO cohort returns | planned |

## Testing

```bash
# Type-check
npm run build

# Parser smoke tests (ADV XML and BMF CSV)
npx tsx scripts/test-parser.ts
npx tsx scripts/test-phase1.ts
```

Internal — Vistamark Investments LLC.
