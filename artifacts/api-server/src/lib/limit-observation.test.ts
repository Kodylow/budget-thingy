import { describe, expect, test } from "vitest";
import {
  deserializeDirectory,
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
      error: "upstream timeout",
    });
    expect(resolveStoredMemberLimit(replayed, "w1", "member").state).toBe("unavailable");
  });
});