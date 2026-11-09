-- 0013_private_indices.sql
-- Appraisal-based private-market index observations that have no public API
-- and are uploaded by hand each quarter (NCREIF Timberland Property Index,
-- NCREIF Farmland Property Index, later the ODCE / NPI if wanted).
--
-- One row per (index_id, period). period is a canonical "YYYYQn" string.
-- Returns are decimals (0.0123 = 1.23%). index_level is optional: when the
-- upload supplies only returns, /api/private-index chains a level itself.
-- Served by api/private-index.ts (GET public, POST ACCESS_TOKEN).
CREATE TABLE IF NOT EXISTS private_index_obs (
  index_id            text        NOT NULL,
  period              text        NOT NULL,
  total_return        numeric,
  income_return       numeric,
  appreciation_return numeric,
  index_level         numeric,
  source              text,
  note                text,
  uploaded_by         text,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_id, period)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS private_index_obs_index_id_idx ON private_index_obs (index_id, period DESC);
