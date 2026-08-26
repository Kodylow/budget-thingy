import type { UsageRange } from "./enterprise";

const DAY_MS = 86_400_000;

export interface TrendBucket {
  startDate: string;
  endDate: string;
  isPartial: boolean;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function nextMonday(date: Date): Date {
  const daysUntilMonday = (8 - date.getUTCDay()) % 7 || 7;
  return new Date(date.getTime() + daysUntilMonday * DAY_MS);
}

/**
 * Partition a selected usage range into non-overlapping UTC calendar buckets.
 * The API's custom ranges use inclusive dates, while UsageRange endTime is an
 * exclusive timestamp. Open ranges are represented through the current UTC day.
 */
export function generateTrendBuckets(
  range: UsageRange,
  granularity: "week" | "month",
  now = new Date(),
): TrendBucket[] {
  const startTime = range.params["startTime"];
  const endTime = range.params["endTime"];
  if (!startTime || !endTime) return [];

  const selectedStart = startOfUtcDay(new Date(startTime));
  const rawEnd = new Date(endTime);
  const selectedEndExclusive = rawEnd.getTime() % DAY_MS === 0
    ? rawEnd
    : new Date(startOfUtcDay(rawEnd).getTime() + DAY_MS);
  const todayStart = startOfUtcDay(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const buckets: TrendBucket[] = [];

  let cursor = selectedStart;
  while (cursor < selectedEndExclusive) {
    const calendarEnd = granularity === "month"
      ? new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
      : nextMonday(cursor);
    const endExclusive = new Date(
      Math.min(calendarEnd.getTime(), selectedEndExclusive.getTime()),
    );
    const endInclusive = new Date(endExclusive.getTime() - 1);
    buckets.push({
      startDate: isoDate(cursor),
      endDate: isoDate(endInclusive),
      isPartial:
        cursor <= todayStart &&
        endExclusive >= tomorrowStart &&
        rawEnd.getTime() > todayStart.getTime() &&
        now.getTime() < endExclusive.getTime(),
    });
    cursor = endExclusive;
  }
  return buckets;
}