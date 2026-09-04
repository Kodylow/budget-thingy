import { describe, expect, test } from "vitest";
import {
  buildCompletePlatformBudgets,
  buildFailedPlatformBudgets,
  deserializeDirectory,
  mergeCompletedBudgetsWithAcknowledgedWrites,
  serializeDirectory,
  type SerializedDirectory,
} from "./enterprise";
import { resolveStoredMemberLimit } from "../services/scoped-accounting";

function serialized(
  budgets: SerializedDirectory["budgets"],
): SerializedDirectory {
  return {
    fetchedAt: Date.parse("2026-09-04T12:00:00.000Z"),
    workspaces: {
      w1: { id: "w1", name: "One", slug: "one", memberCount: 2 },
    },
    groups: [],
    allGroups: [],
    groupMembers: {},
    members: {},
    budgets,
  };
}

describe("persisted member-limit observations", () => {
  test("preserves an explicit zero instead of treating it as missing", () => {
    const directory = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: { w1: { zero: 0 } },
      workspaceDefaults: { w1: 25 },
      observation: {
        status: "complete",
        observedAt: Date.parse("2026-09-04T11:59:00.000Z"),
        error: null,
      },
    }));
    expect(resolveStoredMemberLimit(directory, "w1", "zero")).toEqual({
      amount: 0,
      state: "explicit",
    });
    expect(serializeDirectory(directory).budgets.observation?.status).toBe("complete");
  });

  test("distinguishes inherited defaults from an observed no-limit result", () => {
    const withDefault = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: {},
      workspaceDefaults: { w1: 30 },
      observation: { status: "complete", observedAt: 1, error: null },
    }));
    expect(resolveStoredMemberLimit(withDefault, "w1", "member")).toEqual({
      amount: 30,
      state: "inherited",
    });
    const withoutDefault = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: {},
      workspaceDefaults: {},
      observation: { status: "complete", observedAt: 1, error: null },
    }));
    expect(resolveStoredMemberLimit(withoutDefault, "w1", "member")).toEqual({
      amount: null,
      state: "no_limit",
    });
  });

  test("old snapshots are unavailable and failed observations survive restart", () => {
    const legacy = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: {},
      workspaceDefaults: {},
    }));
    expect(legacy.budgets.observation.status).toBe("unavailable");
    expect(resolveStoredMemberLimit(legacy, "w1", "member").state).toBe("unavailable");

    const failed = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: {},
      workspaceDefaults: {},
      observation: { status: "failed", observedAt: 2, error: "upstream timeout" },
    }));
    const replayed = deserializeDirectory(serializeDirectory(failed));
    expect(replayed.budgets.observation).toEqual({
      status: "failed",
      observedAt: 2,
      lastSuccessfulAt: null,
      lastAttemptAt: 2,
      refreshStartedAt: null,
      generation: null,
      error: "upstream timeout",
    });
    expect(resolveStoredMemberLimit(replayed, "w1", "member").state).toBe("unavailable");
  });

  test("retains the last successful values and generation through a transient failure", () => {
    const failed = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: { w1: { member: 18 } },
      workspaceDefaults: { w1: 30 },
      observation: {
        status: "failed",
        observedAt: 20,
        lastSuccessfulAt: 10,
        lastAttemptAt: 20,
        refreshStartedAt: null,
        generation: "limits-generation-one",
        error: "temporary outage",
      },
    }));
    expect(resolveStoredMemberLimit(failed, "w1", "member")).toEqual({
      amount: 18,
      state: "explicit",
    });
    expect(resolveStoredMemberLimit(failed, "w1", "other")).toEqual({
      amount: 30,
      state: "inherited",
    });
    expect(serializeDirectory(failed).budgets.observation).toMatchObject({
      status: "failed",
      lastSuccessfulAt: 10,
      generation: "limits-generation-one",
      error: "temporary outage",
    });
  });

  test("hydrates an interrupted refresh as failed without discarding known values", () => {
    const interrupted = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: {},
      workspaceDefaults: { w1: 44 },
      observation: {
        status: "refreshing",
        observedAt: 20,
        lastSuccessfulAt: 10,
        lastAttemptAt: 20,
        refreshStartedAt: 20,
        generation: "limits-generation-one",
        error: null,
      },
    }));
    expect(interrupted.budgets.observation).toMatchObject({
      status: "failed",
      lastSuccessfulAt: 10,
      refreshStartedAt: null,
      generation: "limits-generation-one",
    });
    expect(interrupted.budgets.observation.error).toContain("interrupted");
    expect(resolveStoredMemberLimit(interrupted, "w1", "member")).toEqual({
      amount: 44,
      state: "inherited",
    });
  });

  test("treats a successful empty generation as authoritative no-limit", () => {
    const empty = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: {},
      workspaceDefaults: {},
      observation: {
        status: "complete",
        observedAt: 30,
        lastSuccessfulAt: 30,
        lastAttemptAt: 30,
        refreshStartedAt: null,
        generation: "empty-generation",
        error: null,
      },
    }));
    expect(resolveStoredMemberLimit(empty, "w1", "member")).toEqual({
      amount: null,
      state: "no_limit",
    });
  });

  test("uses the changed workspace default from the persisted generation", () => {
    const changed = deserializeDirectory(serialized({
      groupLimits: {},
      userLimits: {},
      workspaceDefaults: { w1: 55 },
      observation: {
        status: "complete",
        observedAt: 40,
        lastSuccessfulAt: 40,
        lastAttemptAt: 40,
        refreshStartedAt: null,
        generation: "changed-default-generation",
        error: null,
      },
    }));
    const replayed = deserializeDirectory(serializeDirectory(changed));
    expect(resolveStoredMemberLimit(replayed, "w1", "member")).toEqual({
      amount: 55,
      state: "inherited",
    });
    expect(replayed.budgets.observation.generation)
      .toBe("changed-default-generation");
  });

  test("first complete observation records explicit limits, defaults, time, and generation", () => {
    const first = buildCompletePlatformBudgets([
      {
        type: "workspace_user_limit",
        workspaceId: "w1",
        userId: "member",
        amountUsd: 12,
      },
      {
        type: "workspace_default_user_limit",
        workspaceId: "w1",
        amountUsd: 24,
      },
    ], 100);
    expect(first.userLimits.get("w1")?.get("member")).toBe(12);
    expect(first.workspaceDefaults.get("w1")).toBe(24);
    expect(first.observation).toMatchObject({
      status: "complete",
      observedAt: 100,
      lastSuccessfulAt: 100,
      lastAttemptAt: 100,
      refreshStartedAt: null,
      error: null,
    });
    expect(first.observation.generation).toMatch(/^[a-f0-9]{24}$/);
  });

  test("failed refresh retains the prior authorized map while a later empty success replaces it", () => {
    const first = buildCompletePlatformBudgets([
      {
        type: "workspace_user_limit",
        workspaceId: "w1",
        userId: "member",
        amountUsd: 12,
      },
    ], 100);
    const failed = buildFailedPlatformBudgets(first, new Error("timeout"), 200);
    expect(failed.userLimits.get("w1")?.get("member")).toBe(12);
    expect(failed.observation).toMatchObject({
      status: "failed",
      lastSuccessfulAt: 100,
      lastAttemptAt: 200,
      generation: first.observation.generation,
      error: "timeout",
    });

    const empty = buildCompletePlatformBudgets([], 300);
    expect(empty.userLimits.size).toBe(0);
    expect(empty.workspaceDefaults.size).toBe(0);
    expect(empty.observation.status).toBe("complete");
    expect(empty.observation.generation).not.toBe(first.observation.generation);
  });

  test("acknowledged writes racing a refresh are overlaid on its terminal generation", () => {
    const completed = buildCompletePlatformBudgets([], 500);
    const merged = mergeCompletedBudgetsWithAcknowledgedWrites(completed, [
      {
        type: "workspace_user_limit",
        workspaceId: "w1",
        userId: "member",
        amountUsd: 19,
      },
      {
        type: "workspace_default_user_limit",
        workspaceId: "w1",
        amountUsd: 38,
      },
    ]);
    expect(merged.userLimits.get("w1")?.get("member")).toBe(19);
    expect(merged.workspaceDefaults.get("w1")).toBe(38);
    expect(merged.observation).toMatchObject({
      status: "complete",
      lastSuccessfulAt: 500,
      refreshStartedAt: null,
      error: null,
    });
    expect(merged.observation.generation).not.toBe(
      completed.observation.generation,
    );
  });
});