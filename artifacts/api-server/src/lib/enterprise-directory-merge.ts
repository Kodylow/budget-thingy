import type { EnterpriseGroup, EnterpriseWorkspace } from "./enterprise-directory";

export interface CanonicalGroupMergePlan {
  mergeMap: Map<string, string[]>;
  hiddenGroupIds: Set<string>;
  primaryByGroupId: Map<string, string>;
}

export interface CanonicalMergedGroupBudget {
  amountUsd: number;
  sourceGroupId: string;
}

export function resolveCanonicalMergedGroupBudget(
  primaryGroupId: string,
  mergePlan: CanonicalGroupMergePlan,
  budgetByGroupId: ReadonlyMap<string, number>,
): CanonicalMergedGroupBudget | null {
  const primaryAmount = budgetByGroupId.get(primaryGroupId);
  if (primaryAmount != null) {
    return { amountUsd: primaryAmount, sourceGroupId: primaryGroupId };
  }
  const alias = (mergePlan.mergeMap.get(primaryGroupId) ?? [])
    .filter((id) => id !== primaryGroupId && budgetByGroupId.has(id))
    .sort()[0];
  return alias ? { amountUsd: budgetByGroupId.get(alias)!, sourceGroupId: alias } : null;
}

export function buildCanonicalGroupMergePlan(
  groups: readonly EnterpriseGroup[],
  workspaces: ReadonlyMap<string, Pick<EnterpriseWorkspace, "name">>,
  teamByGroupIdentity?: ReadonlyMap<string, string>,
): CanonicalGroupMergePlan {
  const byName = new Map<string, EnterpriseGroup[]>();
  for (const group of groups) {
    const key = group.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), group]);
  }
  const mergeMap = new Map<string, string[]>();
  const hiddenGroupIds = new Set<string>();
  const primaryByGroupId = new Map<string, string>();
  for (const matches of byName.values()) {
    const mappedTeams = new Set(
      matches
        .map((group) => teamByGroupIdentity?.get(`${group.workspaceId}\0${group.id}`))
        .filter((team): team is string => !!team),
    );
    if (mappedTeams.size > 1) {
      for (const group of matches) {
        mergeMap.set(group.id, [group.id]);
        primaryByGroupId.set(group.id, group.id);
      }
      continue;
    }
    const body = matches[0]!.name
      .replace(/^az-replit\s*[-–]\s*/i, "")
      .toLowerCase()
      .trim();
    const matched = matches.find((group) => {
      const workspaceName = (workspaces.get(group.workspaceId)?.name ?? "")
        .trim()
        .toLowerCase();
      const firstToken = workspaceName.split(/[-\s]+/)[0] ?? "";
      return firstToken.length >= 2 && body.startsWith(firstToken);
    });
    const primary = matched ?? matches.slice().sort((a, b) => {
      const aName = workspaces.get(a.workspaceId)?.name ?? "";
      const bName = workspaces.get(b.workspaceId)?.name ?? "";
      return aName.localeCompare(bName) || a.id.localeCompare(b.id);
    })[0]!;
    mergeMap.set(primary.id, matches.map((group) => group.id));
    for (const group of matches) {
      primaryByGroupId.set(group.id, primary.id);
      if (group.id !== primary.id) hiddenGroupIds.add(group.id);
    }
  }
  return { mergeMap, hiddenGroupIds, primaryByGroupId };
}