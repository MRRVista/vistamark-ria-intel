-- v0.41.4 -- lawyer_discovery.complete: only a directory walk in which every
-- call answered is kept for the week. Rows saved by v0.41.2 / v0.41.3 read as
-- not complete and are walked again (one of them held 9 of a lane's 99
-- attorneys after a roster call timed out).

ALTER TABLE lawyer_discovery ADD COLUMN IF NOT EXISTS complete BOOLEAN NOT NULL DEFAULT FALSE;
