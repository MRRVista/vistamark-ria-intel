# Fed Board & Treasury Markets family (`fedboard`)

Eight keyless, live tools for Federal Reserve Board publications and Treasury-market plumbing.
All sources verified live from the build sandbox on 2026-10-22. No environment variables.

| Tool | Source | Cache |
|---|---|---|
| `fed_press_releases` | Board RSS feeds | 15 min |
| `fomc_calendar` | fomccalendars.htm scrape | 6 h |
| `fomc_statement` | `monetaryYYYYMMDDa.htm` press-release page | 6 h per page |
| `fed_enforcement_actions` | `supervisionreg/files/ea-cms-recent.json` (+ `ea-old.json`) | 6 h / 24 h |
| `treasury_auctions` | FiscalData `v1/accounting/od/auctions_query` | 30 min per query |
| `treasury_upcoming_auctions` | FiscalData `v1/accounting/od/upcoming_auctions` | 30 min |
| `treasury_tic_holders` | TIC `slt_table5.txt` + `mfhhis01.txt` | 12 h / 24 h |
| `treasury_savings_bond_rates` | TreasuryDirect I-bond / EE-bond HTML pages | 12 h |

Does not duplicate `lib/fred` (series), `lib/treasury` (avg rates, debt outstanding, DTS) or
`lib/fed-regional` (NY Fed reference rates / dealer stats / operations, Atlanta, Philly).

## Sources

### Federal Reserve Board RSS (`press.ts`)
- `https://www.federalreserve.gov/feeds/{press_all,press_monetary,press_bcreg,press_enforcement,press_orders,press_other,speeches,testimony}.xml` — all HTTP 200.
- RSS 2.0 with a UTF-8 BOM; `link`, `guid`, `description`, `pubDate` are CDATA-wrapped; `description` usually equals the title (we blank it then). 15–20 items per feed = roughly the last 1–6 weeks (testimony is sparse: goes back to 2023).
- Parsed with regex (no new dependencies). No auth, no observed rate limit.

### FOMC calendar (`fomc.ts`)
- `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` (~165 KB). One `panel panel-default` per year ("YYYY FOMC Meetings"), rows `div.row.fomc-meeting` with `.fomc-meeting__month` (`January`, also `Jan/Feb`, `Apr/May`, `Oct/Nov`), `.fomc-meeting__date` (`27-28`, `17-18*` = SEP meeting, `22 (notation vote)`, `30-1`). Links: statement HTML/PDF (`monetaryYYYYMMDDa`), implementation note (`…a1`), press conference (`fomcpressconf`/`fomcpresconf` — both spellings occur), projection materials (`fomcprojtabl`), minutes (`fomcminutes`) with "(Released Month DD, YYYY)".
- Page covers current year ±5 (2021–2027 in Oct 2026). Parser throws if it finds < 8 meetings (layout-change guard).

### FOMC statement
- `https://www.federalreserve.gov/newsevents/pressreleases/monetaryYYYYMMDDa.htm`, body under `<div id="article">` → `<div class="col-xs-12 col-sm-8 col-md-8">`. Newer statements open with "approved … by a 12 – 0 vote"; pre-2025 ones end with "Voting for the monetary policy action were …; Voting against …" (we derive `N–M` by counting the semicolon-separated names).
- The date must be the decision day (second day). Wrong day → 404 with a hint to use `fomc_calendar`.

### Enforcement actions (`enforcement.ts`)
- The search page `supervisionreg/enforcementactions.htm` is an Angular app (`/js/apps/main.js`) that loads
  `https://www.federalreserve.gov/supervisionreg/files/ea-cms-recent.json` (~90 KB, 385 items, 2019-01 → today) and
  `https://www.federalreserve.gov/supervisionreg/files/ea-old.json` (~566 KB, 2,514 items, 1990s → 2018-12).
  A CSV export with the same rows exists at `/supervisionreg/files/enforcementactions.csv` (458 KB). The paths **without** `/files/` serve a 46-byte stub / stale copy — do not use.
- Item fields: `id, edt (effective), tdt (termination; "1950-01-01" = none), type, bkorg | person+porg, url (absolute or site-relative), urlname, note?`. State is parsed from the trailing ", City, State" of the party string (full names or 2-letter codes; multi-party strings use the first party).
- Historical file loads only when `includeHistorical=true`, a `name` is given, or `since` < 2019. Fallback to `press_enforcement.xml` if the JSON fails.
- Board actions only; OCC/FDIC/CFPB/state actions are elsewhere.

### FiscalData auctions (`auctions.ts`)
- Base `https://api.fiscaldata.treasury.gov/services/api/fiscal_service` (same as `lib/treasury`). No auth. Numbers arrive as strings, literal `"null"` for missing. Meta uses `total-count` (hyphen), not `total_count`.
- `v1/accounting/od/auctions_query` — every auction since 1979 (~120 fields). `security_type` is only `Bill|Note|Bond`: TIPS = `inflation_index_security:eq:Yes`, FRN = `floating_rate:eq:Yes`, CMB = `cash_management_bill_cmb:eq:Yes`; the tool maps user types to those flags and labels each row's `type` accordingly. Reopenings carry odd terms (`9-Year 10-Month`), so `term` matching is client-side (`10y` matches 10-Year ±6 months). Results populate ~1:30–2 p.m. ET on auction day; same-day rows before that come back with `resultsPending`.
- `v1/accounting/od/upcoming_auctions` — next ~2 weeks; `offering_amt` is `"null"` until announced. Only Bill/Note/Bond types.
- **Not available**: the 1 p.m. when-issued yield, so a true tail/stop-through vs WI is not computed; `highMinusMedianBp` is the in-auction dispersion proxy. (TreasuryDirect's `TA_WS/securities/auctioned` JSON also responds 200 from the sandbox and has the same fields — kept as a possible fallback, not wired.)
- The proxy intermittently drops FiscalData tunnels: `fetchJson` retries the whole call once on network errors in addition to politeFetch's retry.

### TIC major foreign holders (`tic.ts`)
- `https://ticdata.treasury.gov/Publish/slt_table5.txt` — "Table 5: Major Foreign Holders of Treasury Securities", tab-separated, $bn, 13 latest months (newest first, `YYYY-MM` headers), ~20 countries + All Other + Grand Total + three "Of Which: Foreign Official" memo lines. Last-modified 2026-10-16 carrying August 2026 data (released with the monthly TIC ~6–7 weeks after month-end).
- `https://ticdata.treasury.gov/Publish/mfhhis01.txt` — long history (one 12-month block per calendar year to 2000; the current year appears only after year-end, so Table 5 supplies the recent months). Used for the `country` series. `.csv`/`.html` variants exist too.
- **Stale trap**: `…/tic/Documents/mfh.txt` and `/Publish/mfh.txt` (the URL in most docs) is a fixed-width snapshot frozen at Jan 2023. Not used.
- **Latency quirk (verified)**: ticdata.treasury.gov's edge delays responses ~10 s when the User-Agent contains an `@` or URL (0.3 s with a plain token). These two fetches therefore send `Vistamark Intel (vistamark-ria-intel)` instead of the default UA.
- Custodial caveat (TIC FAQ #7) is echoed in the output note.

### Savings bond rates (`savings.ts`)
- FiscalData has **no** I/EE rate dataset (checked: `sb_rates`, `savings_bond_rates`, `i_bond_rates`, `sb_rates_and_terms` → 404; `v2/accounting/od/sb_value` and `redemption_tables` are paper-bond redemption-value tables). Built on TreasuryDirect HTML instead:
  - `https://www.treasurydirect.gov/savings-bonds/i-bonds/i-bonds-interest-rates/` — current composite/fixed rates + window text, and three history tables (fixed rate by set date since 1998, semiannual inflation rate, current composite by purchase window).
  - `https://www.treasurydirect.gov/savings-bonds/ee-bonds/` — current EE rate + window; `…/ee-bonds/may-2005-and-later/` — EE fixed-rate history table.
- Rates reset May 1 / Nov 1. Table detection is by header text; parser throws if no rate is found.

## Verification
Smoke script: `/tmp/claude-0/-home-claude/b833aeaa-ec20-51c6-be5f-ea01232783a0/scratchpad/builders/fed-board-smoke.ts` — all 8 tools × 20 calls pass live; cold timings 0.1–0.9 s each (TIC 0.25 s after the UA fix); every result < 6,000 chars (largest: `fomc_calendar` with `links=true`, ~5.1 KB). `npx tsc --noEmit` clean for this folder.

Not verifiable from the sandbox: behaviour on FOMC day itself (statement page appears at 2:00 p.m. ET; the calendar's statement link may lag by minutes — `fomc_statement` without `date` resolves through the calendar, so pass `date` explicitly on decision day), and whether the Board's JSON file names persist across site redesigns (the page's bundle is the place to re-check: grep `main.js` for `ea-cms-recent`).
