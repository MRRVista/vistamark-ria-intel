# Fed Regional Banks family (`lib/fed-regional/`)

Exports `FEDREG_TOOLS`, `FEDREG_DOMAIN` (id `fedregional`), `FEDREG_CHECKS` from `index.ts`. All sources are public and need no key, so there are no env vars.

| Tool | Source | Format | Cache |
|---|---|---|---|
| `nyfed_reference_rates` | markets.newyorkfed.org/api/rates/... | JSON | 1h |
| `nyfed_primary_dealer` | markets.newyorkfed.org/api/pd/{list/timeseries, latest/SBN2024, get/<keyid>} | JSON | 6h (catalog 24h) |
| `nyfed_operations` | markets.newyorkfed.org/api/rp/..., /api/soma/summary.json | JSON | 1h / 6h |
| `nyfed_term_premia` | newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls | legacy BIFF .xls (~10MB) | 6h |
| `nyfed_recession_probability` | .../research/capital_markets/yield/assets/data/yield.csv (fallback allmonth.xls) | CSV | 6h |
| `atlfed_gdpnow` | atlantafed.org/-/media/.../gdpnow/GDPTrackingModelDataAndForecasts.xlsx (~11MB) | xlsx | 6h |
| `atlfed_wage_tracker` | atlantafed.org/-/media/.../wage-growth-tracker/wage-growth-data.xlsx | xlsx | 24h |
| `philfed_spf` | philadelphiafed.org/-/media/.../historical-data/medianLevel.xlsx + medianGrowth.xlsx | xlsx | 24h |

## Files
- `common.ts`: TTL cache that shares one in-flight request between concurrent callers, fetch helpers built on `politeFetch`, and date/number normalization.
- `xlsx.ts`: reads one xlsx sheet at a time into a positional grid (adm-zip + fast-xml-parser) and turns date-styled cells into ISO dates.
- `biff.ts`: minimal reader for legacy BIFF8 .xls files (OLE2 container, shared string table with CONTINUE records, and NUMBER, RK, MULRK, LABELSST, LABEL and numeric FORMULA cells). It exists because the NY Fed publishes the ACM data only as .xls. Its output was checked cell for cell against xlrd on the live file.
- `nyfed-markets.ts`, `nyfed-research.ts`, `atlfed.ts`, `philfed.ts`: the tool handlers.

## Quirks
- **ACM** has no xlsx or CSV with the full curve. `acmPlot_data.csv` (the interactive chart's feed) has the 10y term premium only and is used as the fallback.
- **Recession probability**: the ycfaq page is an Angular shell. Its data comes from `yield/assets/data/yield.csv`, which includes the 12 forward months already implied by the observed spread.
- **GDPNow** URLs moved from `/cqer/research/gdpnow` to `/research-and-data/data/gdpnow`. The old `frbatlanta.org/-/media/Documents/cqer/...` link is still on the page.
- **Primary dealer**: some weekly values are suppressed (`"*"`). When that happens the snapshot adds `lastReported` from history.
- **SPF** horizon 1 (the quarter before the survey) is dropped. RGDP annual growth is derived from the median levels (A→B, B→C, C→D).
