// @ts-nocheck
import { test, expect } from "vitest";

import {
  attributeHistoricalDay,
  mergeHistoricalGroupSpend,
  partitionTrendBucket,
} from "./historical-attribution.ts";

const alpha = { id: "g-alpha", workspaceId: "ws-1", name: "Alpha", type: "custom" };
const beta = { id: "g-beta", workspaceId: "ws-1", name: "Beta", type: "custom" };
const usage = new Map([
  ["ws-1", {
    byUser: new Map([["u-1", 12], ["u-deleted", 8]]),
    unattributableTotalCostUsd: 3,
  }],
]);

test("member additions and removals affect only roster dates after the change", () => {
  const before = attributeHistoricalDay(
    [alpha],
    new Map([[alpha.id, ["u-1"]]]),
    new Set(["ws-1"]),
    usage,
  );
  const afterRemoval = attributeHistoricalDay(
    [alpha],
    new Map([[alpha.id, []]]),
    new Set(["ws-1"]),
    usage,
  );
  const afterAddition = attributeHistoricalDay(
    [alpha],
    new Map([[alpha.id, ["u-deleted"]]]),
    new Set(["ws-1"]),
    usage,
  );

  expect(before.spendByGroup.get(alpha.id)).toBe(12);
  expect(afterRemoval.spendByGroup.get(alpha.id)).toBe(0);
  expect(afterAddition.spendByGroup.get(alpha.id)).toBe(8);
  expect(before.totalSpendUsd, "ungrouped users and no-user spend remain in totals").toBe(23);
});

test("deleted directory members remain attributable by stable roster user ID", () => {
  const result = attributeHistoricalDay(
    [alpha],
    new Map([[alpha.id, ["u-deleted"]]]),
    new Set(["ws-1"]),
    usage,
  );
  expect(result.spendByGroup.get(alpha.id)).toBe(8);
});

test("overlapping memberships are deduped by stable group ordering", () => {
  const result = attributeHistoricalDay(
    [beta, alpha],
    new Map([
      [alpha.id, ["u-1"]],
      [beta.id, ["u-1"]],
    ]),
    new Set(["ws-1"]),
    usage,
  );
  expect(result.spendByGroup.get(alpha.id)).toBe(12);
  expect(result.spendByGroup.get(beta.id)).toBe(0);
  expect(result.totalSpendUsd).toBe(23);
});

test("same-name migration aliases merge their historical source spend", () => {
  const merged = mergeHistoricalGroupSpend(
    ["g-primary"],
    new Map([["g-primary", ["g-primary", "g-alias"]]]),
    new Map([["g-primary", 5], ["g-alias", 7]]),
  );
  expect(merged.get("g-primary")).toBe(12);
});

test("only completed past roster days are split from live ranges", () => {
  expect(partitionTrendBucket(
      "2026-08-23",
      "2026-08-26",
      new Set(["2026-08-24", "2026-08-25", "2026-08-26"]),
      "2026-08-26",
    )).toEqual([
      { startDate: "2026-08-23", endDate: "2026-08-23", rosterDate: null },
      { startDate: "2026-08-24", endDate: "2026-08-24", rosterDate: "2026-08-24" },
      { startDate: "2026-08-25", endDate: "2026-08-25", rosterDate: "2026-08-25" },
      { startDate: "2026-08-26", endDate: "2026-08-26", rosterDate: null },
    ]);
});