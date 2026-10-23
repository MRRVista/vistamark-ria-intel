# Research Datasets family (`lib/research/`)

Free academic and practitioner datasets for CIO work. Every source is live and needs no key. Downloads are cached in memory: Cboe 6h; Shiller 12h; Ken French daily files 12h; everything else 24h.

| Tool | Upstream (verified 2026-10-21) | Format |
|---|---|---|
| `kfrench_factors` | `mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/<Name>_CSV.zip` | CSV in zip, multi-section |
| `kfrench_dataset` | same, plus catalog scraped from `data_library.html` | CSV in zip |
| `aqr_factors` | `aqr.com/-/media/AQR/Documents/Insights/Data-Sets/<Name>.xlsx` (public, no login) | xlsx |
| `damodaran_erp` | `pages.stern.nyu.edu/~adamodar/pc/datasets/histimpl.xlsx` + `pc/implprem/ERPbymonth.xlsx` | xlsx |
| `damodaran_industry` | `pages.stern.nyu.edu/~adamodar/pc/datasets/<file>.xls` (xlsx 404s) | legacy .xls |
| `shiller_cape` | blob link scraped from `shillerdata.com`; last-known blob as fallback; frozen Yale copy as a last resort | legacy .xls |
| `cboe_vol_history` | `cdn.cboe.com/api/global/us_indices/daily_prices/<SYM>_History.csv` | CSV |

## Notes
- **Legacy .xls**: `xls.ts` is a small built-in BIFF8 reader (OLE2 + SST/LABELSST/NUMBER/RK/MULRK/FORMULA cached values). Its output was checked against xlrd for Shiller's ie_data.xls and Damodaran's wacc/betas/vebitda files.
- **Shiller**: the Yale URL still answers but its data stops at Sep-2023. The datahub/GitHub CSV mirror is filled with zeros after 2023. The shillerdata.com page sometimes stalls or returns 503, so the page fetch uses an 8s timeout with no retry, then falls back to the known blob URL.
- **AQR**: only the monthly files are wired in. The daily files are 25–32 MB each.
- **Cboe**: VIX1D, VIX1Y, OVX, GVZ and VXN return a 307 redirect from the CDN and are not supported.
- **Damodaran**: pe, pbv and ps are published for the US only. The other datasets also come in Global, Europe, Japan, emerg, China, India and Rest variants.
