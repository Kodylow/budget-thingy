import type { OrgBudgetOverviewResponse } from '@workspace/api-client-react';
import { trajectoryChartData } from './home-components/budget-trajectory';

export type OrgChartTeam = OrgBudgetOverviewResponse['teams'][number];
export type OrgBudgetChartRow = {
  date: string;
  day: number;
  values: Record<string, { actual: number | null; benchmark: number | null }>;
};

export const orgChartDay = (date: string) =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export const orgChartDateLabel = (date: string | number) =>
  new Date(typeof date === 'number' ? date * 86_400_000 : `${date}T00:00:00Z`)
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function getFundedTeams(teams: OrgChartTeam[]): OrgChartTeam[] {
  return [...new Map(teams
    .filter(team => Number.isFinite(team.allocationUsd) && team.allocationUsd! > 0)
    .map(team => [team.id, team])).values()];
}

export function buildOrgBudgetChartData(
  data: OrgBudgetOverviewResponse,
  teams: OrgChartTeam[],
): OrgBudgetChartRow[] {
  const startDay = orgChartDay(data.periodStart);
  const endDay = orgChartDay(data.periodEnd);
  const validTerm = Number.isFinite(startDay) && Number.isFinite(endDay) && endDay >= startDay;
  const dates = [...new Set(teams.flatMap(team => team.points
    .filter(point => Number.isFinite(orgChartDay(point.date)))
    .map(point => point.date)))];
  const rows = new Map<string, OrgBudgetChartRow>();
  for (const team of teams) {
    const actualByDate = new Map(team.points.map(point => [point.date, point.spendUsd]));
    // The endpoint is account-wide and uses one canonical funding term.
    // A known allocation's plan does not depend on complete usage history.
    const points = trajectoryChartData({
      benchmarkEligible: validTerm && Number.isFinite(team.allocationUsd) && team.allocationUsd! > 0,
      comparisonsMatchBudgetWindow: validTerm,
      periodStart: validTerm ? data.periodStart : null,
      periodEnd: validTerm ? data.periodEnd : null,
      allocationUsd: team.allocationUsd,
      reportingStart: validTerm ? data.periodStart : null,
      reportingEnd: validTerm ? data.periodEnd : null,
      asOf: data.asOf,
      points: data.asOf ? dates.map(date => ({
        date,
        spendUsd: actualByDate.get(date) ?? null,
      })) : [],
    });
    for (const point of points) {
      const row = rows.get(point.date) ?? { date: point.date, day: point.day, values: {} };
      row.values[team.id] = { actual: point.actual ?? null, benchmark: point.benchmark };
      rows.set(point.date, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.day - b.day);
}