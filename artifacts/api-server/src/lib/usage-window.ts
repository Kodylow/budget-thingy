const DAY_MS = 86_400_000;

export const USAGE_DATA_CUTOFF_ISO = "2026-05-20T00:00:00.000Z";
export const USAGE_DATA_CUTOFF_MS = Date.parse(USAGE_DATA_CUTOFF_ISO);

export type UsageWindowRangeType =
  | "billing"
  | "full-term"
  | "mtd"
  | "ytd"
  | "custom";

export interface UsageWindow {
  start: string;
  end: string;
}

export interface BillingWindowAnchor {
  start: string;
  end: string;
}

export interface UsageWindowSelection {
  window: UsageWindow;
  label: string;
  isLive: boolean;
}

export interface ResolveUsageWindowOptions {
  rangeType?: string;
  startDate?: string;
  endDate?: string;
  now?: Date;
  billingPeriod?: BillingWindowAnchor | null;
}

export class UsageWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageWindowError";
  }
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  ));
}

function ceilUtcDayMs(value: number): number {
  const floor = Math.floor(value / DAY_MS) * DAY_MS;
  return floor === value ? value : floor + DAY_MS;
}

function floorUtcDayMs(value: number): number {
  return Math.floor(value / DAY_MS) * DAY_MS;
}

function addUtcDays(value: Date, count: number): Date {
  return new Date(value.getTime() + count * DAY_MS);
}

function parseUtcDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
}

function activeBillingPeriod(
  period: BillingWindowAnchor | null | undefined,
  nowMs: number,
): { start: number; end: number } | null {
  if (!period) return null;
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  return Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      end > nowMs
    ? { start, end }
    : null;
}

function labelFor(start: Date, endExclusive: Date): string {
  return `${start.toISOString().slice(0, 10)} to ${
    addUtcDays(endExclusive, -1).toISOString().slice(0, 10)
  }`;
}

/**
 * Resolves reporting choices to immutable UTC boundaries. The end is always
 * exclusive and no cache/range identity is embedded in this contract.
 */
export function resolveUsageWindow(
  options: ResolveUsageWindowOptions,
): UsageWindowSelection {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new UsageWindowError("Invalid current time");

  const today = utcDayStart(now);
  const nextDay = addUtcDays(today, 1);
  const rangeType = options.rangeType ?? "billing";
  let start: Date;
  let end: Date;
  let label: string;

  switch (rangeType) {
    case "full-term":
      start = new Date(USAGE_DATA_CUTOFF_MS);
      end = nextDay;
      label = labelFor(start, end);
      break;
    case "mtd":
      start = new Date(Math.max(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        USAGE_DATA_CUTOFF_MS,
      ));
      end = nextDay;
      label = `${now.toLocaleString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })} (MTD)`;
      break;
    case "ytd":
      start = new Date(Math.max(
        Date.UTC(now.getUTCFullYear(), 0, 1),
        USAGE_DATA_CUTOFF_MS,
      ));
      end = nextDay;
      label = `${now.getUTCFullYear()} year to date`;
      break;
    case "custom": {
      const requestedStart = parseUtcDate(options.startDate);
      const requestedEnd = parseUtcDate(options.endDate);
      if (!requestedStart || !requestedEnd) {
        throw new UsageWindowError(
          "startDate and endDate are required as UTC dates for a custom range",
        );
      }
      start = new Date(Math.max(requestedStart.getTime(), USAGE_DATA_CUTOFF_MS));
      end = addUtcDays(requestedEnd, 1);
      if (end <= start) {
        throw new UsageWindowError(
          `Date range predates available usage data (cutoff: ${
            USAGE_DATA_CUTOFF_ISO.slice(0, 10)
          })`,
        );
      }
      label = labelFor(start, end);
      break;
    }
    case "billing":
    default: {
      const period = activeBillingPeriod(options.billingPeriod, now.getTime());
      start = new Date(ceilUtcDayMs(Math.max(
        period?.start ?? USAGE_DATA_CUTOFF_MS,
        USAGE_DATA_CUTOFF_MS,
      )));
      end = new Date(floorUtcDayMs(Math.min(
        period?.end ?? nextDay.getTime(),
        nextDay.getTime(),
      )));
      if (end <= start) {
        start = new Date(USAGE_DATA_CUTOFF_MS);
        end = nextDay;
      }
      label = labelFor(start, end);
      break;
    }
  }

  const window = { start: start.toISOString(), end: end.toISOString() };
  return {
    window,
    label,
    isLive: end.getTime() > today.getTime(),
  };
}