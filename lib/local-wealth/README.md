# lib/local-wealth — Local Wealth Signals & Contact Tools

Hinsdale-area (60521; DuPage + Cook, IL) wealth signals plus low-cost professional contact tools.
Exports `LOCALWEALTH_TOOLS`, `LOCALWEALTH_DOMAIN` (id `localwealth`), `LOCALWEALTH_CHECKS`.

| Tool | Source | Key |
|---|---|---|
| `cook_parcel_sales` | Cook Assessor Socrata: Parcel Sales `wvhk-k5uv` + Parcel Addresses `3723-97qp` + Residential Characteristics `x54s-btds` | none |
| `dupage_parcel_sales` | IDOR PTAX-203 `it54-y4c6` (DuPage) × DuPage GIS ParcelsWithRealEstateCC | none |
| `il_ptax_transfers` | IDOR PTAX-203 `it54-y4c6` + Additional Buyers `dwt7-rycp` (data.illinois.gov) | none |
| `idfpr_licensee_search` | IDFPR Professional Licensing `pzzh-kp68` (data.illinois.gov) | none |
| `hunter_domain_search`, `hunter_email_finder`, `hunter_email_verifier`, `hunter_account` | api.hunter.io/v2 | `HUNTER_API_KEY` |
| `zerobounce_validate`, `zerobounce_credits` | api.zerobounce.net/v2 (`validate`, `validatebatch`, `getcredits`) | `ZEROBOUNCE_API_KEY` (optional `ZEROBOUNCE_API_BASE` for api-us/api-eu) |

Optional: `SOCRATA_APP_TOKEN`, sent as X-App-Token to both Socrata hosts for higher throttling limits.

## Notes
- **Cook sales** lag recording by about 2 months. PTAX lags by about 1 week. Cook-side Hinsdale is about 1,090 PINs, all in Lyons township (21).
- **DuPage** publishes no open sale price or sale date layer. Its GIS services carry owner, bill name and assessed value only, so PTAX-203 is the DuPage sales source.
- **PTAX** covers 2013 onward, statewide, with a weekly refresh. Buyer and seller names are included. Buyer mailing addresses are not.
- **Professional-only**: there is no option to reveal personal email, and Hunter webmail hits are dropped. ZeroBounce validation must pass before anything is sent, followed by the draft-then-approve gate.

## Not built
- **IL Secretary of State business entities**: there is no free API. The public search is a web UI only, and bulk data is sold (14 Ill. Adm. Code 178.40: $1,500 for the LLC file plus $400 per monthly update). Not scraped.
- **ARDC attorneys**: no API.
- **FEC contribution data**: deliberately excluded.
