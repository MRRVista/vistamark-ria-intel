-- Phase 1 — IRS Exempt Organizations Business Master File (EO BMF).
-- Matches the `nonprofits` table in lib/db/schema.ts.
-- ProPublica Nonprofit Explorer is a passthrough API (no caching table needed in v1).

CREATE TABLE IF NOT EXISTS nonprofits (
  ein                 VARCHAR(9) PRIMARY KEY,
  name                TEXT NOT NULL,
  in_care_of          TEXT,
  street              TEXT,
  city                VARCHAR(128),
  state               VARCHAR(4),
  zip                 VARCHAR(16),
  group_code          VARCHAR(8),
  subsection          INTEGER,
  affiliation         INTEGER,
  classification      VARCHAR(32),
  ruling_date         VARCHAR(8),
  deductibility       INTEGER,
  foundation          INTEGER,
  activity_codes      VARCHAR(32),
  organization_code   INTEGER,
  status_code         INTEGER,
  tax_period          VARCHAR(8),
  asset_code          INTEGER,
  income_code         INTEGER,
  filing_req_code     VARCHAR(4),
  pf_filing_req_code  VARCHAR(4),
  acct_period         VARCHAR(4),
  asset_amt           BIGINT,
  income_amt          BIGINT,
  revenue_amt         BIGINT,
  ntee_code           VARCHAR(8),
  sort_name           TEXT,
  region              VARCHAR(8),
  last_updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nonprofits_name_idx        ON nonprofits (name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nonprofits_state_idx       ON nonprofits (state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nonprofits_subsection_idx  ON nonprofits (subsection);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nonprofits_ntee_idx        ON nonprofits (ntee_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nonprofits_asset_cd_idx    ON nonprofits (asset_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nonprofits_state_subsec_idx ON nonprofits (state, subsection);
--> statement-breakpoint
-- Trigram index speeds up `name ILIKE '%foo%'` style fuzzy search.
-- pg_trgm is available on Neon; we don't fail if extension creation is blocked.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS nonprofits_name_trgm_idx
    ON nonprofits USING gin (name gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
