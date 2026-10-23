-- v0.33 schema: IRS Exempt-Organization "extras" — Publication 78, the
-- Automatic Revocation list, and 990-N (e-Postcard) filers.
--
-- Sources (IRS TEOS bulk downloads, one pipe-delimited text file per zip,
-- CRLF, no header row, republished roughly monthly):
--   https://apps.irs.gov/pub/epostcard/data-download-pub78.zip       (~30 MB zip / 100 MB txt, 1.43M rows)
--   https://apps.irs.gov/pub/epostcard/data-download-revocation.zip  (~48 MB zip / 148 MB txt, 1.25M rows)
--   https://apps.irs.gov/pub/epostcard/data-download-epostcard.zip   (~93 MB zip / 286 MB txt, 1.55M rows)
--
-- Loader: scripts/irs-eo-extras-ingest.ts, run by the GitHub Actions
-- workflow "IRS EO extras ingest" (.github/workflows/irs-eo-extras-ingest.yml)
-- on the 10th of each month. Each dataset is a FULL REFRESH: the loader fills
-- <table>_new, then swaps it in under a single transaction, so readers never
-- see a half-loaded table. The ledger irs_eo_extras_loads records every run;
-- ingest_runs rows (source 'irs-eo-extras/<dataset>') feed database_status.
--
-- All three are public IRS files (the same data TEOS serves one org at a
-- time). The 990-N file carries a principal officer's mailing address; that
-- address is STORED (officer_address1/2) but the MCP tools never emit it by
-- default — city/state/zip only.
--
-- EIN joins: nonprofits (BMF), irs990_filings, irs990_persons.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS irs_eo_extras_loads (
  id             SERIAL PRIMARY KEY,
  dataset        VARCHAR(16) NOT NULL,          -- pub78 | revocation | 990n
  url            TEXT NOT NULL,
  source_last_modified TIMESTAMP,               -- Last-Modified header of the zip
  bytes          BIGINT,                        -- zip bytes downloaded
  started_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMP,
  status         VARCHAR(16) NOT NULL DEFAULT 'running',  -- running | ok | error
  rows_read      INTEGER NOT NULL DEFAULT 0,
  rows_loaded    INTEGER NOT NULL DEFAULT 0,
  rows_rejected  INTEGER NOT NULL DEFAULT 0,    -- malformed lines (field-count / date parse)
  error_sample   JSONB,
  error_message  TEXT,
  runner         TEXT                           -- 'github-actions:<run_id>' | 'local'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_eo_extras_loads_dataset_idx ON irs_eo_extras_loads (dataset, started_at DESC);
--> statement-breakpoint
-- Publication 78: organizations eligible to receive tax-deductible contributions.
-- One row per EIN. deductibility_codes is the raw comma list (PC, PF, POF,
-- SO, SONFI, SOUNK, EO, GROUP, LODGE, FORGN, UNKWN); decoded in the tools.
CREATE TABLE IF NOT EXISTS irs_pub78 (
  ein                 VARCHAR(9) PRIMARY KEY,
  name                TEXT NOT NULL,
  city                VARCHAR(128),
  state               VARCHAR(4),
  country             VARCHAR(64),              -- 'United States' or a foreign country name
  deductibility_codes VARCHAR(64) NOT NULL,
  loaded_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_pub78_state_idx ON irs_pub78 (state, city);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_pub78_name_trgm_idx ON irs_pub78 USING GIN (name gin_trgm_ops);
--> statement-breakpoint
-- Automatic Revocation of Exemption (IRC 6033(j): three consecutive years of
-- missed 990/990-EZ/990-N). One row per EIN + revocation date; an EIN that was
-- revoked, reinstated, and revoked again appears twice. reinstatement_type is
-- reserved — the IRS file carries a reinstatement DATE only.
CREATE TABLE IF NOT EXISTS irs_eo_revocations (
  ein                 VARCHAR(9) NOT NULL,
  revocation_date     DATE NOT NULL,
  name                TEXT NOT NULL,
  dba                 TEXT,
  address             TEXT,
  city                VARCHAR(128),
  state               VARCHAR(4),
  zip                 VARCHAR(32),
  country             VARCHAR(8),
  exemption_type      VARCHAR(4),               -- BMF subsection code as text: '03' = 501(c)(3), '00' = unknown/4947(a)(1)
  posting_date        DATE,
  reinstatement_date  DATE,
  reinstatement_type  VARCHAR(16),
  loaded_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ein, revocation_date)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_eo_revocations_state_idx ON irs_eo_revocations (state, city);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_eo_revocations_date_idx ON irs_eo_revocations (revocation_date DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_eo_revocations_name_trgm_idx ON irs_eo_revocations USING GIN (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_eo_revocations_zip_idx ON irs_eo_revocations (zip varchar_pattern_ops);
--> statement-breakpoint
-- 990-N e-Postcard filers (gross receipts normally <= $50K). The IRS file
-- holds the MOST RECENT postcard per EIN (1.55M rows, 1.55M distinct EINs),
-- so (ein, tax_year) is effectively one row per org; the PK keeps history if
-- the IRS ever ships more than one year per EIN. Officer = the "principal
-- officer" the filer named — the only people index that exists for orgs too
-- small to file a 990/990-EZ (no Part VII).
CREATE TABLE IF NOT EXISTS irs_990n (
  ein                      VARCHAR(9) NOT NULL,
  tax_year                 SMALLINT NOT NULL,
  name                     TEXT NOT NULL,
  gross_receipts_under_50k BOOLEAN,
  terminated               BOOLEAN NOT NULL DEFAULT FALSE,
  tax_period_begin         DATE,
  tax_period_end           DATE,
  website                  TEXT,
  officer_name             TEXT,
  officer_address1         TEXT,                -- stored, never emitted by tools by default
  officer_address2         TEXT,                -- stored, never emitted by tools by default
  officer_city             VARCHAR(128),
  officer_province         VARCHAR(64),         -- foreign addresses only
  officer_state            VARCHAR(8),
  officer_zip              VARCHAR(32),
  officer_country          VARCHAR(8),
  org_address1             TEXT,
  org_address2             TEXT,
  org_city                 VARCHAR(128),
  org_province             VARCHAR(64),
  org_state                VARCHAR(8),
  org_zip                  VARCHAR(32),
  org_country              VARCHAR(8),
  dba1                     TEXT,
  dba2                     TEXT,
  dba3                     TEXT,
  loaded_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ein, tax_year)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_990n_org_state_idx ON irs_990n (org_state, org_zip);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_990n_officer_state_idx ON irs_990n (officer_state, officer_zip);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_990n_tax_year_idx ON irs_990n (tax_year);
--> statement-breakpoint
-- varchar_pattern_ops so `zip LIKE '60521%'` is an index range scan under any collation
CREATE INDEX IF NOT EXISTS irs_990n_org_zip_idx ON irs_990n (org_zip varchar_pattern_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_990n_officer_zip_idx ON irs_990n (officer_zip varchar_pattern_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_990n_name_trgm_idx ON irs_990n USING GIN (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs_990n_officer_trgm_idx ON irs_990n USING GIN (officer_name gin_trgm_ops);
