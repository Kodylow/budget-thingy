import { describe, expect, test } from "vitest";
import {
  assertExplicitIntervalMatches,
  assertIntervalMatches,
  validateUsagePayload,
} from "./ingest-validation";

const completeZeroPage = {
  totalCostUsd: 0,
  attributableTotalCostUsd: 0,
  unattributableTotalCostUsd: 0,
  metrics: [],
  groups: [],
  pagination: { hasMore: false, nextCursor: null },
};

describe("usage acquisition validation", () => {
  test("accepts an explicit authoritative zero grouped page", () => {
    expect(validateUsagePayload(completeZeroPage, "member")).toMatchObject({
      totalCostUsd: 0,
      attributableTotalCostUsd: 0,
      unattributableTotalCostUsd: 0,
      groups: [],
    });
  });

  test.each([
    [{ ...completeZeroPage, totalCostUsd: undefined }, "totalCostUsd"],
    [{ ...completeZeroPage, totalCostUsd: "0" }, "totalCostUsd"],
    [{ ...completeZeroPage, totalCostUsd: Number.NaN }, "totalCostUsd"],
    [{ ...completeZeroPage, groups: undefined }, "groups"],
    [{ ...completeZeroPage, pagination: { hasMore: true } }, "cursor"],
    [{
      ...completeZeroPage,
      groups: [{ key: {}, totalCostUsd: 0, metrics: [] }],
    }, "userId"],
    [{
      ...completeZeroPage,
      groups: [{
        key: { userId: "user" },
        totalCostUsd: 0,
        metrics: [{ id: "metric", name: "Metric", category: "usage", costUsd: Infinity }],
      }],
    }, "costUsd"],
  ])("rejects malformed grouped responses without coercion", (payload, message) => {
    expect(() => validateUsagePayload(payload, "member")).toThrow(message);
  });

  test("rejects provider intervals outside the requested bounds", () => {
    const payload = validateUsagePayload({
      totalCostUsd: 0,
      interval: {
        startTime: "2026-08-02T00:00:00.000Z",
        endTime: "2026-08-03T00:00:00.000Z",
      },
    });
    expect(() => assertIntervalMatches(
      payload,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    )).toThrow("outside the requested bounds");
  });

  test("requires every grouped page to state its interval explicitly", () => {
    const payload = validateUsagePayload(completeZeroPage, "member");
    expect(() => assertExplicitIntervalMatches(
      payload,
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    )).toThrow("omitted its requested interval");
  });
});