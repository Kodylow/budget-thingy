import { describe, expect, test } from "vitest";
import { ExportSpendPeopleCsvQueryParams } from "@workspace/api-zod";
import type { Authorization } from "../lib/authz";
import type { SpendRow } from "../services/scoped-accounting";
import {
  currentCycleLimitMetrics,
  resolveAuthorizationForView,
} from "../services/scoped-accounting";
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
    canManageFundingMappings: false,
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
    usageObserved: true,
  };
}

const completeMetadata = {
  status: "complete",
  dataAsOf: "2026-01-02T03:04:05.000Z",
  stale: false,
  coverage: {
    ratio: 1,
    requestedDays: 2,
    missingDays: [] as string[],
    failedWorkspaceDays: [] as string[],
  },
  qualifications: ["Internal Replit usage is excluded from eligible spend."],
};

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
    const csv = serializeSpendCsv(selected, completeMetadata);
    expect(selected.map((item) => item.id)).toEqual([
      "person:w1:2",
      "person:w1:1",
    ]);
    expect(jsonTotal).toBe(10);
    expect(csv).toContain('"qualified_id"');
    expect(csv).toContain('"limit_observation_status"');
    expect(csv).toContain('"data_as_of"');
    expect(csv).toContain('"coverage_ratio"');
    expect(csv).toContain('"data_qualifications"');
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

  test("People remaining uses current-cycle consumption, not full-term spend", () => {
    const metrics = currentCycleLimitMetrics(250, 40);
    const fullTerm = {
      ...row("person:w1:1", "Alice", 900, "explicit"),
      allocationUsd: 250,
      agentSpendUsd: 900,
      remainingUsd: metrics.remainingUsd,
      percentUsed: metrics.percentUsed,
      currentCycleAgentSpendUsd: 40,
      currentCycleRemainingUsd: metrics.remainingUsd,
      currentCyclePercentUsed: metrics.percentUsed,
      limitState: "explicit" as const,
    };
    expect(metrics.remainingUsd).toBe(210);
    const csv = serializeSpendCsv([fullTerm], completeMetadata);
    expect(csv).toContain('"current_cycle_remaining_usd"');
    expect(csv).toContain('"current_cycle_agent_spend_usd"');
    expect(csv).toContain('"900","900","0","250","210","16","40","210","16"');
    expect(csv).not.toContain("-650");
  });

  test("CSV marks an unobserved row and blanks only selected-range spend", () => {
    const cold = {
      ...row("person:w1:1", "Alice", 900, "explicit"),
      usageObserved: false,
      allocationUsd: 250,
      remainingUsd: 210,
      percentUsed: 16,
      currentCycleAgentSpendUsd: 40,
      currentCycleRemainingUsd: 210,
      currentCyclePercentUsed: 16,
    };
    const [header, line] = serializeSpendCsv([cold], completeMetadata)
      .trim().split("\r\n").map((value) =>
        value.split(",").map((cell) => JSON.parse(cell) as string));
    const values = Object.fromEntries(header!.map((name, index) => [
      name, line![index],
    ]));
    expect(values).toMatchObject({
      usage_observed: "false",
      spend_usd: "",
      agent_spend_usd: "",
      other_services_usd: "",
      remaining_usd: "210",
      current_cycle_agent_spend_usd: "40",
      current_cycle_remaining_usd: "210",
      current_cycle_percent_used: "16",
    });
  });

  test("CSV rows carry source status, as-of, coverage, and qualifications", () => {
    const csv = serializeSpendCsv([row("person:w1:1", "Alice", 3, "no_limit")], {
      status: "partial",
      dataAsOf: "2026-01-02T03:04:05.000Z",
      stale: true,
      coverage: {
        ratio: 0.5,
        requestedDays: 2,
        missingDays: ["2026-01-01"],
        failedWorkspaceDays: ["w1:2026-01-02"],
      },
      qualifications: [
        "Partial usage coverage; missing facts are not zero.",
        "Project attribution is incomplete.",
      ],
    });
    expect(csv).toContain(
      '"partial","2026-01-02T03:04:05.000Z","true","0.5","2","2026-01-01","w1:2026-01-02"',
    );
    expect(csv).toContain(
      '"Partial usage coverage; missing facts are not zero. Project attribution is incomplete."',
    );
  });

  test("empty CSV includes a documented metadata record", () => {
    const csv = serializeSpendCsv([], {
      status: "empty",
      dataAsOf: null,
      stale: false,
      coverage: {
        ratio: 0,
        requestedDays: 2,
        missingDays: ["2026-01-01", "2026-01-02"],
        failedWorkspaceDays: [],
      },
      qualifications: [
        "No committed usage observations are available; missing facts are not zero.",
      ],
    });
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"export_metadata"');
    expect(lines[1]).toContain('"empty"');
    expect(lines[1]).toContain(
      '"No committed usage observations are available; missing facts are not zero."',
    );
  });
});