import { describe, expect, test } from "vitest";
import { ExportSpendPeopleCsvQueryParams } from "@workspace/api-zod";
import type { Authorization } from "../lib/authz";
import type { SpendRow } from "../services/scoped-accounting";
import { resolveAuthorizationForView } from "../services/scoped-accounting";
import {
  authorizeSpendView,
  filterAndSortSpendRows,
  pageSpendRows,
  serializeSpendCsv,
} from "./monitor.spend-tables";

const memberAuth: Authorization = {
  role: "member",
  roles: ["member"],
  userId: "self",
  workspaceIds: [],
  teamNames: [],
  groupIds: ["own-group"],
  managedGroupIds: [],
  groupUserIds: { "own-group": ["self"] },
  userIds: ["self"],
  isTrueAccountAdmin: false,
  capabilities: {
    canViewAccountUsage: false,
    canManageAccess: false,
    canEditAllocations: false,
    canManageNotifications: false,
    canManageSystem: false,
    canPreviewRoles: false,
    canWriteGroupLimits: false,
    canRunChecks: false,
    canSendTestEmail: false,
    canWriteUserLimitsIn: [],
  },
};

function row(id: string, name: string, spendUsd: number, status: string): SpendRow {
  return {
    id,
    kind: "person",
    name,
    workspaceId: "w1",
    workspaceName: "Workspace",
    spendUsd,
    agentSpendUsd: spendUsd,
    otherServicesUsd: 0,
    allocationUsd: null,
    remainingUsd: null,
    percentUsed: null,
    status,
    memberCount: null,
    ownerName: null,
    limitState: status === "inherited" ? "inherited" : "no_limit",
    limitObservationStatus: "complete",
    sharedPool: false,
  };
}

describe("Spend details CSV parity and authorization", () => {
  test("crafted scope cannot turn a member into a group or pool viewer", () => {
    expect(authorizeSpendView(memberAuth, "groups")).toBe(false);
    expect(authorizeSpendView(memberAuth, "pools")).toBe(false);
    expect(authorizeSpendView(memberAuth, "people")).toBe(true);
    expect(ExportSpendPeopleCsvQueryParams.safeParse({
      viewScope: "account_everything",
    }).success).toBe(false);
    const managed = resolveAuthorizationForView(
      memberAuth,
      "managed",
      new Map([["own-group", ["self"]]]),
    );
    expect(managed.groupIds).toEqual([]);
    expect(managed.userIds).toEqual([]);
  });

  test("CSV rows and totals use the exact JSON search/status/sort selection", () => {
    const rows = [
      row("person:w1:1", "Alice", 3, "inherited"),
      row("person:w1:2", "Alina", 7, "inherited"),
      { ...row("person:w2:3", "Alison", 20, "inherited"), workspaceId: "w2" },
      row("person:w1:4", "Bob", 20, "no_limit"),
    ];
    const selected = filterAndSortSpendRows(rows, {
      search: "ali",
      status: "inherited",
      workspaceId: "w1",
      sort: "spend_desc",
    });
    const jsonTotal = selected.reduce((sum, item) => sum + item.spendUsd, 0);
    const csv = serializeSpendCsv(selected);
    expect(selected.map((item) => item.id)).toEqual([
      "person:w1:2",
      "person:w1:1",
    ]);
    expect(jsonTotal).toBe(10);
    expect(csv).toContain('"qualified_id"');
    expect(csv).toContain('"limit_observation_status"');
    expect(csv).toContain('"person:w1:2"');
    expect(csv).toContain('"person:w1:1"');
    expect(csv).not.toContain('"person:w2:3"');
    expect(csv).not.toContain('"person:w1:4"');
    expect(csv.trim().split("\r\n")).toHaveLength(selected.length + 1);
  });

  test("paging is stable after server sorting and never changes the filtered total", () => {
    const selected = filterAndSortSpendRows([
      row("person:w1:1", "Charlie", 30, "no_limit"),
      row("person:w1:2", "Alice", 10, "no_limit"),
      row("person:w1:3", "Bob", 20, "no_limit"),
    ], { sort: "name_asc" });
    expect(pageSpendRows(selected, 2, 1).map((item) => item.name)).toEqual(["Bob"]);
    expect(selected.reduce((sum, item) => sum + item.spendUsd, 0)).toBe(60);
  });
});