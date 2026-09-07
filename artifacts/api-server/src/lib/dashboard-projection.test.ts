import { describe, expect, test } from "vitest";
import { buildDashboardProjection, type ProjectionDay } from "./dashboard-projection";

const DAY_MS = 86_400_000;

function days(
  start: string,
  count: number,
  value: (index: number) => number = () => 10,
): ProjectionDay[] {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => ({
    day: new Date(startMs + index * DAY_MS).toISOString().slice(0, 10),
    spendUsd: value(index),
    complete: true,
  }));
}

function project(overrides: Partial<Parameters<typeof buildDashboardProjection>[0]> = {}) {
  return buildDashboardProjection({
    now: new Date("2028-03-01T17:45:00-05:00"),
    actualPeriod: {
      start: "2028-02-01T00:00:00.000Z",
      endExclusive: "2028-03-02T00:00:00.000Z",
    },
    target: {
      kind: "month_end",
      start: "2028-02-01T00:00:00.000Z",
      endExclusive: "2028-04-01T00:00:00.000Z",
      verified: true,
    },
    days: days("2028-02-01", 29),
    budget: null,
    stale: false,
    ...overrides,
  });
}

describe("dashboard projection", () => {
  test("uses UTC leap-day boundaries and at most 28 consecutive complete days", () => {
    const result = project();
    expect(result.dataThrough).toBe("2028-02-29");
    expect(result.rate).toMatchObject({
      completeDays: 28,
      windowStart: "2028-02-02T00:00:00.000Z",
      windowEndExclusive: "2028-03-01T00:00:00.000Z",
      dailySpendUsd: 10,
      sevenDayDailySpendUsd: 10,
      twentyEightDayDailySpendUsd: 10,
    });
    expect(result.baseline).toEqual({ spendUsd: 290, complete: true });
    expect(result.projectedTotalUsd).toBe(600);
  });

  test("keeps the selected reporting history when the target starts later", () => {
    const result = project({
      target: {
        kind: "month_end",
        start: "2028-03-01T00:00:00.000Z",
        endExclusive: "2028-04-01T00:00:00.000Z",
        verified: true,
      },
    });
    expect(result.rate.completeDays).toBe(28);
    expect(result.baseline).toEqual({ spendUsd: 290, complete: true });
    expect(result.projectedTotalUsd).toBe(600);
    expect(result.trajectory[0]).toMatchObject({
      date: "2028-02-01",
      actualCumulativeUsd: 10,
      projectedCumulativeUsd: null,
    });
    expect(result.trajectory.at(-1)).toMatchObject({
      date: "2028-03-31",
      projectedCumulativeUsd: 600,
    });
  });

  test("counts real zero days and preserves negative adjustments", () => {
    const result = project({
      days: days("2028-02-01", 29, (index) =>
        index >= 22 ? (index === 25 ? -7 : 0) : 3),
    });
    expect(result.rate.completeDays).toBe(28);
    expect(result.rate.sevenDayDailySpendUsd).toBe(-1);
    expect(result.rate.dailySpendUsd).toBe(2);
    expect(result.projectedTotalUsd).toBe(121);
  });

  test("never bridges missing baseline days or treats them as zero", () => {
    const facts = days("2028-02-01", 29);
    facts[9] = { ...facts[9]!, complete: false };
    const result = project({ days: facts });
    expect(result.rate.completeDays).toBe(19);
    expect(result.baseline.complete).toBe(false);
    expect(result.baseline.spendUsd).toBe(290);
    expect(result.projectedTotalUsd).toBeNull();
    expect(result.projectedKnownTotalUsd).toBe(600);
    expect(result.reasons).toContain("incomplete_baseline");
  });

  test("labels stale observations and requires seven consecutive complete days", () => {
    const result = project({
      days: days("2028-02-01", 25),
      budget: {
        amountUsd: 1_000,
        kind: "canonical_allocation",
        label: "Allocation",
      },
    });
    expect(result.dataThrough).toBe("2028-02-25");
    expect(result.stale).toBe(true);
    expect(result.status).toBe("unavailable");
    expect(result.rate.completeDays).toBe(25);

    const tooShort = project({ days: days("2028-02-24", 6) });
    expect(tooShort.rate.dailySpendUsd).toBeNull();
    expect(tooShort.projectedTotalUsd).toBeNull();
    expect(tooShort.reasons).toContain("insufficient_rate_history");
  });

  test("does not project across a known incomplete tail fact", () => {
    const facts = days("2028-02-01", 29);
    facts[28] = { ...facts[28]!, complete: false };
    const result = project({ days: facts });
    expect(result.dataThrough).toBe("2028-02-29");
    expect(result.baseline.spendUsd).toBe(290);
    expect(result.baseline.complete).toBe(false);
    expect(result.reasons).toContain("incomplete_baseline");
    expect(result.projectedTotalUsd).toBeNull();
    expect(result.projectedKnownTotalUsd).toBe(600);
  });

  test("does not silently forecast a historical reporting selection", () => {
    const result = project({
      actualPeriod: {
        start: "2028-01-01T00:00:00.000Z",
        endExclusive: "2028-02-01T00:00:00.000Z",
      },
    });
    expect(result.projectedTotalUsd).toBeNull();
    expect(result.reasons).toContain("historical_reporting_period");
    expect(result.trajectory[0]?.date).toBe("2028-01-01");
    expect(result.trajectory.at(-1)?.date).toBe("2028-01-31");
    expect(result.trajectory.every((point) =>
      point.projectedCumulativeUsd === null)).toBe(true);
  });

  test("requires verified cycle ends and a future explicit planning end", () => {
    const cycle = project({
      target: {
        kind: "cycle_end",
        start: "2028-02-20T00:00:00.000Z",
        endExclusive: null,
        verified: false,
      },
    });
    expect(cycle.reasons).toContain("unverified_cycle_end");
    expect(cycle.projectedTotalUsd).toBeNull();

    const planning = project({
      target: {
        kind: "planning_end",
        start: "2028-02-01T00:00:00.000Z",
        endExclusive: "2028-03-01T00:00:00.000Z",
        verified: true,
      },
    });
    expect(planning.reasons).toContain("invalid_planning_end");
  });

  test("applies exact visual status thresholds without clipping overage", () => {
    const base = project({
      target: {
        kind: "planning_end",
        start: "2028-02-01T00:00:00.000Z",
        endExclusive: "2028-03-02T00:00:00.000Z",
        verified: true,
      },
      budget: {
        amountUsd: 300,
        kind: "canonical_allocation",
        label: "Allocation",
      },
    });
    expect(base.projectedTotalUsd).toBe(300);
    expect(base.status).toBe("near");
    expect(base.projectedUsePercent).toBe(100);

    const over = project({
      budget: {
        amountUsd: 500,
        kind: "canonical_allocation",
        label: "Allocation",
      },
    });
    expect(over.status).toBe("over");
    expect(over.projectedRemainingUsd).toBe(-100);
    expect(over.projectedOverageUsd).toBe(100);

    const zeroBudget = project({
      budget: {
        amountUsd: 0,
        kind: "canonical_allocation",
        label: "Allocation",
      },
    });
    expect(zeroBudget.projectedUsePercent).toBeNull();
    expect(zeroBudget.status).toBe("over");
    expect(zeroBudget.projectedRemainingUsd).toBe(-600);

    const negativePaceAfterExceeded = project({
      days: days("2028-02-01", 29, (index) => index === 0 ? 1_000 : -10),
      budget: {
        amountUsd: 500,
        kind: "canonical_allocation",
        label: "Allocation",
      },
    });
    expect(negativePaceAfterExceeded.baseline.spendUsd).toBe(720);
    expect(negativePaceAfterExceeded.projectedTotalUsd).toBeLessThan(500);
    expect(negativePaceAfterExceeded.status).toBe("over");
  });

  test("samples long horizons with accurate endpoints instead of omitting them", () => {
    const result = project({
      target: {
        kind: "planning_end",
        start: "2026-05-20T00:00:00.000Z",
        endExclusive: "2029-01-01T00:00:00.000Z",
        verified: true,
      },
      days: days("2026-05-20", 651),
    });
    expect(result.trajectory.length).toBeGreaterThan(2);
    expect(result.trajectory.length).toBeLessThanOrEqual(400);
    expect(result.trajectory[0]?.date).toBe("2028-02-01");
    expect(result.trajectory.at(-1)?.date).toBe("2028-12-31");
  });

  test("samples an extreme pure-engine horizon arithmetically", () => {
    const result = project({
      target: {
        kind: "planning_end",
        start: "2028-02-01T00:00:00.000Z",
        endExclusive: "9999-12-31T00:00:00.000Z",
        verified: true,
      },
    });
    expect(result.trajectory.length).toBeLessThanOrEqual(400);
    expect(result.trajectory.at(-1)?.date).toBe("9999-12-30");
  });

  test("uses inclusive Dec 31 and fixed term-end chart dates", () => {
    const year = project({
      target: {
        kind: "year_end",
        start: "2028-01-01T00:00:00.000Z",
        endExclusive: "2029-01-01T00:00:00.000Z",
        verified: true,
      },
    });
    expect(year.trajectory.at(-1)?.date).toBe("2028-12-31");

    const term = project({
      now: new Date("2026-12-31T12:00:00.000Z"),
      actualPeriod: {
        start: "2026-05-20T00:00:00.000Z",
        endExclusive: "2027-01-01T00:00:00.000Z",
      },
      target: {
        kind: "term_end",
        start: "2026-05-20T00:00:00.000Z",
        endExclusive: "2027-05-21T00:00:00.000Z",
        verified: true,
      },
      days: [],
    });
    expect(term.trajectory.at(-1)?.date).toBe("2027-05-20");
  });

  test("blocks an expired fixed term instead of rolling it forward", () => {
    const expired = project({
      target: {
        kind: "term_end",
        start: "2026-05-20T00:00:00.000Z",
        endExclusive: "2027-05-21T00:00:00.000Z",
        verified: true,
      },
    });
    expect(expired.reasons).toContain("invalid_planning_end");
    expect(expired.projectedTotalUsd).toBeNull();
  });

  test("includes a recorded current day in known cumulative spend but not pace", () => {
    const result = project({
      actualPeriod: {
        start: "2028-02-20T00:00:00.000Z",
        endExclusive: "2028-03-02T00:00:00.000Z",
      },
      days: [
        ...days("2028-02-02", 28),
        { day: "2028-03-01", spendUsd: 7, complete: false },
      ],
    });
    expect(result.dataThrough).toBe("2028-03-01");
    expect(result.rate.dailySpendUsd).toBe(10);
    expect(result.baseline).toEqual({ spendUsd: 107, complete: false });
    expect(result.trajectory.find((point) => point.date === "2028-03-01"))
      .toMatchObject({ actualCumulativeUsd: 107 });
  });

  test("does not turn an absent prior day into a zero-spend fact", () => {
    const selected = days("2028-02-01", 29);
    selected.splice(5, 1);
    const result = project({ days: selected });
    expect(result.baseline).toEqual({ spendUsd: 280, complete: false });
    expect(result.projectedTotalUsd).toBeNull();
    expect(result.projectedKnownTotalUsd).toBe(590);
  });
});