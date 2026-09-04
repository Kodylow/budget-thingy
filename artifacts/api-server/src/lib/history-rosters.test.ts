// @ts-nocheck
import { test, expect } from "vitest";

import {
  buildRosterSnapshotRows,
  recordDailyRosters,
} from "./history.ts";
import {
  assertCompleteRosterDirectory,
} from "./enterprise.ts";

const groups = [
  { id: "g-2", workspaceId: "ws-1", name: "Beta", type: "custom" },
  { id: "g-1", workspaceId: "ws-1", name: "Alpha", type: "custom" },
];

class MemoryRosterStore {
  days = new Map();

  async capture(snapshotDate, rows) {
    if (this.days.has(snapshotDate)) return false;
    this.days.set(snapshotDate, structuredClone(rows));
    return true;
  }
}

test("roster rows use stable IDs with deterministic deduplication", () => {
  expect(buildRosterSnapshotRows(
      groups,
      new Map([["g-1", ["u-2", "u-1", "u-2"]]]),
      "2026-08-26",
    )).toEqual([
      {
        groupId: "g-1",
        snapshotDate: "2026-08-26",
        workspaceId: "ws-1",
        userIds: ["u-1", "u-2"],
      },
      {
        groupId: "g-2",
        snapshotDate: "2026-08-26",
        workspaceId: "ws-1",
        userIds: [],
      },
    ]);
});

test("repeat and restarted snapshot passes cannot rewrite an immutable day", async () => {
  const store = new MemoryRosterStore();
  const first = await recordDailyRosters(
    groups,
    new Map([["g-1", ["u-1"]]]),
    Date.parse("2026-08-26T01:00:00Z"),
    store,
  );
  const repeatedAfterRestart = await recordDailyRosters(
    groups,
    new Map([["g-1", ["u-2"]]]),
    Date.parse("2026-08-26T20:00:00Z"),
    store,
  );
  expect(first).toBe(true);
  expect(repeatedAfterRestart).toBe(false);
  expect(store.days.get("2026-08-26")[0].userIds).toEqual(["u-1"]);
});

test("a missed prior job is not guessed and the next reliable UTC day is captured", async () => {
  const store = new MemoryRosterStore();
  await recordDailyRosters(
    groups,
    new Map([["g-1", ["u-1"]]]),
    Date.parse("2026-08-26T12:00:00Z"),
    store,
  );
  expect(store.days.has("2026-08-25")).toBe(false);
  expect(store.days.has("2026-08-26")).toBe(true);
});

test("an incomplete group-members refresh is rejected instead of freezing an empty roster", () => {
  const incomplete = {
    fetchedAt: Date.now(),
    workspaces: new Map(),
    groups,
    allGroups: groups,
    groupMembers: new Map([["g-1", ["u-1"]]]),
    members: new Map(),
    budgets: {
      groupLimits: new Map(),
      userLimits: new Map(),
      workspaceDefaults: new Map(),
    },
  };
  expect(() => assertCompleteRosterDirectory(incomplete)).toThrow(/Roster directory refresh incomplete/);
});
