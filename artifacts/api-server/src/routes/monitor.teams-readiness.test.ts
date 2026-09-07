import { describe, expect, test } from "vitest";
import type { UsageCoverage } from "../lib/usage-store";
import {
  isTeamCycleAgentUsageComplete,
  qualifyTeamAgentMetrics,
} from "./monitor.teams";

const completeCoverage: UsageCoverage = {
  requestedDays: 1,
  requestedWorkspaceDays: 2,
  presentWorkspaceDays: 2,
  failedWorkspaceDays: [],
  missingWorkspaceDays: [],
  presentAccountDays: 0,
  missingAccountDays: ["2026-09-05"],
  ratio: 2 / 3,
};

describe("team Agent metric readiness", () => {
  test("ignores unrelated account and workspace gaps", () => {
    expect(isTeamCycleAgentUsageComplete({
      coverage: {
        ...completeCoverage,
        missingWorkspaceDays: [{ workspaceId: "unrelated", usageDate: "2026-09-05" }],
      },
      members: new Map([["w1", new Map([["u1", {
        totalCostUsd: 4,
        aiCostUsd: 4,
        agentMetricsComplete: true,
      }]])]]),
    }, new Set(["w1"]), ["g1"], new Map([["g1", new Map([["u1", 4]])]])))
      .toBe(true);
  });

  test("rejects contributing workspace gaps and incomplete member decompositions", () => {
    expect(isTeamCycleAgentUsageComplete({
      coverage: {
        ...completeCoverage,
        failedWorkspaceDays: [{ workspaceId: "w1", usageDate: "2026-09-05" }],
      },
      members: new Map(),
    }, new Set(["w1"]), [], new Map())).toBe(false);

    expect(isTeamCycleAgentUsageComplete({
      coverage: completeCoverage,
      members: new Map([["w1", new Map([["u1", {
        totalCostUsd: 4,
        aiCostUsd: 4,
        agentMetricsComplete: false,
      }]])]]),
    }, new Set(["w1"]), ["g1"], new Map([["g1", new Map([["u1", 4]])]])))
      .toBe(false);
  });

  test("nulls all usage-derived fields when incomplete", () => {
    expect(qualifyTeamAgentMetrics(25, 100, false)).toEqual({
      cycleAgentSpendUsd: null,
      agentRemainingUsd: null,
      agentPercentUsed: null,
      agentBlocked: null,
    });
  });

  test("keeps known spend independent while distinguishing no verified limit", () => {
    expect(qualifyTeamAgentMetrics(25, null, true)).toEqual({
      cycleAgentSpendUsd: 25,
      agentRemainingUsd: null,
      agentPercentUsed: null,
      agentBlocked: null,
    });
    expect(qualifyTeamAgentMetrics(25, 100, true)).toEqual({
      cycleAgentSpendUsd: 25,
      agentRemainingUsd: 75,
      agentPercentUsed: 25,
      agentBlocked: false,
    });
  });
});