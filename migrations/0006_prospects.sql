-- v0.21.0 schema: Prospects — zip-code household/individual prospecting database.
--
-- Unlike every other table in this repo, these rows are NOT public bulk data.
-- They are first-party prospect records funneled in from purchased lists,
-- county assessor / voter exports, web forms, Randall (MCP), and the CRM.
-- Treat as PII: no unauthenticated endpoint may ever read these tables.
--
-- Four tables + one event log:
--   prospect_zips        — the target zip list (seeded with 60521 Hinsdale).
--   prospect_imports     — one row per upload/batch (audit + column-map memory).
--   prospect_households  — one row per normalized street address (wealth signals
--                          like home value live here: they belong to the house).
--   prospects            — one row per person; dedupes on email OR on
--                          name+address; carries consent flags + lead status.
--   prospect_events      — touchpoints and status changes per person.

CREATE TABLE IF NOT EXISTS prospect_zips (
  zip5            CHAR(5) PRIMARY KEY,
  city            TEXT,
  state           VARCHAR(2),
  county          TEXT,
  label           TEXT,
  priority        SMALLINT NOT NULL DEFAULT 1,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
INSERT INTO prospect_zips (zip5, city, state, county, label, priority, notes)
VALUES ('60521', 'Hinsdale', 'IL', 'DuPage', 'Hinsdale — Vistamark HQ zip', 1,
        'First target zip. Vistamark Investments, 333 Chestnut St, Hinsdale IL 60521.')
ON CONFLICT (zip5) DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS prospect_imports (
  id              SERIAL PRIMARY KEY,
  started_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMP,
  via             VARCHAR(16) NOT NULL,            -- csv | xlsx | json | mcp | crm | form
  source          TEXT NOT NULL,                   -- e.g. 'county-assessor', 'list-broker:Acme', 'website-form'
  source_detail   TEXT,
  filename        TEXT,
  submitted_by    TEXT,                            -- session email or 'token'
  restrict_zips   BOOLEAN NOT NULL DEFAULT FALSE,
  dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
  rows_received   INTEGER NOT NULL DEFAULT 0,
  rows_inserted   INTEGER NOT NULL DEFAULT 0,
  rows_updated    INTEGER NOT NULL DEFAULT 0,
  rows_skipped    INTEGER NOT NULL DEFAULT 0,
  rows_rejected   INTEGER NOT NULL DEFAULT 0,
  column_map      JSONB,
  zip_counts      JSONB,
  errors          JSONB,
  status          VARCHAR(16) NOT NULL DEFAULT 'running'
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS prospect_households (
  id                    SERIAL PRIMARY KEY,
  address_key           TEXT NOT NULL UNIQUE,      -- normalized 'LINE1|ZIP5'
  address_line1         TEXT NOT NULL,
  address_line2         TEXT,
  city                  TEXT,
  state                 VARCHAR(2),
  zip5                  CHAR(5) NOT NULL,
  zip4                  CHAR(4),
  county                TEXT,
  latitude              NUMERIC(9, 6),
  longitude             NUMERIC(9, 6),
  household_name        TEXT,                      -- 'The Smith Household'
  home_value            BIGINT,                    -- whole dollars
  home_value_source     TEXT,                      -- 'assessor', 'zillow', 'list', ...
  home_value_as_of      DATE,
  year_built            INTEGER,
  sq_ft                 INTEGER,
  lot_acres             NUMERIC(8, 3),
  owner_occupied        BOOLEAN,
  purchase_date         DATE,
  purchase_price        BIGINT,
  est_household_income  BIGINT,
  est_net_worth_band    VARCHAR(32),               -- free text band, e.g. '$5M-$10M'
  household_size        SMALLINT,
  wealth_score          SMALLINT,                  -- 0-100, internal
  wealth_signals        JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags                  TEXT[],
  notes                 TEXT,
  vistacrm_household_id TEXT,
  wealthbox_household_id TEXT,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospect_households_zip_idx   ON prospect_households (zip5);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospect_households_value_idx ON prospect_households (home_value);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS prospects (
  id                      SERIAL PRIMARY KEY,
  household_id            INTEGER REFERENCES prospect_households(id) ON DELETE SET NULL,
  person_key              TEXT NOT NULL UNIQUE,    -- normalized 'ZIP5|LAST|FIRST|LINE1' (or 'EMAIL|<email>' when no address)
  first_name              TEXT,
  middle_name             TEXT,
  last_name               TEXT,
  suffix                  TEXT,
  full_name               TEXT NOT NULL,
  email                   TEXT,
  email_normalized        TEXT,
  email_status            VARCHAR(16) NOT NULL DEFAULT 'unknown',   -- unknown | unverified | valid | invalid | bounced
  email_opt_in            BOOLEAN,                                  -- NULL = never asked
  opt_in_at               TIMESTAMP,
  opt_in_source           TEXT,
  do_not_contact          BOOLEAN NOT NULL DEFAULT FALSE,
  do_not_email            BOOLEAN NOT NULL DEFAULT FALSE,
  do_not_call             BOOLEAN NOT NULL DEFAULT FALSE,
  do_not_mail             BOOLEAN NOT NULL DEFAULT FALSE,
  phone                   TEXT,
  phone_mobile            TEXT,
  address_line1           TEXT,
  address_line2           TEXT,
  city                    TEXT,
  state                   VARCHAR(2),
  zip5                    CHAR(5) NOT NULL,
  zip4                    CHAR(4),
  age_band                VARCHAR(16),             -- '55-64'
  birth_year              INTEGER,
  occupation              TEXT,
  employer                TEXT,
  title                   TEXT,
  industry                TEXT,
  linkedin_url            TEXT,
  est_net_worth_band      VARCHAR(32),
  est_investable_assets   BIGINT,
  est_income_band         VARCHAR(32),
  is_business_owner       BOOLEAN,
  is_executive            BOOLEAN,
  has_trust               BOOLEAN,
  wealth_signals          JSONB NOT NULL DEFAULT '{}'::jsonb,
  lead_score              SMALLINT,
  lead_status             VARCHAR(24) NOT NULL DEFAULT 'new',   -- new | researching | qualified | contacted | meeting | client | disqualified
  source                  TEXT NOT NULL,
  source_detail           TEXT,
  source_record_id        TEXT,
  acquired_at             DATE,
  import_id               INTEGER REFERENCES prospect_imports(id) ON DELETE SET NULL,
  vistacrm_contact_id     TEXT,
  wealthbox_contact_id    TEXT,
  crm_synced_at           TIMESTAMP,
  tags                    TEXT[],
  notes                   TEXT,
  raw                     JSONB,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_zip_idx        ON prospects (zip5);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_email_idx      ON prospects (email_normalized);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_name_idx       ON prospects (last_name, first_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_household_idx  ON prospects (household_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_status_idx     ON prospects (lead_status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_source_idx     ON prospects (source);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_updated_idx    ON prospects (updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospects_crm_idx        ON prospects (vistacrm_contact_id);
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS prospects_full_name_trgm_idx
    ON prospects USING gin (full_name gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN
  -- pg_trgm not installed; the btree (last_name, first_name) index still serves.
  NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS prospect_events (
  id            SERIAL PRIMARY KEY,
  prospect_id   INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  at            TIMESTAMP NOT NULL DEFAULT NOW(),
  kind          VARCHAR(32) NOT NULL,   -- note | email | call | mail | meeting | status_change | crm_push | import | consent
  detail        TEXT,
  meta          JSONB,
  actor         TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS prospect_events_prospect_idx ON prospect_events (prospect_id, at);
