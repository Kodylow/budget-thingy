import { formatUsd } from './format';

export interface PersonalLimitSummary {
  workspaceId: string;
  workspaceName?: string | null;
  amount: number | null;
  state: string;
  currentCycleAgentSpendUsd?: number | null;
  currentCycleRemainingUsd?: number | null;
  currentCyclePercentUsed?: number | null;
}

export interface PersonalWorkspaceSpendSummary {
  workspaceId: string;
  workspaceName?: string | null;
  spendUsd: number | null;
  usageObserved: boolean;
  coverage: 'complete' | 'partial' | 'missing';
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000;
}

export function personalLimitBudgetRows(limits: PersonalLimitSummary[]) {
  return limits.map((limit) => ({
    id: limit.workspaceId,
    workspaceId: limit.workspaceId,
    workspaceName: limit.workspaceName ?? null,
    allocationUsd: limit.amount,
    limitState: limit.state,
    currentCycleAgentSpendUsd: limit.currentCycleAgentSpendUsd ?? null,
    currentCycleRemainingUsd: limit.currentCycleRemainingUsd ?? null,
    currentCyclePercentUsed: limit.currentCyclePercentUsed ?? null,
  }));
}

export function aggregatePersonalLimits(limits: PersonalLimitSummary[]) {
  const finite = limits.filter((limit) =>
    (limit.state === 'explicit' || limit.state === 'inherited') && limit.amount != null);
  const unlimited = limits.filter((limit) => limit.state === 'no_limit');
  const unknownLimits = limits.filter((limit) =>
    limit.state === 'unavailable' ||
    ((limit.state === 'explicit' || limit.state === 'inherited') && limit.amount == null));
  const observed = limits.filter((limit) => limit.currentCycleAgentSpendUsd != null);
  const finiteObserved = finite.filter((limit) => limit.currentCycleAgentSpendUsd != null);
  const unlimitedObserved = unlimited.filter((limit) => limit.currentCycleAgentSpendUsd != null);

  return {
    workspaceCount: limits.length,
    finiteBudgetUsd: roundUsd(finite.reduce((sum, limit) => sum + limit.amount!, 0)),
    finiteConsumptionUsd: roundUsd(finiteObserved.reduce(
      (sum, limit) => sum + limit.currentCycleAgentSpendUsd!,
      0,
    )),
    unlimitedConsumptionUsd: roundUsd(unlimitedObserved.reduce(
      (sum, limit) => sum + limit.currentCycleAgentSpendUsd!,
      0,
    )),
    knownConsumptionUsd: roundUsd(observed.reduce(
      (sum, limit) => sum + limit.currentCycleAgentSpendUsd!,
      0,
    )),
    finiteCount: finite.length,
    unlimitedCount: unlimited.length,
    unknownLimitCount: unknownLimits.length,
    observedConsumptionCount: observed.length,
    unknownConsumptionCount: limits.length - observed.length,
    consumptionComplete: limits.length > 0 && observed.length === limits.length,
  };
}

export function aggregatePersonalWorkspaceSpend(
  rows: PersonalWorkspaceSpendSummary[],
  canonicalTotalUsd: number | null,
) {
  const knownRows = rows.filter((row) => row.usageObserved && row.spendUsd != null);
  const knownSubtotalUsd = roundUsd(knownRows.reduce((sum, row) => sum + row.spendUsd!, 0));
  const unknownCount = rows.length - knownRows.length;
  return {
    workspaceCount: rows.length,
    knownSubtotalUsd,
    unknownCount,
    complete: rows.length > 0 && unknownCount === 0 && canonicalTotalUsd != null,
    reconcilesToCanonical: rows.length > 0 &&
      unknownCount === 0 &&
      canonicalTotalUsd != null &&
      Math.abs(knownSubtotalUsd - canonicalTotalUsd) < 0.000001,
  };
}

export function personalProjectCatalogMetrics(catalog: {
  projectCount: number;
  publishedProjectCount: number;
  publicationKnownProjectCount: number;
  publicationUnknownProjectCount: number;
  coverage: 'complete' | 'partial' | 'missing';
} | null | undefined) {
  if (!catalog) {
    return {
      projectCount: null,
      publishedProjectCount: null,
      projectCountQualified: false,
      publishedCountQualified: false,
    };
  }
  const projectCountKnown = catalog.coverage !== 'missing' || catalog.projectCount > 0;
  const publicationKnown = catalog.coverage === 'complete' ||
    catalog.publicationKnownProjectCount > 0;
  return {
    projectCount: projectCountKnown ? catalog.projectCount : null,
    publishedProjectCount: publicationKnown ? catalog.publishedProjectCount : null,
    projectCountQualified: projectCountKnown && catalog.coverage !== 'complete',
    publishedCountQualified: publicationKnown &&
      (catalog.coverage !== 'complete' || catalog.publicationUnknownProjectCount > 0),
  };
}

export function getBudgetDisplayInfo(row: {
  allocationUsd?: number | null;
  currentCycleAgentSpendUsd?: number | null;
  currentCycleRemainingUsd?: number | null;
  currentCyclePercentUsed?: number | null;
}, projectedTotalUsd?: number | null) {
  const limit = row.allocationUsd;
  const spend = row.currentCycleAgentSpendUsd;
  const pct = row.currentCyclePercentUsed;
  const remaining = row.currentCycleRemainingUsd;
  
  const spendFormatted = spend != null ? formatUsd(spend) : 'Unavailable';
  const limitFormatted = limit != null ? formatUsd(limit) : null;
  const remainingFormatted = remaining != null ? `${formatUsd(remaining)} remaining` : 'Remaining unavailable';
  const pctFormatted = pct != null ? `${pct}%` : '—';
  
  const isDanger = pct != null && pct >= 90;
  const pctValue = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
  
  // We NEVER produce a forecast warning comparing a full-period projection against a current-cycle agent limit.
  // This explicitly documents the regression fix where full-period multi-service projections falsely warned against narrow agent limits.
  const hasForecastWarning = false; 

  return {
    limit,
    spendFormatted,
    limitFormatted,
    remainingFormatted,
    pctFormatted,
    pctValue,
    isDanger,
    hasForecastWarning
  };
}