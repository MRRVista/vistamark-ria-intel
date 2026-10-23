# Housing Markets family (`lib/housing/`)

Market-level home values, rents, inventory and official price indices for the places prospects live (Hinsdale 60521, DuPage/Cook, Chicago metro, Illinois, US). `lib/local-wealth` holds parcel-level **sales**; this family holds **indices**. Everything except HUD is keyless. Large files are streamed line by line (`common.ts/streamCsvLines`) and only the matching rows are kept; results are cached in memory 12–24 h.

| Tool | Upstream (verified live from the sandbox 2026-10-22) | Size / cold time |
|---|---|---|
| `zillow_zhvi` | `https://files.zillowstatic.com/research/public_csvs/zhvi/<Geo>_zhvi_uc_<sfrcondo\|sfr\|condo>_tier_<0.33_0.67\|0.67_1.0\|0.0_0.33>_sm_sa_month.csv`, `<Geo>_zhvi_bdrmcnt_<4\|5>_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv` | Zip 117–125 MB (streamed, 1.4–3 s; cancels at the matched zip), City 95 MB (streamed, ~2.5 s), County 13.7 MB, Metro 4.5 MB, State 0.3 MB (parsed once, 12 h) |
| `zillow_dataset` | same host; 34 verified keys across `zori`, `invt_fs`, `new_listings`, `new_pending`, `median_sale_price`, `sales_count_now`, `mlp`, `mean_doz_pending`, `med_doz_pending`, `mean_days_to_close`, `perc_listings_price_cut`, `mean_listings_price_cut_amt/perc`, `median_sale_to_list`, `pct_sold_above/below_list`, `market_temp_index`, `new_con_*`, `new_homeowner_income_needed`, `new_homeowner_affordability`, `total_monthly_payment`, `zhvf_growth` (see `ZILLOW_DATASETS` in zillow.ts for the exact file stems) | 0.05–20 MB each, parsed once, 12 h |
| `fhfa_hpi` | `https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv` (17 MB, 186k rows; holds monthly AND quarterly series — `/quarterly/hpi_master.csv` 404s). ZIP: `https://www.fhfa.gov/hpi/download/annual/hpi_at_zip3.xlsx` (1.9 MB) and `.../annual/hpi_at_zip5.xlsx` (40 MB; sheet XML is 240 MB) | master ~1–2.5 s cold, cached 12 h; zip3 0.7 s cached 24 h; zip5 ~4 s per zip (streamed inflate), cached 24 h per zip |
| `realtor_inventory` | `https://econdata.s3.us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_<Zip\|County\|Metro\|State>.csv` (latest month) and `..._History.csv` (Jul-2016 onward, newest-first) | latest: 7 MB / 0.9 MB / 0.3 MB / 17 KB; history: 837 MB / 103 MB / 33 MB / 1.9 MB — streamed and cancelled after N months (13 months of zips = 95 MB, ~2 s; 25 months of metros = 7 MB) |
| `hud_fair_market_rents` | `https://www.huduser.gov/hudapi/public/fmr/data/<entityid>?year=`, `/fmr/statedata/<ST>`, `/fmr/listCounties/<ST>`, `/fmr/listMetroAreas` — `Authorization: Bearer $HUD_API_KEY` | small JSON, 24 h |
| `hud_usps_crosswalk` | `https://www.huduser.gov/hudapi/public/usps?type=<1-12>&query=<id>[&year&quarter]` — same token | small JSON, 24 h |

## Zillow notes
- Files are wide (one column per month-end), sorted by `SizeRank`, **not** by zip, so a zip lookup scans until it hits the row; 60521 is SizeRank 7182 so the 125 MB file stops after ~35 MB. A nonexistent zip reads the whole file (~2.5 s).
- Tradeoff considered: a 12 h `{zip -> row}` index per lambda would hold ~75 MB of heap per tier/type combination and only helps the second distinct zip in a warm lambda. Per-query streaming with a 12 h per-query cache was kept; cold latency is the same, repeat lookups are 0 ms either way.
- Top tier (`tier_0.67_1.0`) is what fits Hinsdale: Sep-2026 top-tier ZHVI for 60521 is $2.11M vs $1.26M mid tier.
- Coverage below metro thins out for listing-based files: 60521 has `inventory`, `new_listings`, `median_list_price`, `days_to_pending_*`, `pct_listings_price_cut`, `market_heat`, `zhvf_growth` but **no** `zori` or `median_sale_price` row (use county DuPage / metro Chicago). ZORI zips/cities exist only for larger rental markets (Naperville, Downers Grove, Elmhurst…).
- `sales_count_now`, `median_sale_price_raw`, `mean_days_to_close`, affordability and new-construction files are metro-only; `County_sales_count_now…` and `County_zhvf_growth…` 404.
- Share-type files (`perc_listings_price_cut`, affordability, pct_sold_*) are published as fractions and are scaled to percent; the shaped `change` for those is a relative change of the share, not percentage points.
- Refresh: monthly, around the 16th–20th for the prior month (`Last-Modified: 16 Oct 2026`, latest column `2026-09-30`).

## FHFA notes
- Master CSV columns: `hpi_type,hpi_flavor,frequency,level,place_name,place_id,yr,period,index_nsa,index_sa,rstderr,note`. Series: traditional purchase-only monthly (USA + 9 divisions, SA/NSA), purchase-only / all-transactions / expanded-data quarterly (USA, divisions, states, ~400 MSAs/MSADs), distress-free purchase-only (MSA), non-metro all-transactions (state), manufactured and developmental (USA/divisions, Puerto Rico). Default picks purchase-only, monthly where it exists, SA where published.
- Chicago appears as `Chicago-Naperville-Schaumburg, IL (MSAD)` with `place_id` 16984 (the MSAD, not CBSA 16980). `place` accepts the id.
- ZIP indexes are annual, NSA, all-transactions, experimental, updated each March ("Last updated: March 31, 2026", data through 2025). The zip5 workbook is too large for the research-family xlsx grid reader (840 MB RSS), so `fhfa.ts` parses the zip container itself and inflates `sheet1.xml` through `zlib.inflateRaw` as a stream, scanning `<row>` blocks for the requested ZIP (~4 s, +~120 MB transient for the compressed buffer).
- Release cadence: monthly/quarterly releases ~2 months after period end; the sandbox file had data through 2026Q2 / Aug-2026.

## Realtor.com notes
- The documented host `http://econdata.s3-website-us-west-2.amazonaws.com/...` is HTTP-only; the sandbox proxy returns 000 for https and 404 for http on it. The bucket's REST endpoint `https://econdata.s3.us-west-2.amazonaws.com/Reports/Core/...` (and `econdata.s3.amazonaws.com`) serves the same objects with `Last-Modified` and `Accept-Ranges`, verified 200.
- Columns: `month_date_yyyymm`, id/name pair (`postal_code,zip_name` | `county_fips,county_name` | `cbsa_code,cbsa_title,HouseholdRank` | `state,state_id`), then for each metric the level, `_mm` and `_yy` as decimal fractions, and `quality_flag`. Shares (`price_reduced_share`, `pending_ratio`, …) are fractions and are returned in percent.
- History files are sorted by month descending, so trailing-N-month queries stream from the top and cancel at the first older month. Zip queries are capped at 25 months (~180 MB stream); county/metro/state at 60.
- Latest month in the sandbox: 202609 (published 2026-09-30). Monthly, ~1 week after month end.

## HUD notes (not verified with a live token)
- Registration: https://www.huduser.gov/hudapi/public/register (free). Env var: `HUD_API_KEY`. Both tools throw `HUD_API_KEY not configured — …` before any network call when it is missing; with a bad token the 401 is mapped to a clear message.
- Without a token the sandbox got `401 {"error":"Unauthenticated"}` from both `/fmr/data/METRO16980M16980?year=2026` and `/usps?type=2&query=60521`, confirming the endpoints exist. HUD's docs pages could not be fetched through the proxy (empty body), so the response field names (`data.basicdata.{Efficiency,One-Bedroom,…}`, Small Area FMR arrays, `data.results[].{geoid,res_ratio,…}`) follow the published API documentation from memory and should be checked on the first keyed call; `hud_fair_market_rents` returns `raw` when `basicdata` is missing so a mismatch is visible rather than silent.
- Entity ids: county = 5-digit FIPS + `99999` (DuPage `1704399999`); metro = `METRO<cbsa>M<cbsa>`. Rate limit per HUD docs: 1,200 requests/min.

## Not built
- FHFA quarterly ZIP3 (`hpi_at_3zip.xlsx`, 3 MB) and county (`hpi_at_county.xlsx`, 5 MB) workbooks exist and could be wired into `fhfa_hpi` the same way as zip3; left out to keep the surface small.
- Zillow Neighborhood-level files (104 MB) are routed through the same streamer but no Hinsdale-area neighbourhood rows exist, so only `zillow_zhvi` exposes `geography: neighborhood`.
