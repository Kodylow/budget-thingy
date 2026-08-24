export interface DashboardReconciliation {
  residualSpendUsd: number | null;
  totalSpendUsd: number;
  isTotalLoaded: boolean;
}

export function reconcileDashboardSpend({
  isAccountWide,
  visibleRollupSpendUsd,
  accountUsageTotalSpendUsd,
  accountReconciliationSpendUsd,
  projectSpendLoaded,
  unattributedProjectSpendUsd,
}: {
  isAccountWide: boolean;
  visibleRollupSpendUsd: number;
  accountUsageTotalSpendUsd: number | null | undefined;
  accountReconciliationSpendUsd: number | null | undefined;
  projectSpendLoaded: boolean;
  unattributedProjectSpendUsd: number;
}): DashboardReconciliation {
  if (isAccountWide) {
    const isTotalLoaded =
      accountUsageTotalSpendUsd != null && accountReconciliationSpendUsd != null;
    return {
      residualSpendUsd: isTotalLoaded ? accountReconciliationSpendUsd : null,
      totalSpendUsd: isTotalLoaded
        ? visibleRollupSpendUsd + accountReconciliationSpendUsd
        : visibleRollupSpendUsd,
      isTotalLoaded,
    };
  }

  return {
    residualSpendUsd: projectSpendLoaded ? unattributedProjectSpendUsd : null,
    totalSpendUsd:
      visibleRollupSpendUsd + (projectSpendLoaded ? unattributedProjectSpendUsd : 0),
    isTotalLoaded: projectSpendLoaded,
  };
}