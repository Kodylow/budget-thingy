import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BudgetTeamDetail } from './budget-team-detail';
import * as api from '@workspace/api-client-react';

vi.mock('@workspace/api-client-react', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual as any,
    useGetBudgetTeamReport: vi.fn(),
    getGetBudgetTeamReportQueryKey: vi.fn().mockReturnValue(['mockQueryKey']),
  };
});

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({ authorizationKey: 'test-auth-key' })
}));

describe('BudgetTeamDetail', () => {
  it('requests report with authorizationKey, viewScope, and correct flags', () => {
    const reportSpy = vi.mocked(api.useGetBudgetTeamReport).mockReturnValue({
      data: undefined, isLoading: true, isError: false, refetch: vi.fn()
    } as any);

    renderToStaticMarkup(<BudgetTeamDetail poolId="pool:team:A%20B" rangeParams={{ rangeType: 'billing' }} viewScope="managed" onBack={() => {}} />);

    expect(reportSpy).toHaveBeenCalledWith(
      'pool:team:A%20B',
      { rangeType: 'billing', viewScope: 'managed', includeHierarchy: true, includeBudgetTracking: true },
      expect.objectContaining({
        query: expect.objectContaining({
          queryKey: ['mockQueryKey', 'test-auth-key']
        })
      })
    );
  });

  it('renders decoded title when report name is undefined, and handles signed residuals', () => {
    vi.mocked(api.useGetBudgetTeamReport).mockReturnValue({
      data: {
        kind: 'team',
        period: { label: 'Oct 2024' },
        headline: {
          allocationUsd: 1000,
          spendUsd: 500,
          isComplete: true,
          usageObserved: true,
        },
        sourceGroups: [],
        hierarchyUnattributedSpendUsd: -50,
        budgetTracking: {
          allocationUsd: 12000,
          spendUsd: 5000,
          remainingUsd: 7000,
          percentUsed: 41.6,
          periodLabel: 'Annual',
        },
        metadata: { qualifications: [] },
        hierarchy: []
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    } as any);

    const html = renderToStaticMarkup(<BudgetTeamDetail poolId="pool:team:My%20Test%20Team" rangeParams={{ rangeType: 'billing' }} viewScope="managed" onBack={() => {}} />);
    
    // Decoded title fallback since report.name is undefined
    expect(html).toContain('My Test Team');
    
    // Negative residual
    expect(html).toContain('-$50.00');
    expect(html).toContain('Team unattributed');
  });

  it('shows Unavailable for unobserved metrics', () => {
    vi.mocked(api.useGetBudgetTeamReport).mockReturnValue({
      data: {
        kind: 'team',
        name: 'Actual Team Name',
        period: { label: 'Oct 2024' },
        headline: { isComplete: false, usageObserved: false },
        sourceGroups: [],
        budgetTracking: null,
        metadata: { qualifications: [] },
        hierarchy: [
          {
            workspaceId: 'ws-1',
            workspaceName: 'Workspace 1',
            usageObserved: false,
            isComplete: false,
            spendUsd: 0,
            agentSpendUsd: 0,
            otherServicesUsd: 0,
            unattributedSpendUsd: 15,
            groups: [
              {
                groupId: 'g-1',
                name: 'Group 1',
                usageObserved: true,
                isComplete: true,
                spendUsd: 100,
                agentSpendUsd: 80,
                otherServicesUsd: 20,
                unattributedSpendUsd: -10,
                members: [
                  { userId: 'u-1', name: 'Zebra', spendUsd: 50, agentSpendUsd: 50, otherServicesUsd: 0, limitUsd: 100, currentCycleAgentSpendUsd: 25 },
                  { userId: 'u-2', name: 'Alpha', spendUsd: 30, agentSpendUsd: 30, otherServicesUsd: 0, limitUsd: 100, currentCycleAgentSpendUsd: 50 },
                ]
              }
            ]
          }
        ]
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    } as any);

    const html = renderToStaticMarkup(<BudgetTeamDetail poolId="pool:team:A" rangeParams={{ rangeType: 'billing' }} viewScope="managed" onBack={() => {}} />);
    
    // Title from report name
    expect(html).toContain('Actual Team Name');
    
    // Unobserved workspace shows Unavailable instead of $0
    expect(html).toContain('Unavailable');
  });
});