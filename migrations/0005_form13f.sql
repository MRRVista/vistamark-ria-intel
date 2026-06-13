-- v0.6.0 schema: SEC Form 13F institutional holdings.
-- Source: SEC Form 13F Data Sets (flattened quarterly TSV bulk files).
--   https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets
--
-- Two tables:
--   f13f_filings  — one row per accession (filing-level manager identity + totals),
--                   built by joining the SUBMISSION + COVERPAGE + SUMMARYPAGE TSVs.
--   f13f_holdings — one row per position from the INFOTABLE TSV.
--
-- IMPORTANT on VALUE units: per the SEC readme, starting 2023-01-03 the INFOTABLE
-- VALUE column is in whole dollars; before that it was in THOUSANDS. The ingest
-- computes value_usd (normalized to whole dollars) using period_of_report so
-- downstream queries don't have to special-case the cutover.

CREATE TABLE IF NOT EXISTS f13f_filings (
  accession_number          VARCHAR(25) PRIMARY KEY,
  cik                       VARCHAR(10),
  filing_date               DATE,
  submission_type           VARCHAR(10),
  period_of_report          DATE,
  filing_manager_name       TEXT,
  filing_manager_city       VARCHAR(64),
  filing_manager_state      VARCHAR(4),
  report_type               VARCHAR(40),
  crd_number                VARCHAR(9),
  sec_file_number           VARCHAR(20),
  table_entry_total         INTEGER,
  table_value_total         BIGINT,
  table_value_total_usd     BIGINT,
  other_managers_count      INTEGER,
  is_amendment              BOOLEAN,
  last_updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_filings_manager_idx   ON f13f_filings (filing_manager_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_filings_cik_idx        ON f13f_filings (cik);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_filings_period_idx     ON f13f_filings (period_of_report);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_filings_value_idx      ON f13f_filings (table_value_total_usd);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_filings_crd_idx        ON f13f_filings (crd_number);
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS f13f_filings_manager_trgm_idx
    ON f13f_filings USING gin (filing_manager_name gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN
  -- pg_trgm not installed; plain btree index above still serves prefix lookups.
  NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS f13f_holdings (
  accession_number          VARCHAR(25) NOT NULL,
  infotable_sk              BIGINT NOT NULL,
  name_of_issuer            TEXT,
  title_of_class            VARCHAR(150),
  cusip                     CHAR(9),
  figi                      VARCHAR(12),
  value_raw                 BIGINT,
  value_usd                 BIGINT,
  ssh_prnamt                BIGINT,
  ssh_prnamt_type           VARCHAR(10),
  put_call                  VARCHAR(10),
  investment_discretion     VARCHAR(10),
  voting_auth_sole          BIGINT,
  voting_auth_shared        BIGINT,
  voting_auth_none          BIGINT,
  period_of_report          DATE,
  last_updated_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (accession_number, infotable_sk)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_holdings_accession_idx  ON f13f_holdings (accession_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_holdings_cusip_idx       ON f13f_holdings (cusip);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_holdings_issuer_idx      ON f13f_holdings (name_of_issuer);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_holdings_value_idx       ON f13f_holdings (value_usd);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS f13f_holdings_period_idx      ON f13f_holdings (period_of_report);
