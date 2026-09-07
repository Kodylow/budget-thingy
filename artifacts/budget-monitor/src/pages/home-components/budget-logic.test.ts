import { describe, it, expect } from 'vitest';
import {
  aggregatePersonalLimits,
  aggregatePersonalWorkspaceSpend,
  getBudgetDisplayInfo,
  personalProjectCatalogMetrics,
  personalLimitBudgetRows,
  personalLimitSummaryRows,
} from './budget-logic';

describe('Budget Logic', () => {
  it('keeps every workspace limit, including zero-spend workspaces beyond a people page', () => {
    const limits = Array.from({ length: 20 }, (_, index) => ({
      workspaceId: index === 0 ? 'Comcast1awqan' : index === 19 ? 'Strategic6g8nnwm9cc' : `workspace-${index}`,
      workspaceName: index === 0 ? 'Comcast' : index === 19 ? 'Strategic' : `Workspace ${index}`,
      amount: index === 19 ? 500 : null,
      state: index === 19 ? 'explicit' : 'no_limit',
      currentCycleAgentSpendUsd: index === 19 ? 0 : null,
      currentCycleRemainingUsd: index === 19 ? 500 : null,
      currentCyclePercentUsed: index === 19 ? 0 : null,
    }));

    const rows = personalLimitBudgetRows(limits);
    expect(rows).toHaveLength(20);
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([
      'Comcast1awqan',
      'Strategic6g8nnwm9cc',
    ]));
    expect(rows.find((row) => row.id === 'Strategic6g8nnwm9cc')).toMatchObject({
      allocationUsd: 500,
      currentCycleAgentSpendUsd: 0,
    });
  });

  it('defaults the Agent spend details to used or finite-limit workspaces', () => {
    const limits = [
      { workspaceId: 'used', amount: null, state: 'no_limit', currentCycleAgentSpendUsd: 4 },
      { workspaceId: 'finite', amount: 100, state: 'explicit', currentCycleAgentSpendUsd: 0 },
      { workspaceId: 'unused-unlimited', amount: null, state: 'no_limit', currentCycleAgentSpendUsd: 0 },
      { workspaceId: 'unknown-unlimited', amount: null, state: 'no_limit', currentCycleAgentSpendUsd: null },
    ];

    expect(personalLimitSummaryRows(limits).map((row) => row.id)).toEqual([
      'used',
      'finite',
    ]);
    expect(personalLimitBudgetRows(limits)).toHaveLength(4);
  });

  it('null cycle cannot show 0 spent', () => {
    const info = getBudgetDisplayInfo({
      allocationUsd: 100,
      currentCycleAgentSpendUsd: null,
      currentCycleRemainingUsd: null,
      currentCyclePercentUsed: null,
    });
    
    expect(info.spendFormatted).toBe('Unavailable');
    expect(info.spendFormatted).not.toBe('$0.00');
    expect(info.remainingFormatted).toBe('Remaining unavailable');
    expect(info.pctFormatted).toBe('—');
  });

  it('full period projected total cannot produce budget over warning', () => {
    const info = getBudgetDisplayInfo({
      allocationUsd: 100,
      currentCycleAgentSpendUsd: 50,
      currentCycleRemainingUsd: 50,
      currentCyclePercentUsed: 50,
    }, 9999); // massive projection

    // Explicitly verify the forecast warning assessment is removed entirely
    expect(info.hasForecastWarning).toBe(false);
  });

  it('aggregates each finite workspace exactly once', () => {
    const aggregate = aggregatePersonalLimits([
      { workspaceId: 'a', amount: 1, state: 'explicit', currentCycleAgentSpendUsd: 9.39 },
      { workspaceId: 'b', amount: 10, state: 'inherited', currentCycleAgentSpendUsd: 2 },
    ]);
    expect(aggregate).toMatchObject({
      workspaceCount: 2,
      finiteCount: 2,
      finiteBudgetUsd: 11,
      finiteConsumptionUsd: 11.39,
      knownConsumptionUsd: 11.39,
      consumptionComplete: true,
    });
  });

  it('separates unlimited consumption and qualifies unknown workspaces', () => {
    const aggregate = aggregatePersonalLimits([
      { workspaceId: 'finite', amount: 100, state: 'explicit', currentCycleAgentSpendUsd: 20 },
      { workspaceId: 'unlimited', amount: null, state: 'no_limit', currentCycleAgentSpendUsd: 7 },
      { workspaceId: 'unknown', amount: null, state: 'unavailable', currentCycleAgentSpendUsd: null },
    ]);
    expect(aggregate).toMatchObject({
      finiteBudgetUsd: 100,
      finiteConsumptionUsd: 20,
      unlimitedConsumptionUsd: 7,
      knownConsumptionUsd: 27,
      unlimitedCount: 1,
      unknownLimitCount: 1,
      unknownConsumptionCount: 1,
      consumptionComplete: false,
    });
  });

  it('reconciles exact selected-period workspace spend to the canonical gross total', () => {
    expect(aggregatePersonalWorkspaceSpend([
      { workspaceId: 'Comcast1awqan', workspaceName: 'Comcast', spendUsd: 130, usageObserved: true, coverage: 'complete' },
      { workspaceId: 'Strategic6g8nnwm9cc', workspaceName: 'Strategic', spendUsd: 107.42, usageObserved: true, coverage: 'complete' },
    ], 237.42)).toEqual({
      workspaceCount: 2,
      knownSubtotalUsd: 237.42,
      unknownCount: 0,
      complete: true,
      reconcilesToCanonical: true,
    });
  });

  it('reports a known selected-period subtotal when a workspace is unobserved', () => {
    expect(aggregatePersonalWorkspaceSpend([
      { workspaceId: 'observed', spendUsd: 20, usageObserved: true, coverage: 'partial' },
      { workspaceId: 'missing', spendUsd: null, usageObserved: false, coverage: 'missing' },
    ], null)).toMatchObject({
      knownSubtotalUsd: 20,
      unknownCount: 1,
      complete: false,
      reconcilesToCanonical: false,
    });
  });

  it('uses the complete current catalog rather than period-active project analytics', () => {
    expect(personalProjectCatalogMetrics({
      projectCount: 903,
      publishedProjectCount: 238,
      publicationKnownProjectCount: 903,
      publicationUnknownProjectCount: 0,
      coverage: 'complete',
    })).toEqual({
      projectCount: 903,
      publishedProjectCount: 238,
      projectCountQualified: false,
      publishedCountQualified: false,
    });
  });

  it('keeps catalog and publication uncertainty independent', () => {
    expect(personalProjectCatalogMetrics({
      projectCount: 903,
      publishedProjectCount: 200,
      publicationKnownProjectCount: 665,
      publicationUnknownProjectCount: 238,
      coverage: 'partial',
    })).toEqual({
      projectCount: 903,
      publishedProjectCount: 200,
      projectCountQualified: true,
      publishedCountQualified: true,
    });
    expect(personalProjectCatalogMetrics({
      projectCount: 0,
      publishedProjectCount: 0,
      publicationKnownProjectCount: 0,
      publicationUnknownProjectCount: 0,
      coverage: 'missing',
    })).toMatchObject({
      projectCount: null,
      publishedProjectCount: null,
    });
  });
});