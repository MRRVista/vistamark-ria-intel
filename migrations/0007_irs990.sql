-- v0.28.0 schema: IRS Form 990 e-file returns — filings + Part VII people.
--
-- Source: IRS TEOS bulk XML (apps.irs.gov/pub/epostcard/990/xml/<year>/).
-- The IRS publishes one CSV index per index-year plus ~12-16 zip batches of
-- per-return XML. There is no API. The loader runs OUTSIDE Vercel (GitHub
-- Actions, scripts/irs990-ingest.ts) because a single batch is 50-500 MB.
--
-- Three tables:
--   irs990_batches  — one row per IRS zip batch we have loaded (idempotency
--                     key for the monthly run; a batch is re-loaded only when
--                     forced).
--   irs990_filings  — one row per e-filed return (990 / 990-EZ / 990-PF),
--                     keyed on the IRS OBJECT_ID. Carries the header, the
--                     financial summary, and governance counts.
--   irs990_persons  — one row per officer / director / trustee / key employee
--                     listed on the return (990 Part VII Section A, 990-EZ
--                     Part IV, 990-PF Part VII). This is the "every nonprofit
--                     board member in the United States" table.
--
-- Plus one view:
--   irs990_latest_filings — the most recent return per EIN (latest tax period,
--                     then latest return timestamp), which is what "current
--                     board" means.
--
-- Public data (IRS releases these for public inspection), so no PII gating
-- beyond the ordinary token/session lanes. 990-PF is the only form that
-- carries a per-person address; 990 and 990-EZ carry name/title/hours/comp.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS irs990_batches (
  batch_id        VARCHAR(32) PRIMARY KEY,          -- e.g. '2025_TEOS_XML_10A'
  index_year      SMALLINT NOT NULL,
  url             TEXT NOT NULL,
  bytes           BIGINT,
  started_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMP,
  status          VARCHAR(16) NOT NULL DEFAULT 'running',  -- running | ok | error
  files_total     INTEGER NOT NULL DEFAULT 0,
  filings_loaded  INTEGER NOT NULL DEFAULT 0,
  filings_skipped INTEGER NOT NULL DEFAULT 0,       -- 990-T and unparseable
  persons_loaded  INTEGER NOT NULL DEFAULT 0,
  parse_errors    INTEGER NOT NULL DEFAULT 0,
  error_sample    JSONB,
  error_message   TEXT,
  runner          TEXT                              -- 'github-actions:<run_id>' | 'local'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS irs990_filings (
  object_id             VARCHAR(24) PRIMARY KEY,    -- IRS OBJECT_ID (zip entry name prefix)
  batch_id              VARCHAR(32) NOT NULL REFERENCES irs990_batches(batch_id),
  ein                   VARCHAR(9) NOT NULL,
  return_type           VARCHAR(8) NOT NULL,        -- 990 | 990EZ | 990PF
  tax_year              SMALLINT,
  tax_period_begin      DATE,
  tax_period_end        DATE,
  return_ts             TIMESTAMP,
  amended_return        BOOLEAN NOT NULL DEFAULT FALSE,
  final_return          BOOLEAN NOT NULL DEFAULT FALSE,
  return_version        VARCHAR(16),                -- schema version, e.g. '2023v6.0'
  org_name              TEXT NOT NULL,
  org_name2             TEXT,
  in_care_of            TEXT,
  address_line1         TEXT,
  address_line2         TEXT,
  city                  VARCHAR(128),
  state                 VARCHAR(4),
  zip                   VARCHAR(16),
  country               VARCHAR(4),
  website               TEXT,
  phone                 VARCHAR(24),
  formation_year        SMALLINT,
  mission               TEXT,                       -- truncated to 2000 chars
  gross_receipts        BIGINT,
  total_revenue         BIGINT,
  total_expenses        BIGINT,
  total_assets_eoy      BIGINT,
  total_liabilities_eoy BIGINT,
  net_assets_eoy        BIGINT,
  contributions         BIGINT,
  investment_income     BIGINT,
  investments_public    BIGINT,                     -- 990 Part X line 11 (publicly traded securities, EOY)
  investments_other     BIGINT,                     -- 990 Part X line 12 (other securities, EOY)
  investments_program   BIGINT,                     -- 990 Part X line 13 (program-related, EOY)
  endowment_eoy         BIGINT,                     -- 990 Schedule D Part V, current-year end balance
  invest_mgmt_fees      BIGINT,                     -- 990 Part IX line 11f (investment management fees)
  voting_members        INTEGER,
  independent_members   INTEGER,
  employees             INTEGER,
  volunteers            INTEGER,
  officer_count         INTEGER NOT NULL DEFAULT 0,
  signer_name           TEXT,                       -- ReturnHeader BusinessOfficerGrp
  signer_title          TEXT,
  loaded_at             TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_ein_period_idx ON irs990_filings (ein, tax_period_end DESC, return_ts DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_state_idx ON irs990_filings (state, city);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_type_year_idx ON irs990_filings (return_type, tax_year);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_assets_idx ON irs990_filings (total_assets_eoy DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_name_trgm_idx ON irs990_filings USING GIN (org_name gin_trgm_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS irs990_persons (
  id                    BIGSERIAL PRIMARY KEY,
  object_id             VARCHAR(24) NOT NULL REFERENCES irs990_filings(object_id) ON DELETE CASCADE,
  ein                   VARCHAR(9) NOT NULL,        -- denormalized for the people->orgs join
  tax_year              SMALLINT,
  seq                   SMALLINT NOT NULL,          -- position on the form
  name_raw              TEXT NOT NULL,
  name_norm             TEXT NOT NULL,              -- UPPER, punctuation/honorifics/suffixes stripped
  surname               VARCHAR(64),                -- last token of name_norm (prefix matches)
  is_business           BOOLEAN NOT NULL DEFAULT FALSE,  -- institutional trustee / entity name
  title                 TEXT,
  avg_hours             NUMERIC(7,2),
  avg_hours_related     NUMERIC(7,2),
  is_individual_trustee BOOLEAN NOT NULL DEFAULT FALSE,
  is_institutional_trustee BOOLEAN NOT NULL DEFAULT FALSE,
  is_officer            BOOLEAN NOT NULL DEFAULT FALSE,
  is_key_employee       BOOLEAN NOT NULL DEFAULT FALSE,
  is_highest_comp       BOOLEAN NOT NULL DEFAULT FALSE,
  is_former             BOOLEAN NOT NULL DEFAULT FALSE,
  comp_org              BIGINT,                     -- reportable comp from org (990) / CompensationAmt (EZ, PF)
  comp_related          BIGINT,
  comp_other            BIGINT,                     -- other comp (990) / benefits + expense allowance (EZ, PF)
  address_line1         TEXT,                       -- 990-PF only
  city                  VARCHAR(128),
  state                 VARCHAR(4),
  zip                   VARCHAR(16)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_persons_object_idx ON irs990_persons (object_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_persons_ein_idx ON irs990_persons (ein, tax_year);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_persons_surname_idx ON irs990_persons (surname);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_persons_name_trgm_idx ON irs990_persons USING GIN (name_norm gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_persons_zip_idx ON irs990_persons (zip) WHERE zip IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW irs990_latest_filings AS
SELECT DISTINCT ON (ein) *
FROM irs990_filings
ORDER BY ein, tax_period_end DESC NULLS LAST, return_ts DESC NULLS LAST;
