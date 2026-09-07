export interface WorkspaceTeamSpendLike {
  workspaceId: string;
  teamName: string;
  spendUsd: number;
}

export function workspaceTeamSpendKey(workspaceId: string, teamName: string): string {
  return `${workspaceId}::${teamName}`;
}

export function indexWorkspaceTeamSpend(
  rows: readonly WorkspaceTeamSpendLike[],
): ReadonlyMap<string, number> {
  return new Map(
    rows.map((row) => [workspaceTeamSpendKey(row.workspaceId, row.teamName), row.spendUsd]),
  );
}

export function totalWorkspaceSpend(
  rows: readonly WorkspaceTeamSpendLike[],
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.workspaceId, (totals.get(row.workspaceId) ?? 0) + row.spendUsd);
  }
  return totals;
}

export interface WorkspaceTeamBudgetAllocation {
  budgetUsd: number;
  isShared: boolean;
  method: 'full' | 'proportional' | 'equal';
}

export function allocateWorkspaceTeamBudgets(
  rows: readonly WorkspaceTeamSpendLike[],
  budgets: ReadonlyMap<string, number | null>,
): ReadonlyMap<string, WorkspaceTeamBudgetAllocation> {
  const rowsByTeam = new Map<string, WorkspaceTeamSpendLike[]>();
  for (const row of rows) {
    const teamRows = rowsByTeam.get(row.teamName) ?? [];
    if (!teamRows.some((item) => item.workspaceId === row.workspaceId)) {
      teamRows.push({ ...row, spendUsd: Math.max(0, row.spendUsd) });
      rowsByTeam.set(row.teamName, teamRows);
    }
  }

  const allocations = new Map<string, WorkspaceTeamBudgetAllocation>();
  for (const [teamName, teamRows] of rowsByTeam) {
    const budgetUsd = budgets.get(teamName);
    if (budgetUsd == null) continue;
    const sortedRows = [...teamRows].sort((a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.teamName.localeCompare(b.teamName)
    );
    const totalSpend = sortedRows.reduce((sum, row) => sum + row.spendUsd, 0);
    const isShared = sortedRows.length > 1;
    const method = !isShared ? 'full' : totalSpend > 0 ? 'proportional' : 'equal';
    let allocated = 0;

    sortedRows.forEach((row, index) => {
      const isFinal = index === sortedRows.length - 1;
      const share = totalSpend > 0 ? row.spendUsd / totalSpend : 1 / sortedRows.length;
      const amount = isFinal
        ? budgetUsd - allocated
        : Math.floor((budgetUsd * share + Number.EPSILON) * 100) / 100;
      allocated += amount;
      allocations.set(workspaceTeamSpendKey(row.workspaceId, teamName), {
        budgetUsd: amount,
        isShared,
        method,
      });
    });
  }
  return allocations;
}