// @ts-nocheck
import { test, expect } from "vitest";

import { generateTrendBuckets } from "./trend-buckets.ts";

function customRange(startDate: string, endDate: string) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    key: `custom:${startDate}:${endDate}`,
    label: `${startDate} to ${endDate}`,
    params: {
      startTime: `${startDate}T00:00:00.000Z`,
      endTime: end.toISOString(),
    },
  };
}

test("weekly buckets use clipped Monday-Sunday UTC boundaries without gaps", () => {
  const range = customRange("2026-06-03", "2026-06-16");
  const buckets = generateTrendBuckets(range, "week", new Date("2026-08-26T12:00:00Z"));
  expect(buckets).toEqual([
    { startDate: "2026-06-03", endDate: "2026-06-07", isPartial: false },
    { startDate: "2026-06-08", endDate: "2026-06-14", isPartial: false },
    { startDate: "2026-06-15", endDate: "2026-06-16", isPartial: false },
  ]);
});

test("monthly buckets preserve selected inclusive range boundaries", () => {
  const range = customRange("2026-05-20", "2026-07-04");
  const buckets = generateTrendBuckets(range, "month", new Date("2026-08-26T12:00:00Z"));
  expect(buckets).toEqual([
    { startDate: "2026-05-20", endDate: "2026-05-31", isPartial: false },
    { startDate: "2026-06-01", endDate: "2026-06-30", isPartial: false },
    { startDate: "2026-07-01", endDate: "2026-07-04", isPartial: false },
  ]);
});

test("only the bucket containing the current UTC day is partial", () => {
  const range = customRange("2026-08-01", "2026-08-26");
  const buckets = generateTrendBuckets(range, "week", new Date("2026-08-26T15:45:00Z"));
  expect(buckets.filter((bucket) => bucket.isPartial).length).toBe(1);
  expect(buckets.at(-1)).toEqual({
    startDate: "2026-08-24",
    endDate: "2026-08-26",
    isPartial: true,
  });
});