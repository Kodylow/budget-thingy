import { describe, expect, test } from "vitest";
import {
  hasCompleteRequestedWorkspaceAgentUsage,
  resolveLimitMemberAgentUsage,
} from "./set-limits";
import type { UsageCoverage } from "../lib/usage-store";

function coverage(overrides: Partial<UsageCoverage> = {}): UsageCoverage {
  return {
    requestedDays: 2,
    requestedWorkspaceDays: 2,
    presentWorkspaceDays: 2,
    failedWorkspaceDays: [],
    missingWorkspaceDays: [],
    presentAccountDays: 0,
    missingAccountDays: ["2026-09-01", "2026-09-02"],
    ratio: 0.5,
    ...overrides,
  };
}

describe("Limits metric-specific usage readiness", () => {
  test("does not let missing account anchors suppress complete requested workspace usage", () => {
    expect(hasCompleteRequestedWorkspaceAgentUsage({ coverage: coverage() })).toBe(true);
  });

  test("rejects missing and failed days in the requested workspace", () => {
    expect(hasCompleteRequestedWorkspaceAgentUsage({
      coverage: coverage({
        presentWorkspaceDays: 1,
        missingWorkspaceDays: [{ workspaceId: "w1", usageDate: "2026-09-02" }],
      }),
    })).toBe(false);
    expect(hasCompleteRequestedWorkspaceAgentUsage({
      coverage: coverage({
        presentWorkspaceDays: 1,
        failedWorkspaceDays: [{ workspaceId: "w1", usageDate: "2026-09-02" }],
      }),
    })).toBe(false);
  });

  test("respects stored member Agent metric completeness", () => {
    expect(resolveLimitMemberAgentUsage({
      totalCostUsd: 9,
      aiCostUsd: 7,
      agentMetricsComplete: false,
    }, true)).toBeNull();
    expect(resolveLimitMemberAgentUsage({
      totalCostUsd: 9,
      aiCostUsd: 7,
      agentMetricsComplete: true,
    }, true)).toBe(7);
  });

  test("only treats an absent member row as zero under complete workspace coverage", () => {
    expect(resolveLimitMemberAgentUsage(undefined, true)).toBe(0);
    expect(resolveLimitMemberAgentUsage(undefined, false)).toBeNull();
  });
});