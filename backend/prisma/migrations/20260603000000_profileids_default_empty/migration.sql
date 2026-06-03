-- Migration: set default value of profileIds to empty array
-- Additive only: sets the column default so new rows without explicit profileIds get '{}' not NULL.
-- Existing rows were already backfilled (NULL → '{}') in the previous session.

ALTER TABLE "VfsAccount" ALTER COLUMN "profileIds" SET DEFAULT '{}';
