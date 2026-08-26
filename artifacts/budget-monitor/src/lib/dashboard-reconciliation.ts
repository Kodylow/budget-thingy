export interface DashboardReconciliation {
  residualSpendUsd: number | null;
  totalSpendUsd: number;
  isTotalLoaded: boolean;
}

export function isCanonicalSummaryPending(
  isLoading: boolean,
  isComplete: boolean | null | undefined,
): boolean {
  return isLoading || isComplete !== true;
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
    // The authoritative visible rollup already contains this residual. It is
    // exposed as a distribution/reconciliation line, never added a second time.
    totalSpendUsd: visibleRollupSpendUsd,
    isTotalLoaded: projectSpendLoaded,
  };
}