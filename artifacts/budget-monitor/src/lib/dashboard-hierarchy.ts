export type DashboardRole =
  | "account"
  | "workspace_admin"
  | "team_admin"
  | "member"
  | "denied"
  | null;

export interface DashboardPresentation {
  startingLevel: "workspace" | "family";
  scopeLabel: "Account" | "Workspace" | "Family" | "Individual";
  summarySource: "summary" | "individual";
}

export interface HierarchyWorkspace {
  workspaceId: string;
}

export function dashboardPresentation(
  role: DashboardRole,
): DashboardPresentation {
  switch (role) {
    case "account":
      return {
        startingLevel: "workspace",
        scopeLabel: "Account",
        summarySource: "summary",
      };
    case "workspace_admin":
      return {
        startingLevel: "workspace",
        scopeLabel: "Workspace",
        summarySource: "summary",
      };
    case "team_admin":
      return {
        startingLevel: "family",
        scopeLabel: "Family",
        summarySource: "summary",
      };
    case "member":
      return {
        startingLevel: "family",
        scopeLabel: "Individual",
        summarySource: "individual",
      };
    default:
      return {
        startingLevel: "workspace",
        scopeLabel: "Individual",
        summarySource: "summary",
      };
  }
}

export function initialExpandedWorkspaceIds(
  role: DashboardRole,
  workspaces: HierarchyWorkspace[],
): Set<string> {
  if (role !== "workspace_admin") return new Set();
  return new Set(
    workspaces.map((workspace) => workspaceDisclosureId(workspace.workspaceId)),
  );
}

export function workspaceDisclosureId(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function familyDisclosureId(
  workspaceId: string,
  familyKey: string,
  isLegacy: boolean,
): string {
  return `family:${workspaceId}:${isLegacy ? "legacy" : "current"}:${familyKey}`;
}

export function toggleDisclosure(
  expanded: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}