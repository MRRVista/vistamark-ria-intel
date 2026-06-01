-- Phase 3 — Higher education endowments (IPEDS Finance Survey Part H + NACUBO benchmarks)
-- Sources:
--   IPEDS Finance Survey Part H (Endowment assets BOY/EOY) — nces.ed.gov/ipeds/datacenter/
--   IPEDS Directory (HD file) — institution metadata
--   NACUBO public NCSE tables — cohort-level benchmark data

CREATE TABLE IF NOT EXISTS ipeds_institutions (
  unitid          INTEGER PRIMARY KEY,
  instnm          TEXT NOT NULL,
  city            VARCHAR(128),
  state           VARCHAR(4),
  zip             VARCHAR(16),
  sector          INTEGER,
  control         INTEGER,
  iclevel         INTEGER,
  obereg          INTEGER,
  webaddr         TEXT,
  closed_date     VARCHAR(16),
  last_updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipeds_inst_name_idx     ON ipeds_institutions (instnm);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipeds_inst_state_idx    ON ipeds_institutions (state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipeds_inst_sector_idx   ON ipeds_institutions (sector);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipeds_inst_control_idx  ON ipeds_institutions (control);
--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS ipeds_inst_name_trgm_idx
    ON ipeds_institutions USING gin (instnm gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS endowments (
  unitid                 INTEGER NOT NULL,
  fyear                  INTEGER NOT NULL,
  file_type              VARCHAR(4) NOT NULL,
  market_value_boy       BIGINT,
  market_value_eoy       BIGINT,
  contributions          BIGINT,
  net_investment_return  BIGINT,
  withdrawals            BIGINT,
  other_adjustments      BIGINT,
  last_updated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (unitid, fyear)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS endowments_fyear_idx        ON endowments (fyear);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS endowments_eoy_idx          ON endowments (market_value_eoy);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS endowments_unitid_idx       ON endowments (unitid);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nacubo_benchmarks (
  fyear            INTEGER NOT NULL,
  cohort           VARCHAR(64) NOT NULL,
  cohort_count     INTEGER,
  total_assets     BIGINT,
  median_value     BIGINT,
  return_1y        NUMERIC(6,3),
  return_3y        NUMERIC(6,3),
  return_5y        NUMERIC(6,3),
  return_10y       NUMERIC(6,3),
  spending_rate    NUMERIC(6,3),
  spending_amount  BIGINT,
  asset_alloc_json TEXT,
  source           VARCHAR(32),
  last_updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fyear, cohort)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nacubo_benchmarks_fyear_idx  ON nacubo_benchmarks (fyear);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nacubo_benchmarks_cohort_idx ON nacubo_benchmarks (cohort);
