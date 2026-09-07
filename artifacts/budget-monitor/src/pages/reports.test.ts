import { describe, expect, it } from 'vitest';
import type { ReportingDetail, SpendTableRow } from '@workspace/api-client-react';
import { getGetBudgetTeamReportUrl } from '@workspace/api-client-react';
import {
  budgetMetrics,
  reportAccessAllowed,
  reportPoolQueryParams,
  reportUsageObserved,
  selectBudgetTeamPools,
} from './reports';

const row = (id: string, kind: SpendTableRow['kind'] = 'pool'): SpendTableRow => ({
  id,
  kind,
  name: id,
  workspaceId: null,
  workspaceName: null,
  usageObserved: true,
  spendUsd: 0,
  agentSpendUsd: 0,
  otherServicesUsd: 0,
  allocationUsd: null,
  remainingUsd: null,
  percentUsed: null,
  status: 'no_allocation',
  memberCount: 0,
  ownerName: null,
  limitState: 'not_applicable',
  limitObservationStatus: 'not_applicable',
  sharedPool: false,
});

describe('Custom Reports semantics', () => {
  it('preserves escaped canonical team IDs through query selection and API paths', () => {
    const poolId = `pool:team:${encodeURIComponent('Product / R&D 10%')}`;
    const search = `?${new URLSearchParams({ poolId })}`;
    const selectedId = new URLSearchParams(search).get('poolId')!;
    expect(selectBudgetTeamPools([row(poolId)]).find(pool => pool.id === selectedId)?.id).toBe(poolId);
    const url = new URL(getGetBudgetTeamReportUrl(selectedId), 'https://example.test');
    expect(decodeURIComponent(url.pathname.split('/').at(-1)!)).toBe(poolId);
  });
  it('offers only Airtable budget-team pool identities', () => {
    expect(selectBudgetTeamPools([
      row('pool:group:w:g'),
      row('pool:unbudgeted:w', 'unattributed'),
      row('pool:team:Engineering'),
    ]).map((item) => item.id)).toEqual(['pool:team:Engineering']);
  });

  it('loads all server-authorized team pools even when navigation inherited personal scope', () => {
    const inherited = new URLSearchParams('?viewScope=my&poolId=pool%3Ateam%3ATeam-12');
    const params = reportPoolQueryParams({
      rangeType: 'custom',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    }, 1);
    const rows = Array.from({ length: 28 }, (_, index) => {
      const team = `Team-${String(index + 1).padStart(2, '0')}`;
      return {
        ...row(`pool:team:${encodeURIComponent(team)}`),
        name: team,
        allocationUsd: Number((771_620.02 / 28).toFixed(8)),
        sourceGroupIds: [`group-${index * 3 + 1}`, `group-${index * 3 + 2}`, `group-${index * 3 + 3}`],
      };
    });

    expect(inherited.get('viewScope')).toBe('my');
    expect(params).toEqual({
      rangeType: 'custom',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      viewScope: 'all_authorized',
      page: 1,
      pageSize: 100,
    });
    expect(selectBudgetTeamPools(rows)).toHaveLength(28);
    expect(selectBudgetTeamPools(rows).some((pool) => pool.id === inherited.get('poolId'))).toBe(true);
  });

  it('does not query reports for ordinary unentitled members', () => {
    expect(reportAccessAllowed({
      isAccountAdmin: false,
      isWorkspaceAdmin: false,
      isTeamAdmin: false,
      canEditAllocations: false,
    })).toBe(false);
    expect(reportAccessAllowed({
      isAccountAdmin: false,
      isWorkspaceAdmin: false,
      isTeamAdmin: false,
      canEditAllocations: true,
    })).toBe(true);
  });

  it('preserves null budget facts instead of fabricating zero', () => {
    const report = {
      headline: {
        isComplete: true,
        allocationUsd: null,
        spendUsd: 0,
        remainingUsd: null,
        percentUsed: null,
      },
    } as ReportingDetail;
    expect(budgetMetrics(report)).toEqual({
      allocationUsd: null,
      spendUsd: 0,
      remainingUsd: null,
      percentUsed: null,
    });
  });

  it('keeps an absent or empty report distinguishable from a zero-spend report', () => {
    expect(budgetMetrics(undefined)).toEqual({
      allocationUsd: null,
      spendUsd: null,
      remainingUsd: null,
      percentUsed: null,
    });
  });

  it('reads budget facts only from the supplied full-period report', () => {
    const full = {
      headline: {
        isComplete: true,
        allocationUsd: 120_000,
        spendUsd: 30_000,
        remainingUsd: 90_000,
        percentUsed: 25,
      },
    } as ReportingDetail;
    expect(budgetMetrics(full).remainingUsd).toBe(90_000);
  });

  it('shows a positive known subtotal for observed partial selected usage', () => {
    const partial = {
      headline: {
        usageObserved: true,
        isComplete: false,
        spendUsd: 42,
      },
    } as unknown as ReportingDetail;
    expect(reportUsageObserved(partial)).toBe(true);
  });

  it('does not present unknown zero selected usage as observed spend', () => {
    const unknown = {
      headline: {
        usageObserved: false,
        isComplete: false,
        spendUsd: 0,
      },
    } as unknown as ReportingDetail;
    expect(reportUsageObserved(unknown)).toBe(false);
  });

  it('separates known full-period partial spend from incomplete budget health', () => {
    const partialBudget = {
      headline: {
        usageObserved: true,
        isComplete: false,
        allocationUsd: 120_000,
        spendUsd: 30_000,
        remainingUsd: 90_000,
        percentUsed: 25,
      },
    } as unknown as ReportingDetail;
    expect(budgetMetrics(partialBudget)).toEqual({
      allocationUsd: 120_000,
      spendUsd: 30_000,
      remainingUsd: null,
      percentUsed: null,
    });
  });

  it('makes a false-observation zero unavailable for the full budget period', () => {
    const unknownBudget = {
      headline: {
        usageObserved: false,
        isComplete: false,
        allocationUsd: 120_000,
        spendUsd: 0,
        remainingUsd: null,
        percentUsed: null,
      },
    } as unknown as ReportingDetail;
    expect(budgetMetrics(unknownBudget).spendUsd).toBeNull();
  });
});