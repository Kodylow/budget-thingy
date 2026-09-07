import { describe, expect, it } from "vitest";
import { resolveUsageWindow } from "./usage-window";

const now = new Date("2026-09-05T12:00:00.000Z");
const billingPeriod = {
  start: "2026-08-17T00:00:00.000Z",
  end: "2026-09-17T00:00:00.000Z",
};

describe("usage reporting window defaults", () => {
  it("uses the full reporting period when rangeType is omitted", () => {
    expect(resolveUsageWindow({ now, billingPeriod }).window).toEqual({
      start: "2026-05-20T00:00:00.000Z",
      end: "2026-09-06T00:00:00.000Z",
    });
  });

  it("keeps an explicit billing period on the current cycle", () => {
    expect(resolveUsageWindow({
      rangeType: "billing",
      now,
      billingPeriod,
    }).window).toEqual({
      start: "2026-08-17T00:00:00.000Z",
      end: "2026-09-06T00:00:00.000Z",
    });
  });

  it("keeps explicit custom dates inclusive", () => {
    expect(resolveUsageWindow({
      rangeType: "custom",
      startDate: "2026-06-02",
      endDate: "2026-07-03",
      now,
      billingPeriod,
    }).window).toEqual({
      start: "2026-06-02T00:00:00.000Z",
      end: "2026-07-04T00:00:00.000Z",
    });
  });
});