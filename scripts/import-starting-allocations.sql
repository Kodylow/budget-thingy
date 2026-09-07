-- One-time, explicitly authorized import; NOT part of startup or migrations.
-- Bind $1 to the JSON in lib/db/data/starting-team-allocations.json.
-- Refuses the whole import when an existing allocation differs from both zero
-- and the supplied starting value. It never changes monthly spending limits.
WITH incoming AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x("teamName" text, "amountUsd" numeric, "isHidden" boolean)
), previous AS MATERIALIZED (
  SELECT t.* FROM team_budgets t
  JOIN incoming i ON i."teamName" = t.team_name
  FOR UPDATE OF t
), permission AS (
  SELECT NOT EXISTS (
    SELECT 1 FROM previous p JOIN incoming i ON p.team_name = i."teamName"
    WHERE p.original_amount_usd NOT IN (0, i."amountUsd"::double precision)
       OR p.amount_usd NOT IN (0, i."amountUsd"::double precision)
  ) AND (SELECT count(*) = 29 FROM incoming)
    AND (SELECT sum("amountUsd") = 771620.02 FROM incoming) AS allowed
), changed AS (
  INSERT INTO team_budgets (team_name, original_amount_usd, amount_usd, is_hidden)
  SELECT "teamName", "amountUsd", "amountUsd", "isHidden"
  FROM incoming WHERE (SELECT allowed FROM permission)
  ON CONFLICT (team_name) DO UPDATE SET
    original_amount_usd = EXCLUDED.original_amount_usd,
    amount_usd = EXCLUDED.amount_usd,
    is_hidden = EXCLUDED.is_hidden,
    updated_at = now()
  WHERE team_budgets.original_amount_usd IS DISTINCT FROM EXCLUDED.original_amount_usd
     OR team_budgets.amount_usd IS DISTINCT FROM EXCLUDED.amount_usd
     OR team_budgets.is_hidden IS DISTINCT FROM EXCLUDED.is_hidden
  RETURNING team_name
), audited AS (
  INSERT INTO team_budget_allocation_audits
    (team_name, field, old_value, new_value, actor_user_id)
  SELECT c.team_name, 'annualAllocationUsd',
    to_jsonb(COALESCE(p.original_amount_usd, 0)),
    to_jsonb(i."amountUsd"),
    'system:user-requested-opening-allocation-import'
  FROM changed c
  JOIN incoming i ON i."teamName" = c.team_name
  LEFT JOIN previous p ON p.team_name = c.team_name
  WHERE COALESCE(p.original_amount_usd, 0) <> i."amountUsd"
  UNION ALL
  SELECT c.team_name, 'isHidden',
    to_jsonb(COALESCE(p.is_hidden, false)), to_jsonb(i."isHidden"),
    'system:user-requested-opening-allocation-import'
  FROM changed c
  JOIN incoming i ON i."teamName" = c.team_name
  LEFT JOIN previous p ON p.team_name = c.team_name
  WHERE COALESCE(p.is_hidden, false) IS DISTINCT FROM i."isHidden"
  RETURNING id
)
SELECT (SELECT allowed FROM permission) AS allowed,
  (SELECT count(*) FROM changed) AS changed_teams,
  (SELECT count(*) FROM audited) AS audit_records;