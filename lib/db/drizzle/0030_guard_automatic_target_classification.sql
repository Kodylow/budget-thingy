-- Clean installs deliberately preserve every pre-provenance target unchanged.
-- This migration remains as a no-op so databases that observed an earlier
-- development draft retain a valid, monotonic journal.
UPDATE "team_limit_targets"
SET "assignment_source" = "assignment_source"
WHERE false;