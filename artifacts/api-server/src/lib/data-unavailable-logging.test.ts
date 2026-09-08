import { describe, expect, it } from "vitest";
import { inspectUnavailableData } from "./data-unavailable-logging";
import { dataUnavailableLogging } from "./data-unavailable-logging";

describe("unavailable financial data diagnostics", () => {
  it("keeps dashboard locations readable and respects personal-limit state", () => {
    const noLimit = {
      state: "no_limit",
      amount: null,
      currentCycleAgentSpendUsd: 0,
      currentCycleRemainingUsd: null,
      currentCyclePercentUsed: null,
    };
    expect(inspectUnavailableData({ personalLimits: [noLimit] }).count).toBe(0);
    const diagnostic = inspectUnavailableData({
      personalLimits: [{ state: "unavailable", amount: null }],
      projection: { rate: { twentyEightDayDailySpendUsd: null } },
      insights: { monthly: [{ spendUsd: null }] },
    });
    expect(diagnostic.sites).toEqual(expect.arrayContaining([
      { path: "body.personalLimits[].amount", reason: "explicit_unavailable", count: 1 },
      { path: "body.projection.rate.twentyEightDayDailySpendUsd", reason: "missing_value", count: 1 },
      { path: "body.insights.monthly[].spendUsd", reason: "missing_value", count: 1 },
    ]));
  });

  it("aggregates nested rows without recording dynamic keys or values", () => {
    const body = {
      teams: [
        { privateTeamId: "secret-a", members: [
          { email: "person@example.test", spendUsd: null, usageObserved: false },
          { email: "other@example.test", spendUsd: null, usageObserved: false },
        ] },
      ],
    };
    expect(inspectUnavailableData(body)).toEqual({
      count: 2,
      sites: [{
        path: "body.teams[].members[].spendUsd",
        reason: "no_usage_observed",
        count: 2,
      }],
      truncated: false,
    });
    expect(JSON.stringify(inspectUnavailableData(body))).not.toContain("secret");
    expect(JSON.stringify(inspectUnavailableData(body))).not.toContain("example.test");
  });

  it("does not mistake zero, no-limit denominators, or loading for failures", () => {
    expect(inspectUnavailableData({
      spendUsd: 0,
      remainingUsd: null,
      allocationUsd: null,
      noLimit: true,
      status: "loading",
    }).count).toBe(0);
  });

  it("still identifies missing no-limit current-cycle usage", () => {
    expect(inspectUnavailableData({
      currentCycleUsage: null,
      remainingUsd: null,
      limitState: "no_limit",
    }).sites).toEqual([{
      path: "body.currentCycleUsage",
      reason: "missing_value",
      count: 1,
    }]);
  });

  it("checks every no-limit marker and does not excuse allocation", () => {
    const diagnostic = inspectUnavailableData({
      limitObservationStatus: "complete",
      limitState: "no_limit",
      remainingUsd: null,
      allocationUsd: null,
      currentCycleUsage: null,
    });
    expect(diagnostic.sites).toEqual(expect.arrayContaining([
      { path: "body.allocationUsd", reason: "missing_allocation", count: 1 },
      { path: "body.currentCycleUsage", reason: "missing_value", count: 1 },
    ]));
    expect(diagnostic.sites.some((site) => site.path.endsWith("remainingUsd"))).toBe(false);
  });

  it("classifies explicit errors and limit observation states", () => {
    const diagnostic = inspectUnavailableData({
      error: "Spend details unavailable for a sensitive provider reason",
      result: { limitObservationStatus: "unavailable" },
    });
    expect(diagnostic.sites).toEqual(expect.arrayContaining([
      { path: "body.error", reason: "explicit_unavailable", count: 1 },
      {
        path: "body.result.limitObservationStatus",
        reason: "limit_observation_unavailable",
        count: 1,
      },
    ]));
    expect(JSON.stringify(diagnostic)).not.toContain("provider");
  });

  it("handles cycles and getters without invoking or mutating them", () => {
    let invoked = false;
    const body: Record<string, unknown> = { spendUsd: 10 };
    Object.defineProperty(body, "remainingUsd", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    body["self"] = body;
    expect(() => inspectUnavailableData(body)).not.toThrow();
    expect(invoked).toBe(false);
    expect(body["spendUsd"]).toBe(10);
  });

  it("recognizes authored enum locations, qualification arrays, and roots", () => {
    expect(inspectUnavailableData({
      limitState: "unavailable",
      qualifications: ["unavailable", "ok"],
    }).sites).toEqual(expect.arrayContaining([
      { path: "body.limitState", reason: "limit_observation_unavailable", count: 1 },
      { path: "body.qualifications[]", reason: "explicit_unavailable", count: 1 },
    ]));
    expect(inspectUnavailableData("Service unavailable").sites).toEqual([
      { path: "body", reason: "explicit_unavailable", count: 1 },
    ]);
  });

  it("uses card metadata and records known completeness flags", () => {
    const diagnostic = inspectUnavailableData({
      headline: {
        cards: [
          { key: "spend", unit: "usd", value: null },
          { key: "identity", value: null },
          {
            key: "monthly_agent_limit",
            unit: "usd",
            value: null,
            qualification: "No Agent limit is configured for this workspace.",
          },
        ],
      },
      budgetTracking: {
        isComplete: false,
        dataAvailable: false,
        comparisonsMatchBudgetWindow: false,
      },
    });
    expect(diagnostic.sites).toEqual(expect.arrayContaining([
      { path: "body.headline.cards[].value", reason: "missing_value", count: 1 },
      { path: "body.budgetTracking.isComplete", reason: "incomplete_usage", count: 1 },
      { path: "body.budgetTracking.dataAvailable", reason: "explicit_unavailable", count: 1 },
      {
        path: "body.budgetTracking.comparisonsMatchBudgetWindow",
        reason: "period_mismatch",
        count: 1,
      },
    ]));
    expect(diagnostic.sites.filter((site) =>
      site.path === "body.headline.cards[].value")).toHaveLength(1);
  });

  it("bounds deeply nested input and reports truncation", () => {
    let body: Record<string, unknown> = {};
    const root = body;
    for (let index = 0; index < 30; index++) {
      body["dynamic-sensitive-key"] = {};
      body = body["dynamic-sensitive-key"] as Record<string, unknown>;
    }
    const diagnostic = inspectUnavailableData(root);
    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.sites).toContainEqual({
      path: "body",
      reason: "scan_truncated",
      count: 1,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("dynamic-sensitive-key");
  });

  it("bounds enqueueing for large arrays and never invokes array getters", () => {
    let invoked = false;
    const body = new Array<unknown>(20_000).fill(null);
    Object.defineProperty(body, "0", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    const diagnostic = inspectUnavailableData(body);
    expect(invoked).toBe(false);
    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.sites).toContainEqual({
      path: "body",
      reason: "scan_truncated",
      count: 1,
    });
  });
});

describe("data unavailable response interception", () => {
  function harness(loggerThrows = false, contentType?: string) {
    const warnings: unknown[][] = [];
    const headers = new Map<string, unknown>();
    const sent: unknown[] = [];
    const req = {
      id: "request-correlation-id",
      originalUrl: "/api/groups/private-id",
      method: "GET",
      log: { warn: (...args: unknown[]) => {
        if (loggerThrows) throw new Error("logger failed");
        warnings.push(args);
      } },
    };
    const res: Record<string, unknown> = {
      statusCode: 503,
      setHeader: (name: string, value: unknown) => headers.set(name, value),
      getHeader: (name: string) => headers.get(name),
      send(body: unknown) {
        sent.push(body);
        return res;
      },
      json(body: unknown) {
        return (res["send"] as (body: unknown) => unknown)(body);
      },
    };
    if (contentType) headers.set("content-type", contentType);
    dataUnavailableLogging(() => "/api/groups/[redacted]")(
      req as never, res as never, () => undefined,
    );
    return { req, res, warnings, headers, sent };
  }

  it("preserves JSON body/status and logs json-to-send only once", () => {
    const test = harness();
    const body = { error: "Financial details unavailable" };
    (test.res["json"] as (body: unknown) => unknown)(body);
    expect(test.sent).toEqual([body]);
    expect(test.res["statusCode"]).toBe(503);
    expect(test.warnings).toHaveLength(1);
    expect(test.warnings[0]?.[0]).toMatchObject({
      requestId: test.req.id,
      endpoint: "/api/groups/[redacted]",
      status: 503,
      count: 1,
    });
    expect(JSON.parse(String(test.headers.get("x-data-unavailable")))).toMatchObject({
      count: 1,
      truncated: false,
    });
  });

  it("logs repeated equivalent responses once per request, not globally", () => {
    const first = harness();
    const second = harness();
    (first.res["send"] as (body: unknown) => unknown)("service unavailable");
    (first.res["send"] as (body: unknown) => unknown)("service unavailable");
    (second.res["send"] as (body: unknown) => unknown)("service unavailable");
    expect(first.warnings).toHaveLength(1);
    expect(second.warnings).toHaveLength(1);
  });

  it("cannot break the response when the request logger throws", () => {
    const test = harness(true);
    const body = { error: "Financial details unavailable" };
    expect(() =>
      (test.res["json"] as (body: unknown) => unknown)(body)).not.toThrow();
    expect(test.sent).toEqual([body]);
    expect(test.res["statusCode"]).toBe(503);
  });

  it("walks cached pre-serialized JSON and preserves its original bytes", () => {
    const test = harness(false, "application/json; charset=utf-8");
    test.res["statusCode"] = 200;
    const body = JSON.stringify({
      headline: {
        cards: [{ key: "spend", unit: "usd", value: null }],
      },
      hierarchy: {
        sourceGroups: [{ annualAllocationUsd: null }],
      },
      budgetTracking: { dataAvailable: false },
    });
    (test.res["send"] as (body: unknown) => unknown)(body);
    expect(test.sent).toEqual([body]);
    expect(test.res["statusCode"]).toBe(200);
    expect(test.warnings).toHaveLength(1);
    expect(test.warnings[0]?.[0]).toMatchObject({
      sites: expect.arrayContaining([
        {
          path: "body.headline.cards[].value",
          reason: "missing_value",
          count: 1,
        },
        {
          path: "body.hierarchy.sourceGroups[].annualAllocationUsd",
          reason: "missing_allocation",
          count: 1,
        },
      ]),
    });
  });

  it("falls back safely for malformed and oversized serialized JSON", () => {
    const malformed = harness(false, "application/problem+json");
    const malformedBody = '{"error":"service unavailable"';
    expect(() =>
      (malformed.res["send"] as (body: unknown) => unknown)(malformedBody),
    ).not.toThrow();
    expect(malformed.sent).toEqual([malformedBody]);
    expect(malformed.warnings).toHaveLength(1);

    const oversized = harness(false, "application/json");
    const oversizedBody = `{"error":"unavailable","padding":"${"x".repeat(256_001)}"}`;
    (oversized.res["send"] as (body: unknown) => unknown)(oversizedBody);
    expect(oversized.sent).toEqual([oversizedBody]);
    expect(oversized.warnings[0]?.[0]).toMatchObject({ truncated: true });
    expect(JSON.parse(String(
      oversized.headers.get("x-data-unavailable"),
    )).truncated).toBe(true);
  });

  it("keeps serialized JSON responses intact when logging throws", () => {
    const test = harness(true, "application/json");
    const body = '{"error":"service unavailable"}';
    expect(() =>
      (test.res["send"] as (body: unknown) => unknown)(body)).not.toThrow();
    expect(test.sent).toEqual([body]);
    expect(test.res["statusCode"]).toBe(503);
  });
});