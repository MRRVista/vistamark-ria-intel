-- Phase 2 — DOL Form 5500 ERISA retirement plan filings.
-- Source: https://askebsa.dol.gov/FOIA%20Files/ (annual bulk CSVs).
--
-- We ingest the main Form 5500 only in v1; Schedule C (service-provider
-- relationships) ships as Phase 2.1 once the storage footprint is verified.

CREATE TABLE IF NOT EXISTS plans (
  ack_id                       VARCHAR(40) PRIMARY KEY,
  form_plan_year_begin_date    DATE,
  form_tax_prd                 VARCHAR(8),
  type_plan_entity_cd          INTEGER,
  type_dfe_plan_entity_cd      INTEGER,
  initial_filing_ind           BOOLEAN,
  amended_ind                  BOOLEAN,
  final_filing_ind             BOOLEAN,
  short_plan_yr_ind            BOOLEAN,
  collective_bargain_ind       BOOLEAN,
  plan_year                    INTEGER,
  plan_name                    TEXT,
  spons_dfe_pn                 VARCHAR(8),
  spons_dfe_ein                VARCHAR(12),
  spons_dfe_name               TEXT,
  spons_dfe_dba_name           TEXT,
  spons_dfe_mail_addr1         TEXT,
  spons_dfe_mail_city          VARCHAR(64),
  spons_dfe_mail_state         VARCHAR(4),
  spons_dfe_mail_zip           VARCHAR(16),
  spons_dfe_phone              VARCHAR(20),
  admin_name                   TEXT,
  admin_ein                    VARCHAR(12),
  admin_phone                  VARCHAR(20),
  admin_addr1                  TEXT,
  admin_city                   VARCHAR(64),
  admin_state                  VARCHAR(4),
  admin_zip                    VARCHAR(16),
  tot_active_partcp_cnt        INTEGER,
  tot_partcp_boy_cnt           INTEGER,
  rtrd_sep_partcp_rcvg_cnt     INTEGER,
  rtrd_sep_partcp_fut_cnt      INTEGER,
  pension_plan_feature_codes   TEXT,
  welfare_plan_feature_codes   TEXT,
  sch_a_attached_ind           BOOLEAN,
  sch_c_attached_ind           BOOLEAN,
  sch_d_attached_ind           BOOLEAN,
  sch_g_attached_ind           BOOLEAN,
  sch_h_attached_ind           BOOLEAN,
  sch_i_attached_ind           BOOLEAN,
  sch_r_attached_ind           BOOLEAN,
  sch_mb_attached_ind          BOOLEAN,
  sch_sb_attached_ind          BOOLEAN,
  tot_assets_boy_amt           BIGINT,
  tot_assets_eoy_amt           BIGINT,
  net_assets_boy_amt           BIGINT,
  net_assets_eoy_amt           BIGINT,
  date_received                DATE,
  last_updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_sponsor_ein_idx       ON plans (spons_dfe_ein);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_sponsor_name_idx      ON plans (spons_dfe_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_admin_ein_idx         ON plans (admin_ein);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_state_idx             ON plans (spons_dfe_mail_state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_plan_year_idx         ON plans (plan_year);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_assets_eoy_idx        ON plans (tot_assets_eoy_amt);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plans_state_year_idx        ON plans (spons_dfe_mail_state, plan_year);
--> statement-breakpoint
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS plans_sponsor_name_trgm_idx
    ON plans USING gin (spons_dfe_name gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
