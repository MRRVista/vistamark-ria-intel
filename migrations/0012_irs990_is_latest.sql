-- v0.38.1: irs990_latest_filings without DISTINCT ON.
--
-- Migration 0007 defined the view as `SELECT DISTINCT ON (ein) * ... ORDER BY
-- ein, tax_period_end DESC, return_ts DESC`. Postgres cannot push a WHERE
-- clause (state = 'IL', total_assets_eoy >= N) below DISTINCT ON, so every
-- irs990_filing_search / irs990_people_search / prospect_360 / org_360 call
-- sorted the whole filings table first. Fine while the table was empty; a
-- 9 s timeout once the 990 backfill landed.
--
-- Fix: a maintained `is_latest` flag on irs990_filings, partial indexes over
-- the flagged rows, and the view becomes a plain `WHERE is_latest`. The
-- loader (lib/irs990/ingest.ts refreshLatest) re-flags the EINs it touched
-- after every batch; `scripts/irs990-ingest.ts --refresh-latest` recomputes
-- the whole table.
--
-- Ordering matters because the runner replays every file on every call:
--   1. add the column (idempotent)
--   2. backfill, guarded so it is a no-op once any row is flagged. If this
--      statement times out under Vercel, the old view is still in place;
--      run the backfill from the loader and call migrate again.
--   3. partial indexes
--   4. replace the view

ALTER TABLE irs990_filings ADD COLUMN IF NOT EXISTS is_latest BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint
UPDATE irs990_filings f SET is_latest = TRUE
FROM (
  SELECT DISTINCT ON (ein) object_id
  FROM irs990_filings
  ORDER BY ein, tax_period_end DESC NULLS LAST, return_ts DESC NULLS LAST
) w
WHERE f.object_id = w.object_id
  AND NOT EXISTS (SELECT 1 FROM irs990_filings WHERE is_latest LIMIT 1);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_latest_ein_idx ON irs990_filings (ein) WHERE is_latest;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_latest_state_assets_idx ON irs990_filings (state, total_assets_eoy DESC NULLS LAST) WHERE is_latest;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_latest_assets_idx ON irs990_filings (total_assets_eoy DESC NULLS LAST) WHERE is_latest;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_latest_revenue_idx ON irs990_filings (total_revenue DESC NULLS LAST) WHERE is_latest;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_latest_zip_idx ON irs990_filings (zip) WHERE is_latest;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS irs990_filings_latest_name_trgm_idx ON irs990_filings USING GIN (org_name gin_trgm_ops) WHERE is_latest;
--> statement-breakpoint
DROP VIEW IF EXISTS irs990_latest_filings;
--> statement-breakpoint
CREATE VIEW irs990_latest_filings AS
SELECT * FROM irs990_filings WHERE is_latest;
