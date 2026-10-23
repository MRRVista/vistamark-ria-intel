# Energy & Commodities family (`lib/energy/`)

Catalog id `energy` — "Energy & Commodities (EIA · CFTC COT · Baker Hughes)".
Exports `ENERGY_TOOLS`, `ENERGY_DOMAIN`, `ENERGY_CHECKS` from `index.ts`.

| tool | source | auth | verified live from sandbox (2026-10-22) |
|---|---|---|---|
| `eia_series` | EIA Open Data API v2 | `EIA_API_KEY` | request shape + error path only (no key in sandbox) |
| `eia_browse` | EIA Open Data API v2 | `EIA_API_KEY` | same |
| `cftc_cot` | CFTC Public Reporting (Socrata) | none | yes — gold, WTI, UST 10Y, ES, EURO FX, all 3 reports, combined |
| `cftc_cot_markets` | CFTC Public Reporting (Socrata) | none | yes |
| `baker_hughes_rig_count` | rigcount.bakerhughes.com xlsx | none | **no** — publisher CDN returns 403 to the sandbox; parser exercised on synthetic workbooks only |

Overlap with existing tools: `fred_get_series` already serves daily WTI
(`DCOILWTICO`), Brent (`DCOILBRENTEU`) and Henry Hub (`DHHNGSP`) keylessly.
Descriptions point the model there for spot prices and to `eia_series` for
EIA-only data (inventories, storage, production, electricity, STEO).

Env vars introduced: `EIA_API_KEY` (required for the two EIA tools),
`BAKER_HUGHES_RIG_XLSX_URL` (optional override of the workbook download),
`SOCRATA_APP_TOKEN` (optional, already used by local-wealth; raises CFTC throttle ceiling).

---

## EIA Open Data API v2 (`eia.ts`)

Docs: https://www.eia.gov/opendata/documentation.php (read 2026-10-22).

- Base `https://api.eia.gov/v2/`. HTTPS only. **`api_key` must be a query
  parameter** — headers are not read.
- Route metadata: `GET /v2/<route>` → `response.routes[]` for a parent, or
  `response.frequency[] / facets[] / data{} / startPeriod / endPeriod /
  defaultDateFormat / defaultFrequency` for a dataset.
- Facet values: `GET /v2/<route>/facet/<facetId>` → `response.facets[{id,name,alias}]`, `totalFacets`.
- Data: `GET /v2/<route>/data/?api_key=K&frequency=daily&data[0]=value&facets[series][]=RWTC&start=…&end=…&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=60`
  → `response.data[]` (rows: `period`, facet ids + `*Description`/`*Name`
  companions, requested value columns **as strings**, `<col>-units`),
  `response.total`, `response.dateFormat`, `response.frequency`,
  optional `response.warning`.
- JSON hard cap 5,000 rows per request; we cap `length` at 60 and page with `offset`.
- Errors: HTTP 403 + `{"error":{"code":"API_KEY_INVALID","message":…}}`
  — verified live from the sandbox with a dummy key (both `/data/` and the
  route-metadata endpoints). Missing env → tool throws
  `EIA_API_KEY not configured — register a free key at https://www.eia.gov/opendata/register.php …`
  before any network call (0 ms, confirmed by smoke test).
- Rate limits: EIA throttles per second and per hour without publishing
  numbers; a tripped key is suspended temporarily. Cache: 30 min for data,
  24 h for route/facet metadata.
- Known routes/facets used in descriptions (from EIA docs and series ids;
  **not callable from the sandbox**, so treat as documented not verified):
  `petroleum/pri/spt` (`series`: RWTC, RBRTE), `natural-gas/pri/fut`
  (`series`: RNGWHHD, RNGC1…), `natural-gas/stor/wkly`, `petroleum/stoc/wstk`,
  `petroleum/sum/sndw`, `petroleum/crd/drill`, `electricity/retail-sales`
  (`stateid`, `sectorid`; data `price`,`sales`,`revenue`), `total-energy`
  (`msn`), `steo` (`seriesId`).
- Output: rows grouped per series (by facet ids present, or `groupBy`),
  ascending-sorted; per series `latest`, `window` (period change, window
  change, min/max/mean over the returned rows), `observations`. Window stats
  cover only the rows returned.

## CFTC Commitments of Traders (`cftc.ts`)

Host `https://publicreporting.cftc.gov/resource/<id>.json` (Socrata SODA 2.x,
anonymous OK). All verified live 2026-10-22; latest `report_date_as_yyyy_mm_dd`
was `2026-10-13` (Tuesday positions, released Friday 10/17).

| report | futures-only | combined |
|---|---|---|
| Legacy | `6dca-aqww` | `jun7-fc8e` |
| Disaggregated | `72hh-3qpy` | `kh3c-gbw2` |
| TFF | `gpe5-46if` | `yw9f-hn96` |

Field names confirmed live (note CFTC's own typos):

- common: `market_and_exchange_names`, `contract_market_name`,
  `cftc_contract_market_code`, `commodity_name`, `commodity_subgroup_name`,
  `commodity_group_name`, `contract_units`, `open_interest_all`,
  `change_in_open_interest_all`, `traders_tot_all`, `tot_rept_positions_long_all`,
  `tot_rept_positions_short`, `nonrept_positions_long_all`, `nonrept_positions_short_all`
- legacy: `noncomm_positions_long_all`, `noncomm_positions_short_all`,
  `noncomm_postions_spread_all` (sic), `comm_positions_long_all`, `comm_positions_short_all`
- disaggregated: `prod_merc_positions_long`, `prod_merc_positions_short`,
  `swap_positions_long_all`, `swap__positions_short_all` (double underscore),
  `swap__positions_spread_all`, `m_money_positions_long_all`,
  `m_money_positions_short_all`, `m_money_positions_spread`,
  `other_rept_positions_long`, `other_rept_positions_short`, `other_rept_positions_spread`
- TFF: `dealer_positions_long_all/short_all/spread_all`,
  `asset_mgr_positions_long/short/spread`, `lev_money_positions_long/short/spread`,
  `other_rept_positions_long/short/spread`
- numbers arrive as strings; dates as `2026-10-13T00:00:00.000`.

Queries used: market search is a `$group` aggregate
(`max(report_date_as_yyyy_mm_dd) as latest, max(open_interest_all) as oi`,
`upper(market_and_exchange_names) like '%WORD%'` per word, restricted to the
last 120 days); history is `$where cftc_contract_market_code='…' $order date DESC $limit N`.
Typical latency 200–1,100 ms. No 429s observed; `politeFetch` retries once
(1.5 s backoff) if one occurs.

Market naming is terse — aliases in `KEYWORD_ALIASES` map common phrases
("10-year", "spx", "crude", "nat gas", "dollar index", "bitcoin") to CFTC
names (`UST 10Y NOTE`, `E-MINI S&P 500`, `WTI-PHYSICAL`, `NAT GAS NYME`,
`USD INDEX`, `BITCOIN`). Resolution prefers an exact contract-name match, else
highest open interest; `alternatives` lists the runners-up. Some alias targets
(`USD INDEX`, `NASDAQ MINI`, `RUSSELL E-MINI`, `DJIA`, `VIX FUTURES`,
`BITCOIN`, `SOFR-3M`, product names) were not individually confirmed and fall
back to the raw keyword if the alias finds nothing.

Verified outputs: GOLD 088691 (Non-Comm net +207,879, 52w pct 66),
WTI-PHYSICAL 067651 disaggregated (Managed Money net +40,574),
UST 10Y NOTE 043602 TFF (Leveraged Funds net −2.21 M), E-MINI S&P 500 13874A
TFF combined, EURO FX 099741 legacy (crowded short reading).

## Baker Hughes North America rig count (`bakerhughes.ts`)

Page: https://rigcount.bakerhughes.com/na-rig-count (read via a web reader
on 2026-10-22; **every direct request from the sandbox — page, static-files,
and the `bakerhughesrigcount.gcs-web.com` mirror — returned Akamai
HTTP 403 "Access Denied"**, so the workbook could not be downloaded or parsed here).

Downloads listed on the page (all `https://rigcount.bakerhughes.com/static-files/<uuid>`):

- "North America Rig Count Report - New Report" — .xlsx 7.3 MB, posted 10/16/26,
  id `358a48a1-54c1-4d36-80c6-e61563abadf9` (built-in fallback; the id likely
  rotates with each weekly post, so the tool scrapes the page first).
- "North America Rig Count New Report (2013-Aug 2025)" — .xlsx 11.7 MB archive.
- "North America Rotary Rig Count (Jan 2000 - Mar 2024)" — **.xlsb**, frozen
  Mar 2024. This is the file the brief called "(Jan 2000 - Current)"; it is no
  longer current and .xlsb cannot be read by `lib/research/xlsx.ts`.
- Baker Hughes FAQ: the new report has NAM Summary / NAM Breakdown /
  Yearly / Quarterly / Monthly / Weekly views filterable by Country, County,
  Basin, GOM, Drill For, Location, State/Province, Trajectory,
  Year/Quarter/Month/US_PublishDate and Rig Count Value. Published Fridays at
  noon CT. Headline on 10/16/2026: U.S. 603 (0 w/w, +55 y/y), Canada 217.

Implementation: downloads via `politeFetch`, validates the ZIP magic, lists
sheets with `xlsxSheetNames`, and sniffs each sheet's first 60 rows for either
a LONG table (Country / Drill For / US_PublishDate|PublishDate|Date / Rig
Count) which is aggregated to weekly US + Canada oil/gas/misc, or a WIDE table
(Date + Oil/Gas/Misc/Total columns under U.S./Canada group headers). Both
sniffers pass on synthetic workbooks (see
`scratchpad/builders/bhsynth/`). Output carries `unverified: true` and
`provenance.layoutDetected` so the first live run can be checked against the
headline count. If Vercel's egress is also blocked, the error message says so
and points to `BAKER_HUGHES_RIG_XLSX_URL` and to EIA route `petroleum/crd/drill`.

## Selftest checks (`ENERGY_CHECKS`)

1. `cftc_cot {market:"GOLD", weeks:2}` — ~1.1 s cold.
2. `cftc_cot_markets {search:"UST", report:"tff", limit:5}` — ~0.3 s.
3. `eia_browse {route:"petroleum/pri/spt"}` — fails fast (0 ms) with
   `EIA_API_KEY not configured` until the key is set.

`baker_hughes_rig_count` is deliberately not in the checks until a live run confirms it.
