import { describe, expect, test } from "vitest";
import type { SpendRow } from "../services/scoped-accounting";
import { projectPeopleRows } from "./monitor.spend-tables";

function membership(
  userId: string,
  workspaceId: string,
  spendUsd: number,
  overrides: Partial<SpendRow> = {},
): SpendRow {
  return {
    id: `person:${workspaceId}:${userId}`,
    userId,
    kind: "person",
    name: "Member",
    workspaceId,
    workspaceName: `Workspace ${workspaceId}`,
    spendUsd,
    agentSpendUsd: spendUsd,
    otherServicesUsd: 0,
    allocationUsd: 100,
    remainingUsd: 80,
    percentUsed: 20,
    currentCycleAgentSpendUsd: 20,
    currentCycleRemainingUsd: 80,
    currentCyclePercentUsed: 20,
    status: "explicit",
    memberCount: null,
    ownerName: null,
    limitState: "explicit",
    limitObservationStatus: "complete",
    sharedPool: false,
    usageObserved: true,
    ...overrides,
  };
}

describe("People spend presentation projection", () => {
  test("groups by stable user ID and keeps workspace-qualified facts", () => {
    const rows = projectPeopleRows([
      membership("user-1", "w1", 10),
      membership("user-1", "w2", 15, {
        allocationUsd: 200,
        remainingUsd: 170,
        percentUsed: 15,
        currentCycleAgentSpendUsd: 30,
      }),
      membership("user-2", "w1", 7, { name: "Member" }),
    ]);

    expect(rows).toHaveLength(2);
    const combined = rows.find((row) => row.userId === "user-1")!;
    expect(combined).toMatchObject({
      id: "person:user-1",
      workspaceId: null,
      spendUsd: 25,
      agentSpendUsd: 25,
      allocationUsd: null,
      remainingUsd: null,
      percentUsed: null,
      currentCycleAgentSpendUsd: 50,
      currentCycleRemainingUsd: null,
      currentCyclePercentUsed: null,
      status: "per_workspace",
      limitState: "not_applicable",
    });
    expect(combined.workspaces).toHaveLength(2);
    expect(combined.workspaces?.[1]).toMatchObject({
      workspaceId: "w2",
      allocationUsd: 200,
      currentCycleAgentSpendUsd: 30,
    });
    expect(rows.find((row) => row.userId === "user-2")?.id)
      .toBe("person:user-2");
  });

  test("does not merge equal names and makes incomplete current-cycle totals unknown", () => {
    const rows = projectPeopleRows([
      membership("alice-1", "w1", 4, { name: "Alice" }),
      membership("alice-2", "w1", 6, { name: "Alice" }),
      membership("alice-1", "w2", 8, {
        name: "Alice",
        currentCycleAgentSpendUsd: null,
        usageObserved: false,
      }),
    ]);

    expect(rows).toHaveLength(2);
    const alice = rows.find((row) => row.userId === "alice-1")!;
    expect(alice.currentCycleAgentSpendUsd).toBeNull();
    expect(alice.usageObserved).toBe(true);
  });

  test("single-workspace people retain their metrics and still expose membership", () => {
    const [row] = projectPeopleRows([
      membership("user-1", "w1", 10, {
        allocationUsd: null,
        remainingUsd: null,
        percentUsed: null,
        limitState: "no_limit",
      }),
    ]);

    expect(row).toMatchObject({
      id: "person:user-1",
      workspaceId: "w1",
      allocationUsd: null,
      limitState: "no_limit",
    });
    expect(row?.workspaces).toHaveLength(1);
  });
});