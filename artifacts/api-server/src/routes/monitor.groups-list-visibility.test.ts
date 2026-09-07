import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { shouldHideCanonicalDashboardGroup } from "./monitor.groups-list";

const hiddenTeams = new Set(["PREPROD"]);

describe("hidden-team dashboard row visibility", () => {
  test("hides only a trustworthy merged zero assigned to one hidden team", () => {
    expect(shouldHideCanonicalDashboardGroup({
      usageComplete: true,
      spendUsd: 0,
      effectiveTeamNames: new Set(["PREPROD"]),
      hiddenTeamNames: hiddenTeams,
    })).toBe(true);
  });

  test.each([
    ["positive spend", true, 0.01, new Set(["PREPROD"])],
    ["partial usage", false, 0, new Set(["PREPROD"])],
    ["ordinary unassigned group", true, 0, new Set<string>()],
    ["visible team", true, 0, new Set(["Finance"])],
    ["ambiguous merged assignment", true, 0, new Set(["PREPROD", "Finance"])],
  ])("keeps %s visible", (_label, usageComplete, spendUsd, effectiveTeamNames) => {
    expect(shouldHideCanonicalDashboardGroup({
      usageComplete,
      spendUsd,
      effectiveTeamNames,
      hiddenTeamNames: hiddenTeams,
    })).toBe(false);
  });

  test("keeps accounting inputs independent from row visibility", () => {
    const source = readFileSync(
      new URL("./monitor.groups-list.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/for \(const group of displayGroups\) \{/);
    expect(source).toMatch(/for \(const group of usage\.groups\) \{/);
    expect(source).not.toMatch(/for \(const group of visibleDisplayGroups\) \{/);
  });
});