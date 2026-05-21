# Vistamark RIA Intel

A FINTRX-style RIA intelligence database built on public SEC Form ADV data, exposed to Claude via the Model Context Protocol (MCP). Built and operated by Randall Stephens.

## What it does

- Ingests the SEC IAPD Form ADV bulk feed weekly (~17K SEC-registered investment advisers)
- Normalizes firms, advisors, AUM history, custodians, and private funds into a queryable Postgres database
- Exposes 8 MCP tools for prospecting, alumni tracking, custodian lookups, and time-series AUM analysis
- Designed to be added as a connector in Claude.ai and consumed by Randall

## Setup (one-time, ~2 minutes)

### 1. Connect Postgres in Vercel dashboard

Storage tab → Create Database → Neon (Postgres) → Free tier. Vercel auto-injects `DATABASE_URL` as an env var.

### 2. Add auth secrets

Settings → Environment Variables:

| Name | Value |
|------|-------|
| `ACCESS_TOKEN` | random string — required header on every MCP request |
| `CRON_SECRET` | random string — allows manual cron triggers |

Redeploy.

### 3. Apply schema + first ingest

```bash
curl -X POST "https://<deploy>.vercel.app/api/admin/migrate" -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "https://<deploy>.vercel.app/api/cron/ingest-adv" -H "Authorization: Bearer $CRON_SECRET"
```

The ingest downloads `IA_FIRM_SEC_Feed_*.xml.gz` from `reports.adviserinfo.sec.gov`, parses ~17K SEC-registered firms, upserts to Postgres in batches of 500. ~3-5 min wall-clock.

Weekly Monday 06:00 UTC cron keeps it fresh.

## Claude.ai connector

- URL: `https://<deploy>.vercel.app/api/mcp`
- Header: `ACCESS_TOKEN: <your-token>`

## MCP tools

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

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Form ADV Part 1 ingest + 8 MCP tools | shipped |
| 2 | EDGAR 13F holdings | stub |
| 3 | ADV Part 2 brochure parsing via Claude | designed |
| 4 | News + Wealthbox cross-reference | designed |

Internal — Vistamark Investments LLC.
