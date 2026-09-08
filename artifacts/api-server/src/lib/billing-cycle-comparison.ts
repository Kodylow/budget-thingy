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

export function isFutureOnlyComparisonSelection(
  startIso: string,
  now = new Date(),
): boolean {
  const tomorrow = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Date.parse(startIso) >= tomorrow;
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

function cappedWindow(
  key: BillingCycleKey,
  start: Date,
  endExclusive: Date,
  capExclusive: Date,
): BillingCycleWindow | null {
  const cappedEnd = new Date(Math.min(endExclusive.getTime(), capExclusive.getTime()));
  return cappedEnd > start ? window(key, start, cappedEnd) : null;
}

/**
 * Builds three comparison windows for a selected Home range. All windows end
 * on day boundaries and the current period never extends beyond today.
 */
export function selectedComparisonWindows(input: {
  rangeType: "billing" | "full-term" | "mtd" | "ytd" | "custom";
  selectedStart: string;
  selectedEndExclusive: string;
  now?: Date;
  billingStart?: string;
  billingEnd?: string;
}): BillingCycleWindow[] | null {
  const selectedStart = utcDate(input.selectedStart);
  const selectedEnd = utcDate(input.selectedEndExclusive);
  const now = input.now ?? new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
  ));
  if (!selectedStart || !selectedEnd || selectedEnd <= selectedStart) return null;
  const currentEnd = new Date(Math.min(selectedEnd.getTime(), tomorrow.getTime()));
  if (currentEnd <= selectedStart) return null;
  const elapsed = currentEnd.getTime() - selectedStart.getTime();

  if (input.rangeType === "billing") {
    const billing = input.billingStart && input.billingEnd
      ? billingCycleWindows(input.billingStart, input.billingEnd)
      : null;
    if (!billing) return null;
    const result = billing.map((cycle) => {
      const start = utcDate(cycle.start)!;
      const naturalEnd = utcDate(cycle.endExclusive)!;
      return cappedWindow(
        cycle.key,
        start,
        new Date(Math.min(naturalEnd.getTime(), start.getTime() + elapsed)),
        tomorrow,
      );
    });
    return result.every(Boolean) ? result as BillingCycleWindow[] : null;
  }

  const keys: BillingCycleKey[] = ["current", "previous", "twoAgo"];
  if (input.rangeType === "mtd") {
    const result = keys.map((key, index) => {
      const start = shiftUtcMonthClamped(selectedStart, -index);
      const monthEnd = new Date(Date.UTC(
        start.getUTCFullYear(), start.getUTCMonth() + 1, 1,
      ));
      return cappedWindow(
        key,
        start,
        new Date(Math.min(monthEnd.getTime(), start.getTime() + elapsed)),
        tomorrow,
      );
    });
    return result.every(Boolean) ? result as BillingCycleWindow[] : null;
  }

  if (input.rangeType === "ytd") {
    return keys.map((key, index) => {
      const start = new Date(Date.UTC(
        selectedStart.getUTCFullYear() - index,
        selectedStart.getUTCMonth(),
        selectedStart.getUTCDate(),
      ));
      return window(key, start, new Date(start.getTime() + elapsed));
    });
  }

  return keys.map((key, index) => {
    const end = new Date(currentEnd.getTime() - index * elapsed);
    return window(key, new Date(end.getTime() - elapsed), end);
  });
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