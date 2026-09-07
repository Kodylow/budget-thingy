import type { TeamBudgetHistoryTeam } from '@workspace/api-client-react';

export function parsePeriod(period: string | null | undefined) {
  const value = period?.trim() ?? '';
  const iso = value.match(/^(\d{4})-(\d{2})(?:-\d{2}(?:T.*)?)?$/);
  const us = value.match(/^(\d{1,2})[/-](\d{4})$/);
  if (iso || us) {
    const year = Number(iso ? iso[1] : us![2]);
    const month = Number(iso ? iso[2] : us![1]);
    return { year, month, unparseable: year < 1 || month < 1 || month > 12 };
  }
  const date = Date.parse(value);
  if (value && Number.isFinite(date)) {
    return { year: new Date(date).getUTCFullYear(), month: new Date(date).getUTCMonth() + 1, unparseable: false };
  }
  return { year: 0, month: 0, unparseable: true };
}

export function buildAllocationRow(team: TeamBudgetHistoryTeam, year: number) {
  const openingCents = Math.round(team.originalAmountUsd * 100);
  let priorCents = 0;
  let undatedCents = 0;
  let futureCents = 0;
  const monthlyCents = Array<number>(12).fill(0);
  for (const addition of team.adjustments) {
    const period = parsePeriod(addition.submissionPeriod);
    const cents = Math.round(addition.amountUsd * 100);
    if (period.unparseable) undatedCents += cents;
    else if (period.year < year) priorCents += cents;
    else if (period.year === year) monthlyCents[period.month - 1] += cents;
    else futureCents += cents;
  }
  const baseline = openingCents / 100;
  const carryForward = priorCents / 100;
  const undated = undatedCents / 100;
  const monthsData = monthlyCents.map(cents => cents / 100);
  const startingAllocation = (
    openingCents +
    priorCents +
    undatedCents +
    monthlyCents.slice(0, 7).reduce((a, b) => a + b, 0)
  ) / 100;
  const laterAdditions = monthlyCents.slice(9).reduce((a, b) => a + b, 0) / 100;
  return {
    team,
    isHidden: team.isHidden,
    baseline,
    carryForward,
    undated,
    monthsData,
    startingAllocation,
    august: monthsData[7],
    september: monthsData[8],
    laterAdditions,
    futureAdditions: futureCents / 100,
    rowTotal: (openingCents + priorCents + undatedCents + monthlyCents.reduce((a, b) => a + b, 0)) / 100,
  };
}

export function sumUsd(values: number[]) {
  return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
}