export interface DashboardReconciliation {
  residualSpendUsd: number | null;
  totalSpendUsd: number;
  isTotalLoaded: boolean;
}

export function isCanonicalSummaryPending(
  isLoading: boolean,
  isComplete: boolean | null | undefined,
  syncStatus?: string | null,
): boolean {
  // Dashboard values are always rendered from the best available response.
  // Synchronization status controls polling/retry, never visible readiness.
  return false;
}

export function isTotalSpendHeadlinePending({
  isLoading,
  isAccountWide,
  accountUsageTotalSpendUsd,
  isComplete,
  syncStatus,
}: {
  isLoading: boolean;
  isAccountWide: boolean;
  accountUsageTotalSpendUsd: number | null | undefined;
  isComplete: boolean | null | undefined;
  syncStatus?: string | null;
}): boolean {
  // The account headline is independently anchored by one unfiltered request.
  // Do not hide it while unrelated group/project scopes continue warming.
  return false;
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