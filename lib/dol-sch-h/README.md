# DOL 5500 Schedule H/I — plan financials & asset mix (`dolschh`)

**Why this exists.** Starting with the 2024 FOIA files DOL removed `TOT_ASSETS_BOY/EOY_AMT`
and `NET_ASSETS_*_AMT` from `F_5500` (verified: 226,436 2024 plan rows, 0 with assets).
Plan totals now live only on Schedule H (100+ participants) and Schedule I (small plans).
`migrations/0010_dol_schedule_h.sql` + `lib/dol-5500/schedule-h.ts` load them into
`dol_sch_h_i` (one row per `ack_id`), and `dol_plan_search` / `dol_plan_lookup` /
`dol_sch_c_*` COALESCE `plans.tot_assets_eoy_amt` with `dol_sch_h_i.tot_assets_eoy_amt`.

## Source (verified live 2026-10-22)
- `https://www.askebsa.dol.gov/FOIA%20Files/<year>/Latest/F_SCH_H_<year>_Latest.zip` — 15 MB zip → 47 MB CSV, 166 cols, 87,983 rows (2024, published 2026-09-25)
- `https://www.askebsa.dol.gov/FOIA%20Files/<year>/Latest/F_SCH_I_<year>_Latest.zip` — 3.7 MB zip → 17 MB CSV, 77 cols, 59,666 rows
- Keyless, no rate limit observed. `askebsa.dol.gov` 301s to `www.`; the loader uses `www.` directly (override `DOL_5500_SCH_H_BASE_URL`).
- Layout files ship inside each zip (`*_layout.txt`). Sch I columns carry a `SMALL_` prefix and are mapped onto the same unprefixed columns.
- Indicator convention `'1'` yes / `'2'` no; amounts are plain integers (negative allowed).

## Loading
`POST /api/admin/refresh-dol-sch-h?year=2024[&schedule=H|I]` with `Bearer CRON_SECRET` (after `/api/admin/migrate`).
Local Postgres 16 timing: H 25 s, I 17 s (500-row upsert batches); Neon HTTP will be slower (one round trip per batch, ~300 batches).
Two `ingest_runs` rows: `dol-sch-h/H/<year>`, `dol-sch-h/I/<year>`.

## Tools
| tool | what |
|---|---|
| `dol_plan_financials` | by ackId / sponsor EIN / sponsorName(+state): balance sheet, income statement, asset-mix USD + %, auditor, trustee |
| `dol_plans_by_asset_mix` | screen by state, size, asset-class share/amount (employer_securities, cct, ins_general_acct, stock, …), admin bps, net return |
| `dol_sch_h_status` | row counts by year/schedule, plans coverage, recent runs |

## Quirks / caveats
- Sponsor name, city, state, participants come from `plans` — null when `refresh-dol-5500` has not run for that year; `state`/`city` filters need it.
- Asset classes other than employer securities/property, real estate, partnerships, participant/other loans exist only on Sch H; the screen auto-restricts to H for them.
- DFEs (CCTs, master trusts filed by BlackRock/Vanguard/Northern Trust) dominate the top of any asset sort; filter `dol_plan_search` by `planType` ≠ 4 or screen with `minSharePct` to find sponsor plans.
- Health & welfare plans show huge admin bps (contributions pass through); use `dol_plan_search is401k` or the pension feature codes to exclude.
- 266 H rows / 323 I rows have null total assets (filer omitted); `net_invst_gain_amt` and Sch I `tot_contrib_amt` are derived (income − contributions; sum of contribution lines).
- Guard: `schHTableExists()` caches a `to_regclass` probe (re-checks every 5 min when missing), so every query runs unchanged before migration 0010.
