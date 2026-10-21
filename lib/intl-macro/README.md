# lib/intl-macro — International Macro (IMF · OECD · BIS · World Bank)

Exports `INTLMACRO_TOOLS`, `INTLMACRO_DOMAIN` (id `intlmacro`), `INTLMACRO_CHECKS` from `index.ts`.
Every upstream is public and needs no key. No env vars.

| Tool | Upstream | Notes |
|---|---|---|
| `worldbank_indicator` | `api.worldbank.org/v2/country/{c1;c2}/indicator/{code}?format=json` | Annual, 1-2 yr lag, no forecasts |
| `worldbank_indicator_search` | `api.worldbank.org/v2/indicator?source=2` (WDI) or all sources | Catalog cached 24h (WDI ~1.5MB, all ~15MB) |
| `imf_weo` | `www.imf.org/external/datamapper/api/v1/{indicator}` | WEO/FM/GDD annual, includes projections |
| `imf_indicator_list` | `.../datamapper/api/v1/indicators` | ~130 indicators |
| `imf_sdmx_series` | `api.imf.org/external/sdmx/3.0/data/dataflow/{agency}/{flow}/{ver}/{key}` | Monthly CPI/FX (IFS successor), keyless |
| `oecd_series` | `sdmx.oecd.org/public/rest/data/{agency,dsd@df,ver}/{key}?format=csvfilewithlabels` | Presets: cli, bci, cci, short_rate, long_rate, unemployment, cpi, core_cpi |
| `bis_series` | `stats.bis.org/api/v1/data/{flow}/{key}/all` (CSV, labels=both) | Presets: policy_rate(_daily), credit_gap, credit_to_gdp, property_prices_real/_nominal, reer, neer |

## Upstream quirks (verified live 2026-10-21)
- **IMF DataMapper ignores country path segments and `?periods=`**: every call returns all economies for the indicator (~120KB). We cache each indicator for 12h and filter in the client.
- **OECD + Node fetch**: undici sends `Accept-Language: *` by default, and OECD answers **HTTP 500** to that. We send `Accept-Language: en`.
- **OECD rate limit**: about 20 requests/min per IP. Throttled calls return 429. Results are cached 6h, retries are capped at 1, and the error message tells the caller to wait.
- OECD returns 404 `NoResultsFound` for empty selections. The tool maps this to an empty `series` with a note.
- Country codes: OECD, IMF and WB use ISO3, BIS uses ISO2. `common.ts` converts the major economies both ways. Euro area aliases (`EA`, `EUROAREA`, `XM`) map to each source's own code: WB `EMU`, OECD `EA20`, BIS `XM`, IMF DataMapper `EURO`, IMF SDMX `G163`.
- SDMX-CSV comes in three label styles: OECD gives a code column followed by a label column, BIS and IMF put "CODE: Label" in the cells, and some responses are plain. `parseSdmxCsv` handles all three. `groupSdmxSeries` moves dimensions shared by every series into `commonDims` to keep output compact.
