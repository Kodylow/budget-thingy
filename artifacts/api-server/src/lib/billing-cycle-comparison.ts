const DAY_MS = 86_400_000;

export type BillingCycleKey = "current" | "previous" | "twoAgo";

export interface BillingCycleWindow {
  key: BillingCycleKey;
  label: string;
  startDate: string;
  endDate: string;
  start: string;
  endExclusive: string;
}

export interface DailyComparisonValue {
  knownSpendUsd: number | null;
  complete: boolean;
}

export interface BillingCyclePoint {
  day: number;
  date: string;
  personalSpendUsd: number | null;
  teamSpendUsd: number | null;
}

function utcDate(iso: string): Date | null {
  const value = new Date(iso);
  return Number.isFinite(value.getTime()) &&
      value.getTime() % DAY_MS === 0
    ? value
    : null;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Shift an anchor by calendar months, clamping its day in the target month. */
export function shiftUtcMonthClamped(anchor: Date, offset: number): Date {
  const ordinal = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset;
  const year = Math.floor(ordinal / 12);
  const month = ((ordinal % 12) + 12) % 12;
  return new Date(Date.UTC(
    year,
    month,
    Math.min(anchor.getUTCDate(), daysInUtcMonth(year, month)),
  ));
}

function displayDate(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function window(
  key: BillingCycleKey,
  start: Date,
  endExclusive: Date,
): BillingCycleWindow {
  const endDate = new Date(endExclusive.getTime() - DAY_MS)
    .toISOString().slice(0, 10);
  const startDate = start.toISOString().slice(0, 10);
  return {
    key,
    label: `${displayDate(startDate)} – ${displayDate(endDate)}`,
    startDate,
    endDate,
    start: start.toISOString(),
    endExclusive: endExclusive.toISOString(),
  };
}

/**
 * Derive comparison periods from the verified current interval. Previous
 * boundaries use calendar arithmetic from the real start anchor, never a
 * fixed-duration subtraction.
 */
export function billingCycleWindows(
  currentStartIso: string,
  currentEndIso: string,
): BillingCycleWindow[] | null {
  const currentStart = utcDate(currentStartIso);
  const currentEnd = utcDate(currentEndIso);
  if (!currentStart || !currentEnd || currentEnd <= currentStart) return null;
  const previousStart = shiftUtcMonthClamped(currentStart, -1);
  const twoAgoStart = shiftUtcMonthClamped(currentStart, -2);
  return [
    window("current", currentStart, currentEnd),
    window("previous", previousStart, currentStart),
    window("twoAgo", twoAgoStart, previousStart),
  ];
}

function addDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS)
    .toISOString().slice(0, 10);
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

export function buildBillingCyclePoints(
  cycle: BillingCycleWindow,
  personalByDate: ReadonlyMap<string, DailyComparisonValue>,
  teamByDate: ReadonlyMap<string, DailyComparisonValue>,
  today: string,
): {
  personalComplete: boolean;
  teamComplete: boolean;
  points: BillingCyclePoint[];
} {
  let personalCumulative = 0;
  let teamCumulative = 0;
  let personalComplete = true;
  let teamComplete = true;
  const points: BillingCyclePoint[] = [];

  for (
    let date = cycle.startDate, day = 1;
    date <= cycle.endDate;
    date = addDay(date, 1), day += 1
  ) {
    if (date > today) {
      points.push({
        day,
        date,
        personalSpendUsd: null,
        teamSpendUsd: null,
      });
      continue;
    }
    const personal = personalByDate.get(date) ??
      { knownSpendUsd: null, complete: false };
    const team = teamByDate.get(date) ??
      { knownSpendUsd: null, complete: false };
    if (personal.knownSpendUsd !== null) {
      personalCumulative += personal.knownSpendUsd;
    }
    if (team.knownSpendUsd !== null) teamCumulative += team.knownSpendUsd;
    if (!personal.complete) personalComplete = false;
    if (!team.complete) teamComplete = false;
    points.push({
      day,
      date,
      personalSpendUsd: personal.complete
        ? rounded(personalCumulative)
        : null,
      teamSpendUsd: team.complete ? rounded(teamCumulative) : null,
    });
  }
  return { personalComplete, teamComplete, points };
}