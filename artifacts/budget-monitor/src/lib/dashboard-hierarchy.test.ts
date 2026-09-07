import { describe, expect, it } from "vitest";

import {
  dashboardPresentation,
  familyDisclosureId,
  initialExpandedWorkspaceIds,
  toggleDisclosure,
  workspaceDisclosureId,
} from "./dashboard-hierarchy";

describe("dashboard role presentation", () => {
  it.each([
    ["account", "workspace", "Account", "summary"],
    ["workspace_admin", "workspace", "Workspace", "summary"],
    ["team_admin", "family", "Family", "summary"],
    ["member", "family", "Individual", "individual"],
  ] as const)(
    "maps %s to its starting level and card scope",
    (role, startingLevel, scopeLabel, summarySource) => {
      expect(dashboardPresentation(role)).toEqual({
        startingLevel,
        scopeLabel,
        summarySource,
      });
    },
  );

  it("gives every account-scoped identity the same presentation", () => {
    const trueAccountAdmin = dashboardPresentation("account");
    const managedApplicationAdmin = dashboardPresentation("account");
    expect(managedApplicationAdmin).toEqual(trueAccountAdmin);
  });

  it("opens only server-authorized workspaces for workspace admins", () => {
    const authorized = [
      { workspaceId: "authorized-one" },
      { workspaceId: "authorized-two" },
    ];
    expect(
      [...initialExpandedWorkspaceIds("workspace_admin", authorized)],
    ).toEqual(["workspace:authorized-one", "workspace:authorized-two"]);
    expect([...initialExpandedWorkspaceIds("account", authorized)]).toEqual([]);
    expect([...initialExpandedWorkspaceIds("team_admin", authorized)]).toEqual(
      [],
    );
  });
});

describe("dashboard hierarchy identities and disclosure", () => {
  it("isolates same-named families across workspaces and legacy state", () => {
    expect(familyDisclosureId("one", "growth", false)).not.toBe(
      familyDisclosureId("two", "growth", false),
    );
    expect(familyDisclosureId("one", "growth", false)).not.toBe(
      familyDisclosureId("one", "growth", true),
    );
  });

  it("keeps unassigned family identities workspace-qualified", () => {
    expect(familyDisclosureId("one", "no-group", false)).not.toBe(
      familyDisclosureId("two", "no-group", false),
    );
  });

  it("uses stable workspace identities", () => {
    expect(workspaceDisclosureId("workspace-id")).toBe(
      "workspace:workspace-id",
    );
  });

  it("toggles without mutating the prior expansion state", () => {
    const before = new Set(["workspace:one"]);
    const opened = toggleDisclosure(before, "family:one:current:growth");
    const closed = toggleDisclosure(opened, "workspace:one");

    expect(before).toEqual(new Set(["workspace:one"]));
    expect(opened).toEqual(
      new Set(["workspace:one", "family:one:current:growth"]),
    );
    expect(closed).toEqual(new Set(["family:one:current:growth"]));
  });
});