-- v0.29.0 — Nonprofit outreach engine (daily Matt + Ryan programs).
--
-- np_leads: one row per ORG the engine has ever touched, carrying the person
-- chosen, the enrichment, and the outcome. The unique EIN index is the
-- org-level dedupe across BOTH programs — Matt and Ryan never hit the same
-- institution, and an org is never re-worked unless a human deletes/retargets
-- its row.
--
-- np_events: append-only audit trail, same philosophy as prospect_events —
-- "why did the engine skip the Cleveland Foundation" is a query, not a guess.

CREATE TABLE IF NOT EXISTS np_leads (
  id                BIGSERIAL PRIMARY KEY,
  program           VARCHAR(16) NOT NULL,            -- 'matt' | 'ryan'
  ein               VARCHAR(9)  NOT NULL,
  org_name          TEXT        NOT NULL,
  org_city          VARCHAR(128),
  org_state         VARCHAR(4),
  org_zip           VARCHAR(16),
  ntee_code         VARCHAR(8),
  org_assets        BIGINT,                          -- BMF asset_amt
  pool_value        BIGINT,                          -- best investable-pool estimate used for the band
  pool_source       VARCHAR(24),                     -- bmf_assets | 990_endowment | 990_investments
  invest_mgmt_fees  BIGINT,                          -- 990 Part IX 11f, when a return is loaded
  has_990           BOOLEAN NOT NULL DEFAULT FALSE,
  person_name       TEXT,
  first_name        TEXT,
  last_name         TEXT,
  person_title      TEXT,
  person_role       VARCHAR(24),                     -- board | officer | staff
  apollo_id         VARCHAR(48),
  linkedin_url      TEXT,
  headline          TEXT,
  email             TEXT,
  email_status      VARCHAR(24),                     -- apollo: verified | guessed
  affinity          TEXT,                            -- the matched shared-affinity hook, if any
  status            VARCHAR(48) NOT NULL DEFAULT 'selected',  -- selected|researching|drafted|skipped:<reason>
  crm_contact_id    VARCHAR(48),                     -- VistaCRM crm_id once the Lead exists
  draft_subject     TEXT,
  graph_message_id  TEXT,
  research          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS np_leads_ein_uidx ON np_leads (ein);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS np_leads_program_status_idx ON np_leads (program, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS np_leads_created_idx ON np_leads (created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS np_events (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     BIGINT REFERENCES np_leads(id) ON DELETE CASCADE,
  kind        VARCHAR(32) NOT NULL,                  -- select|research|gate|draft|deliver|crm|note|status_change
  detail      TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor       VARCHAR(64) NOT NULL DEFAULT 'nonprofit-engine',
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS np_events_lead_idx ON np_events (lead_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS np_events_kind_idx ON np_events (kind, created_at DESC);
