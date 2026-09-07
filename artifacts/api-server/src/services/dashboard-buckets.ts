const DAY_MS = 86_400_000;

export type DashboardGranularity = "day" | "week" | "month";
export type DashboardTrendMode = "period" | "cumulative";

export interface DashboardDailyValue {
  day: string;
  spendUsd: number;
  complete: boolean;
}

export function utcBucketStart(
  day: string,
  granularity: DashboardGranularity,
): string {
  const value = new Date(`${day}T00:00:00.000Z`);
  if (granularity === "week") {
    value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  } else if (granularity === "month") {
    value.setUTCDate(1);
  }
  return value.toISOString().slice(0, 10);
}

export function buildDashboardBuckets(
  values: readonly DashboardDailyValue[],
  granularity: DashboardGranularity,
  mode: DashboardTrendMode,
  period?: { start: string; endExclusive: string },
) {
  const grouped = new Map<string, {
    endExclusive: string;
    spendUsd: number;
    partial: boolean;
  }>();
  for (const value of values) {
    const startDay = utcBucketStart(value.day, granularity);
    const current = grouped.get(startDay) ?? {
      endExclusive: `${value.day}T00:00:00.000Z`,
      spendUsd: 0,
      partial: false,
    };
    current.endExclusive = new Date(
      Date.parse(`${value.day}T00:00:00.000Z`) + DAY_MS,
    ).toISOString();
    current.spendUsd += value.spendUsd;
    current.partial ||= !value.complete;
    grouped.set(startDay, current);
  }
  let cumulative = 0;
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-62)
    .map(([startDay, value]) => {
      cumulative += value.spendUsd;
      const clampedStart = period &&
          Date.parse(`${startDay}T00:00:00.000Z`) < Date.parse(period.start)
        ? period.start
        : `${startDay}T00:00:00.000Z`;
      const clampedEnd = period &&
          Date.parse(value.endExclusive) > Date.parse(period.endExclusive)
        ? period.endExclusive
        : value.endExclusive;
      return {
        start: clampedStart,
        endExclusive: clampedEnd,
        spendUsd: value.partial ? null : value.spendUsd,
        valueUsd: mode === "cumulative"
          ? cumulative
          : value.partial ? null : value.spendUsd,
        isPartial: value.partial,
        isMissing: value.partial,
      };
    });
}