-- DOL Form 5500 Schedule C, Part I Item 2 — service providers receiving
-- $5,000+ in direct or indirect compensation from a plan (recordkeepers,
-- investment advisers/consultants, brokers, TPAs, auditors, actuaries...).
-- Source: https://askebsa.dol.gov/FOIA%20Files/<year>/Latest/
--   F_SCH_C_PART1_ITEM2_<year>_Latest.zip        (one row per provider per filing)
--   F_SCH_C_PART1_ITEM2_CODES_<year>_Latest.zip  (service/comp codes, 1:N per provider row)
-- Codes are folded into service_codes (comma-separated) at ingest time.
-- Joins to plans on ack_id for sponsor / state / assets.
-- Ingested by api/admin/refresh-dol-sch-c.ts (lib/filings-people/schedule-c.ts).

CREATE TABLE IF NOT EXISTS dol_sch_c_providers (
  ack_id                 VARCHAR(40) NOT NULL,
  row_order              INTEGER     NOT NULL,
  filing_year            INTEGER     NOT NULL,          -- DOL FOIA file year
  provider_name          TEXT,
  provider_name_norm     TEXT,                          -- upper, punctuation/suffix stripped
  provider_ein           VARCHAR(12),
  provider_city          VARCHAR(64),
  provider_state         VARCHAR(4),
  provider_zip           VARCHAR(16),
  relation               TEXT,                          -- free text: RECORDKEEPER, INVESTMENT ADVISOR, NONE...
  service_codes          TEXT,                          -- e.g. '27,50' (see Schedule C instructions)
  direct_comp            BIGINT,                        -- USD, paid directly by the plan
  indirect_comp_ind      BOOLEAN,                       -- received indirect compensation
  elig_indirect_comp_ind BOOLEAN,                       -- indirect comp is 'eligible' (disclosed per 408(b)(2))
  indirect_comp          BIGINT,                        -- USD total indirect comp (when reported)
  formula_ind            BOOLEAN,                       -- amount is a formula estimate
  last_updated_at        TIMESTAMP   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ack_id, row_order)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_c_ack_idx        ON dol_sch_c_providers (ack_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_c_ein_idx        ON dol_sch_c_providers (provider_ein);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_c_name_norm_idx  ON dol_sch_c_providers (provider_name_norm);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_c_year_idx       ON dol_sch_c_providers (filing_year);
--> statement-breakpoint
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS dol_sch_c_name_trgm_idx
    ON dol_sch_c_providers USING gin (provider_name_norm gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
