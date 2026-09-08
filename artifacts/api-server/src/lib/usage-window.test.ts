import { describe, expect, it } from "vitest";
import {
  fixedTeamBudgetPeriodAsOf,
  resolveUsageWindow,
} from "./usage-window";

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

  it("rejects extreme explicit custom dates before cutoff clipping or enumeration", () => {
    for (const [startDate, endDate] of [
      ["0006-02-02", "2026-09-05"],
      ["2026-09-05", "6090-02-02"],
    ]) {
      expect(() => resolveUsageWindow({
        rangeType: "custom",
        startDate,
        endDate,
        now,
        billingPeriod,
      })).toThrow(/limited to 400 inclusive days/i);
    }
  });

  it("accepts exactly 400 inclusive custom days", () => {
    expect(resolveUsageWindow({
      rangeType: "custom",
      startDate: "2026-05-20",
      endDate: "2027-06-23",
      now,
      billingPeriod,
    }).window).toEqual({
      start: "2026-05-20T00:00:00.000Z",
      end: "2027-06-24T00:00:00.000Z",
    });
  });

  it("keeps the confirmed team funding period fixed and its end inclusive", () => {
    expect(fixedTeamBudgetPeriodAsOf(now)).toMatchObject({
      periodStart: "2026-05-20",
      periodEnd: "2027-05-20",
      asOf: "2026-09-05",
      reportingEndExclusive: "2026-09-06T00:00:00.000Z",
    });
    expect(fixedTeamBudgetPeriodAsOf(
      new Date("2028-09-05T12:00:00.000Z"),
    )).toMatchObject({
      periodStart: "2026-05-20",
      periodEnd: "2027-05-20",
      asOf: "2027-05-20",
      reportingEndExclusive: "2027-05-21T00:00:00.000Z",
    });
  });
});