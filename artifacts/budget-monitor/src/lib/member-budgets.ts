export interface ClusterMemberIdentity {
  userId: string;
}

export interface WorkspaceBudgetValue {
  userId: string;
  budgetUsd: number | null;
  usageUsd: number | null;
  remainingUsd: number | null;
}

export interface BulkBudgetOutcome {
  userId: string;
  success: boolean;
}

export function chunkMemberIds(userIds: string[], size = 100): string[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new TypeError('Chunk size must be a positive integer');
  }
  const chunks: string[][] = [];
  for (let index = 0; index < userIds.length; index += size) {
    chunks.push(userIds.slice(index, index + size));
  }
  return chunks;
}

export function failedBulkSelection(outcomes: BulkBudgetOutcome[]): Set<string> {
  return new Set(outcomes.filter((outcome) => !outcome.success).map((outcome) => outcome.userId));
}

export function toggleDisplayedSelection(
  current: ReadonlySet<string>,
  displayedIds: string[],
  selectAll: boolean,
): Set<string> {
  const next = new Set(current);
  for (const userId of displayedIds) {
    if (selectAll) next.add(userId);
    else next.delete(userId);
  }
  return next;
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