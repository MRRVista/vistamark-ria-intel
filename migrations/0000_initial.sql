-- Vistamark RIA Intel — initial schema
-- Matches lib/db/schema.ts

DO $$ BEGIN
  CREATE TYPE registration_status AS ENUM (
    'sec_registered',
    'state_registered',
    'exempt_reporting',
    'terminated',
    'pending',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS firms (
  crd_number              INTEGER PRIMARY KEY,
  sec_number              VARCHAR(32),
  legal_name              TEXT NOT NULL,
  primary_business_name   TEXT,
  main_office_street      TEXT,
  main_office_city        VARCHAR(128),
  main_office_state       VARCHAR(4),
  main_office_zip         VARCHAR(16),
  main_office_country     VARCHAR(64),
  website                 TEXT,
  main_phone              VARCHAR(32),
  email                   TEXT,

  total_aum                  BIGINT,
  discretionary_aum          BIGINT,
  non_discretionary_aum      BIGINT,
  total_accounts             INTEGER,
  discretionary_accounts     INTEGER,
  non_discretionary_accounts INTEGER,
  total_employees            INTEGER,
  registered_iar_count       INTEGER,

  registration_status     registration_status NOT NULL DEFAULT 'unknown',
  sec_registration_date   DATE,
  is_large_adviser        BOOLEAN DEFAULT FALSE,

  pct_individual_non_hnw   NUMERIC(5,2),
  pct_individual_hnw       NUMERIC(5,2),
  pct_pension_plans        NUMERIC(5,2),
  pct_charitable_orgs      NUMERIC(5,2),
  pct_corporations         NUMERIC(5,2),
  pct_other_institutional  NUMERIC(5,2),
  pct_pooled_investment    NUMERIC(5,2),
  pct_government_entities  NUMERIC(5,2),
  pct_other                NUMERIC(5,2),

  comp_aum_pct       BOOLEAN DEFAULT FALSE,
  comp_hourly        BOOLEAN DEFAULT FALSE,
  comp_fixed_fee     BOOLEAN DEFAULT FALSE,
  comp_commission    BOOLEAN DEFAULT FALSE,
  comp_performance   BOOLEAN DEFAULT FALSE,
  comp_subscription  BOOLEAN DEFAULT FALSE,
  comp_other         BOOLEAN DEFAULT FALSE,

  svc_financial_planning        BOOLEAN DEFAULT FALSE,
  svc_portfolio_mgmt_indiv      BOOLEAN DEFAULT FALSE,
  svc_portfolio_mgmt_inst       BOOLEAN DEFAULT FALSE,
  svc_portfolio_mgmt_invco      BOOLEAN DEFAULT FALSE,
  svc_portfolio_mgmt_pooled     BOOLEAN DEFAULT FALSE,
  svc_pension_consulting        BOOLEAN DEFAULT FALSE,
  svc_advisor_selection         BOOLEAN DEFAULT FALSE,
  svc_publication_subscription  BOOLEAN DEFAULT FALSE,
  svc_security_ratings          BOOLEAN DEFAULT FALSE,
  svc_market_timing             BOOLEAN DEFAULT FALSE,
  svc_educational_seminars      BOOLEAN DEFAULT FALSE,

  has_custody        BOOLEAN DEFAULT FALSE,
  custody_aum        BIGINT,
  custody_accounts   INTEGER,

  has_disclosures    BOOLEAN DEFAULT FALSE,
  disclosure_count   INTEGER DEFAULT 0,

  last_filing_date   DATE,
  last_annual_update DATE,
  first_seen_at      TIMESTAMP NOT NULL DEFAULT now(),
  last_updated_at    TIMESTAMP NOT NULL DEFAULT now(),
  raw_json           TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS firms_sec_number_idx ON firms (sec_number) WHERE sec_number IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firms_name_idx ON firms (legal_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firms_state_idx ON firms (main_office_state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firms_aum_idx ON firms (total_aum);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firms_city_state_idx ON firms (main_office_city, main_office_state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firms_status_idx ON firms (registration_status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS firm_history (
  id                    SERIAL PRIMARY KEY,
  crd_number            INTEGER NOT NULL REFERENCES firms(crd_number) ON DELETE CASCADE,
  filing_date           DATE NOT NULL,
  total_aum             BIGINT,
  discretionary_aum     BIGINT,
  total_accounts        INTEGER,
  total_employees       INTEGER,
  registered_iar_count  INTEGER,
  raw_json              TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS firm_history_crd_filing_idx ON firm_history (crd_number, filing_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firm_history_crd_idx ON firm_history (crd_number);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS advisors (
  crd_number        INTEGER PRIMARY KEY,
  first_name        VARCHAR(128),
  middle_name       VARCHAR(128),
  last_name         VARCHAR(128),
  suffix            VARCHAR(32),
  full_name         TEXT NOT NULL,
  current_firm_crd  INTEGER REFERENCES firms(crd_number),
  title             TEXT,
  has_disclosures   BOOLEAN DEFAULT FALSE,
  disclosure_count  INTEGER DEFAULT 0,
  first_seen_at     TIMESTAMP NOT NULL DEFAULT now(),
  last_updated_at   TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS advisors_name_idx ON advisors (last_name, first_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS advisors_current_firm_idx ON advisors (current_firm_crd);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS advisors_full_name_idx ON advisors (full_name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS advisor_history (
  id            SERIAL PRIMARY KEY,
  advisor_crd   INTEGER NOT NULL REFERENCES advisors(crd_number) ON DELETE CASCADE,
  firm_crd      INTEGER NOT NULL REFERENCES firms(crd_number),
  start_date    DATE,
  end_date      DATE,
  title         TEXT,
  discovered_at TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS advisor_history_advisor_idx ON advisor_history (advisor_crd);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS advisor_history_firm_idx ON advisor_history (firm_crd);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS advisor_history_active_idx ON advisor_history (firm_crd, end_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS firm_custodians (
  id                    SERIAL PRIMARY KEY,
  firm_crd              INTEGER NOT NULL REFERENCES firms(crd_number) ON DELETE CASCADE,
  custodian_name        TEXT NOT NULL,
  custodian_crd         INTEGER,
  custodian_sec_number  VARCHAR(32),
  custody_type          VARCHAR(64),
  aum_held              BIGINT,
  accounts_held         INTEGER
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firm_custodians_firm_idx ON firm_custodians (firm_crd);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS firm_custodians_name_idx ON firm_custodians (custodian_name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS private_funds (
  id                  SERIAL PRIMARY KEY,
  firm_crd            INTEGER NOT NULL REFERENCES firms(crd_number) ON DELETE CASCADE,
  fund_name           TEXT NOT NULL,
  fund_id             VARCHAR(64),
  fund_type           VARCHAR(64),
  gross_asset_value   BIGINT,
  minimum_investment  BIGINT,
  beneficial_owners   INTEGER,
  master_feeder_status VARCHAR(32)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS private_funds_firm_idx ON private_funds (firm_crd);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS private_funds_fund_id_idx ON private_funds (fund_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ingest_runs (
  id                SERIAL PRIMARY KEY,
  started_at        TIMESTAMP NOT NULL DEFAULT now(),
  finished_at       TIMESTAMP,
  source            VARCHAR(64) NOT NULL,
  feed_date         DATE,
  firms_processed   INTEGER DEFAULT 0,
  firms_inserted    INTEGER DEFAULT 0,
  firms_updated     INTEGER DEFAULT 0,
  status            VARCHAR(32) NOT NULL DEFAULT 'running',
  error_message     TEXT
);
