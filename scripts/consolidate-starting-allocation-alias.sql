-- Explicitly approved identity consolidation. No upstream budget writes.
-- $1 is the old alias; $2 is the confirmed canonical team.
-- Refuses deletion if the alias has edits, adjustments, or limit targets.
WITH duplicate AS MATERIALIZED (
  SELECT * FROM team_budgets
  WHERE team_name = $1
    AND original_amount_usd = 37473.54
    AND amount_usd = 37473.54
    AND monthly_limit_usd IS NULL
    AND NOT EXISTS (SELECT 1 FROM team_budget_adjustments WHERE team_name = $1)
    AND NOT EXISTS (SELECT 1 FROM team_limit_targets WHERE team_name = $1)
    AND EXISTS (SELECT 1 FROM team_budgets WHERE team_name = $2 AND original_amount_usd = 37473.54)
  FOR UPDATE
), mapped AS (
  UPDATE family_team_mappings SET team_name = $2
  WHERE team_name = $1 AND EXISTS (SELECT 1 FROM duplicate)
  RETURNING team_name
), audited AS (
  INSERT INTO team_budget_allocation_audits
    (team_name, field, old_value, new_value, actor_user_id)
  SELECT team_name, 'annualAllocationUsd', to_jsonb(original_amount_usd),
    '0'::jsonb, 'system:user-confirmed-team-alias-consolidation'
  FROM duplicate
  RETURNING id
), removed AS (
  DELETE FROM team_budgets WHERE team_name IN (SELECT team_name FROM duplicate)
    AND EXISTS (SELECT 1 FROM audited)
  RETURNING team_name
)
SELECT (SELECT count(*) FROM mapped) AS updated_mappings,
  (SELECT count(*) FROM removed) AS removed_duplicate_allocations;