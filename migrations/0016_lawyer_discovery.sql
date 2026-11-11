-- v0.41.2 -- Lawyer COI outreach: the directory walk is kept for a week.
--
-- One row per lane and geography band: the merged directory rows the engine
-- found (lib/lawyer/engine.ts discoverLane). Walking the directories takes
-- about two minutes, most of a run's time; the rosters change slowly. A run
-- reads this table and only walks a lane again when its row is older than
-- DISCOVERY_TTL_DAYS. ensureLawyerSchema() applies the same statement.

CREATE TABLE IF NOT EXISTS lawyer_discovery (
  lane        VARCHAR(16) NOT NULL,
  max_band    SMALLINT    NOT NULL,
  candidates  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  n           INTEGER     NOT NULL DEFAULT 0,
  fetched_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lane, max_band)
);
