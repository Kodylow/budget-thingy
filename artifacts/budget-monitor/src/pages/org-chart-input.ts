import type { OrgBudgetOverviewResponse } from '@workspace/api-client-react';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const money = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));
// Unusable allocations are a per-series display state, not a malformed report.
const allocation = (value: unknown) => value == null || typeof value === 'number';
const date = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const points = (value: unknown) => Array.isArray(value) &&
  value.every(point => record(point) && date(point.date) && money(point.spendUsd));

// Validate only chart inputs, without converting absent data into zeroes or team sums.
export function hasCompatibleOrgChartInput(value: unknown): value is OrgBudgetOverviewResponse {
  if (!record(value) || !record(value.summary) || !Array.isArray(value.teams)) return false;
  return date(value.periodStart) && date(value.periodEnd) && value.periodEnd >= value.periodStart &&
    (value.asOf === null || (typeof value.asOf === 'string' && date(value.asOf.slice(0, 10)) &&
      Number.isFinite(Date.parse(value.asOf)))) &&
    typeof value.complete === 'boolean' &&
    money(value.summary.accountSpendUsd) && allocation(value.summary.teamAllocationUsd) &&
    points(value.accountPoints) && value.teams.every(team =>
      record(team) && typeof team.id === 'string' && typeof team.name === 'string' &&
      allocation(team.allocationUsd) && money(team.spendUsd) && typeof team.complete === 'boolean' &&
      points(team.points));
}