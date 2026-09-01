export interface ClusterMemberIdentity {
  userId: string;
}

export interface WorkspaceBudgetValue {
  userId: string;
  budgetUsd: number | null;
  usageUsd: number | null;
  remainingUsd: number | null;
}

/**
 * Joins one workspace-scoped budget observation onto each already-deduplicated
 * cluster member. Reporting-range data is deliberately not an input.
 */
export function indexMemberBudgets<T extends WorkspaceBudgetValue>(
  clusterMembers: ClusterMemberIdentity[],
  workspaceBudgets: T[],
): Map<string, T> {
  const visibleIds = new Set(clusterMembers.map((member) => member.userId));
  const result = new Map<string, T>();
  for (const budget of workspaceBudgets) {
    if (visibleIds.has(budget.userId) && !result.has(budget.userId)) {
      result.set(budget.userId, budget);
    }
  }
  return result;
}