-- v0.5.0 schema changes:
--   1. Rename endowments.contributions to net_change_in_endowment
--      IPEDS variable f2h03 is "Total net additions to endowment for the year"
--      = EOY minus BOY net change, not gift inflows. The old column name was
--      misleading; this rename matches the actual semantics. Wrapped in an
--      IF EXISTS check so re-runs are idempotent.
--   2. Create ppp_loans table for SBA PPP FOIA dataset (>=$150K loans).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'endowments' AND column_name = 'contributions'
  ) THEN
    ALTER TABLE endowments RENAME COLUMN contributions TO net_change_in_endowment;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppp_loans (
  loan_number              VARCHAR(20) PRIMARY KEY,
  date_approved            DATE,
  borrower_name            TEXT NOT NULL,
  borrower_address         TEXT,
  borrower_city            VARCHAR(128),
  borrower_state           VARCHAR(4),
  borrower_zip             VARCHAR(16),
  loan_status              VARCHAR(64),
  loan_status_date         DATE,
  initial_approval_amount  BIGINT,
  current_approval_amount  BIGINT,
  undisbursed_amount       BIGINT,
  business_type            VARCHAR(128),
  nonprofit_flag           BOOLEAN,
  naics_code               VARCHAR(8),
  jobs_reported            INTEGER,
  originating_lender       TEXT,
  servicing_lender_name    TEXT,
  forgiveness_amount       BIGINT,
  forgiveness_date         DATE,
  rural_urban_indicator    VARCHAR(2),
  hubzone_indicator        VARCHAR(2),
  lmi_indicator            VARCHAR(2),
  last_updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppp_loans_name_idx       ON ppp_loans (borrower_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppp_loans_state_idx      ON ppp_loans (borrower_state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppp_loans_amount_idx     ON ppp_loans (current_approval_amount);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppp_loans_naics_idx      ON ppp_loans (naics_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppp_loans_business_idx   ON ppp_loans (business_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppp_loans_nonprofit_idx  ON ppp_loans (nonprofit_flag);
--> statement-breakpoint
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS ppp_loans_name_trgm_idx
    ON ppp_loans USING gin (borrower_name gin_trgm_ops);
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
