-- v0.39.0 -- Lawyer COI outreach engine (nightly Matt program; lib/lawyer/engine.ts).
--
-- lawyer_leads: one row per ATTORNEY the engine has ever touched. Dedupe key is
-- the ARDC id when the registry resolved the person, else the normalized name
-- plus firm (person_key). Nobody is written twice; a row is never re-worked
-- unless a human deletes or retargets it. Mirrors np_leads (0008).
--
-- lawyer_events: append-only audit trail, same philosophy as np_events.

CREATE TABLE IF NOT EXISTS lawyer_leads (
  id                BIGSERIAL PRIMARY KEY,
  program           VARCHAR(16) NOT NULL,            -- 'matt'
  category          VARCHAR(16) NOT NULL,            -- erisa | divorce | te | transaction | tax
  person_key        VARCHAR(200) NOT NULL,           -- ardc:<id> | name:<norm>|firm:<norm>
  ardc_id           VARCHAR(64),
  person_name       TEXT        NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  firm              TEXT,
  firm_norm         TEXT,
  city              VARCHAR(128),
  state             VARCHAR(4),
  zip               VARCHAR(16),
  geo_band          SMALLINT,                        -- 1 Hinsdale .. 4 metro
  source_tool       VARCHAR(48),                     -- directory tool that surfaced the row
  source_tools      TEXT[]      NOT NULL DEFAULT '{}',
  practice_areas    TEXT[]      NOT NULL DEFAULT '{}',
  ardc_status       VARCHAR(48),
  ardc_admitted     VARCHAR(16),
  ardc_discipline   BOOLEAN,
  person_title      TEXT,
  apollo_id         VARCHAR(48),
  linkedin_url      TEXT,
  headline          TEXT,
  email             TEXT,
  email_status      VARCHAR(24),                     -- apollo: verified | guessed | directory
  affinity          TEXT,
  expert_witness    BOOLEAN,                         -- divorce lane: HNW / asset-division work found
  status            VARCHAR(48) NOT NULL DEFAULT 'selected',  -- selected|researching|drafted|skipped:<reason>
  crm_contact_id    VARCHAR(48),
  draft_subject     TEXT,
  graph_message_id  TEXT,
  research          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS lawyer_leads_person_key_uidx ON lawyer_leads (person_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lawyer_leads_program_status_idx ON lawyer_leads (program, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lawyer_leads_category_idx ON lawyer_leads (category, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lawyer_leads_created_idx ON lawyer_leads (created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lawyer_events (
  id          BIGSERIAL PRIMARY KEY,
  lead_id     BIGINT REFERENCES lawyer_leads(id) ON DELETE CASCADE,
  kind        VARCHAR(32) NOT NULL,                  -- select|verify|research|gate|draft|deliver|crm|paused|config_unreachable
  detail      TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor       VARCHAR(64) NOT NULL DEFAULT 'lawyer-engine',
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lawyer_events_lead_idx ON lawyer_events (lead_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS lawyer_events_kind_idx ON lawyer_events (kind, created_at DESC);
