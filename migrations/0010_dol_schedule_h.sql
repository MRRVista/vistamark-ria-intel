-- DOL Form 5500 Schedule H (large plans, 100+ participants) and Schedule I
-- (small plans) — plan financial statements and asset mix.
--
-- WHY: starting with the 2024 FOIA files DOL dropped TOT_ASSETS_BOY/EOY_AMT and
-- NET_ASSETS_*_AMT from F_5500 (they are null in `plans`); plan totals now live
-- only on Schedule H / I. This table restores them; lib/dol-5500/queries.ts and
-- lib/filings-people/schedule-c.ts COALESCE plans.tot_assets_eoy_amt with
-- dol_sch_h_i.tot_assets_eoy_amt via LEFT JOIN on ack_id.
--
-- Source: https://askebsa.dol.gov/FOIA%20Files/<year>/Latest/
--   F_SCH_H_<year>_Latest.zip  (F_SCH_H_<year>_latest.csv, 166 cols, ~88k rows for 2024)
--   F_SCH_I_<year>_Latest.zip  (F_SCH_I_<year>_latest.csv,  77 cols, ~60k rows for 2024)
-- One row per filing (ack_id) in each file; a filing attaches either H or I.
-- Column names below are the FOIA field names lower-cased. Schedule I fields
-- carry a SMALL_ prefix in the file (SMALL_TOT_ASSETS_EOY_AMT ...) and are
-- stored in the same unprefixed columns; H-only asset-class columns are NULL
-- for Schedule I rows except the handful Sch I Part II line 3 reports
-- (joint_venture, real_estate, emplr_sec, emplr_prop, partcp_loans, other_loans).
-- Ingested by api/admin/refresh-dol-sch-h.ts (lib/dol-5500/schedule-h.ts).

CREATE TABLE IF NOT EXISTS dol_sch_h_i (
  ack_id                        VARCHAR(40) PRIMARY KEY,
  filing_year                   INTEGER     NOT NULL,          -- DOL FOIA file year
  schedule                      CHAR(1)     NOT NULL,          -- 'H' | 'I'
  plan_year_begin_date          DATE,                          -- SCH_H_PLAN_YEAR_BEGIN_DATE / SCH_I_PLAN_YEAR_BEGIN_DATE
  tax_prd                       DATE,                          -- SCH_H_TAX_PRD / SCH_I_TAX_PRD (plan year end)
  pn                            VARCHAR(3),                    -- SCH_H_PN / SCH_I_PLAN_NUM
  ein                           VARCHAR(9),                    -- SCH_H_EIN / SCH_I_EIN
  -- Balance sheet (Part I)
  tot_assets_boy_amt            BIGINT,
  tot_liabilities_boy_amt       BIGINT,
  net_assets_boy_amt            BIGINT,
  tot_assets_eoy_amt            BIGINT,
  tot_liabilities_eoy_amt       BIGINT,
  net_assets_eoy_amt            BIGINT,
  -- Income / expenses (Part II), USD for the plan year
  emplr_contrib_income_amt      BIGINT,
  participant_contrib_amt       BIGINT,
  oth_contrib_rcvd_amt          BIGINT,
  tot_contrib_amt               BIGINT,                        -- H: TOT_CONTRIB_AMT; I: emplr+participant+other+non-cash (derived)
  tot_income_amt                BIGINT,
  net_invst_gain_amt            BIGINT,                        -- derived: tot_income - tot_contrib (earnings on investments, incl. unrealized)
  tot_distrib_bnft_amt          BIGINT,                        -- benefits paid
  tot_admin_expenses_amt        BIGINT,                        -- H: TOT_ADMIN_EXPENSES_AMT; I: SMALL_ADMIN_SRVC_PROVIDERS_AMT
  invst_mgmt_fees_amt           BIGINT,                        -- H only (line 2i(3))
  tot_expenses_amt              BIGINT,
  net_income_amt                BIGINT,
  -- Asset classes, end of year (Sch H Part I line 1; Sch I Part II line 3 where available)
  non_int_bear_cash_eoy_amt     BIGINT,
  int_bear_cash_eoy_amt         BIGINT,
  govt_sec_eoy_amt              BIGINT,
  corp_debt_preferred_eoy_amt   BIGINT,
  corp_debt_other_eoy_amt       BIGINT,
  pref_stock_eoy_amt            BIGINT,
  common_stock_eoy_amt          BIGINT,
  joint_venture_eoy_amt         BIGINT,                        -- partnership / joint venture interests
  real_estate_eoy_amt           BIGINT,
  other_loans_eoy_amt           BIGINT,
  partcp_loans_eoy_amt          BIGINT,
  int_common_tr_eoy_amt         BIGINT,                        -- common/collective trusts
  int_pool_sep_acct_eoy_amt     BIGINT,                        -- pooled separate accounts
  int_master_tr_eoy_amt         BIGINT,                        -- master trust investment accounts
  int_103_12_invst_eoy_amt      BIGINT,                        -- 103-12 investment entities
  int_reg_invst_co_eoy_amt      BIGINT,                        -- registered investment companies (mutual funds)
  ins_co_gen_acct_eoy_amt       BIGINT,                        -- insurance company general account
  oth_invst_eoy_amt             BIGINT,
  emplr_sec_eoy_amt             BIGINT,                        -- employer securities
  emplr_prop_eoy_amt            BIGINT,                        -- employer real property
  bldgs_used_eoy_amt            BIGINT,                        -- buildings used in plan operation
  -- Service providers named on the schedule
  accountant_firm_name          TEXT,                          -- H only (IQPA)
  accountant_firm_ein           VARCHAR(12),
  acctnt_opinion_type_cd        VARCHAR(2),                    -- H only: 1 unqualified, 2 qualified, 3 disclaimer, 4 adverse
  fdcry_trust_name              TEXT,
  fdcry_trustee_cust_name       TEXT,                          -- trustee / custodian
  last_updated_at               TIMESTAMP   NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_h_i_year_idx        ON dol_sch_h_i (filing_year);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_h_i_assets_eoy_idx  ON dol_sch_h_i (tot_assets_eoy_amt);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_h_i_ein_idx         ON dol_sch_h_i (ein);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS dol_sch_h_i_emplr_sec_idx   ON dol_sch_h_i (emplr_sec_eoy_amt) WHERE emplr_sec_eoy_amt > 0;
