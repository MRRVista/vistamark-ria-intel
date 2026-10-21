# filings-people

People and relationships buried in regulatory filings. Exports `FILPEOPLE_TOOLS`, `FILPEOPLE_DOMAIN` (id `filingspeople`), `FILPEOPLE_CHECKS` from `index.ts`.

| Tool | Backing | Source |
|---|---|---|
| `insider_transactions` | live | EDGAR submissions + Forms 3/4/5 ownership XML (issuer or reporting-owner mode, owner address filters) |
| `insider_by_location` | live | EDGAR full-text search (forms 3,4,5) → XML owner-address verification |
| `formd_related_persons` | live | Form D `primary_doc.xml` (accession / issuer / FTS search mode) |
| `adv_brochures` | hybrid | IAPD `api.adviserinfo.sec.gov/search/firm/<crd>` brochure list + PDF URLs; AUM from local `firms` table if present |
| `dol_sch_c_providers_by_plan` | postgres | `dol_sch_c_providers` ⋈ `plans` |
| `dol_sch_c_plans_by_provider` | postgres | `dol_sch_c_providers` ⋈ `plans` |

## Schedule C ingest
1. `POST /api/admin/migrate` (applies `migrations/0009_dol_schedule_c.sql`).
2. `POST /api/admin/refresh-dol-sch-c?year=2024` with `Authorization: Bearer $CRON_SECRET`.
   Downloads `F_SCH_C_PART1_ITEM2_<y>_Latest.zip` + `F_SCH_C_PART1_ITEM2_CODES_<y>_Latest.zip`
   from `https://www.askebsa.dol.gov/FOIA%20Files/<y>/Latest/` (the bare `askebsa.dol.gov` host 301s here).
   2024: 264,744 provider rows, ~25s against local Postgres; records an `ingest_runs` row `dol-sch-c/<y>`.
   Needs `vercel.json` `maxDuration: 300` for the route (integrator).

## Upstream quirks (verified 2026-10-21)
- EDGAR FTS `forms=D` already returns D **and** D/A; `forms=D,D/A` returns only D/A. Same root-form logic for `4` vs `4/A`.
- FTS returns one hit per indexed document; dedupe by accession.
- Ownership `primaryDocument` in submissions is the XSL path (`xslF345X06/form4.xml`); strip the prefix for raw XML.
- IAPD brochure PDFs use Type0/CID fonts, so there's no text extraction without a PDF parser.
- DOL 5500 main file now names the sponsor column `SPONSOR_DFE_NAME`, and asset totals are not in `F_5500` (they live in Schedule H/I). As a result `plans.spons_dfe_name` and `plans.tot_assets_*` are null from `lib/dol-5500` ingest (not owned here).
