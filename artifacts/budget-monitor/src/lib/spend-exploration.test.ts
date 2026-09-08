import { describe, expect, it } from 'vitest';
import { sanitizeSpendReturnTo, spendColumns, spendDetailHref, updateSpendParams } from './spend-exploration';

describe('Spend exploration URLs', () => {
  it('retains filters, ordering, range and per-view columns across view changes', () => {
    const search = 'tab=groups&page=3&search=ops&status=over&workspaceId=w1&sort=name_asc&rangeType=ytd&density=compact&columns_groups=name,spendUsd';
    const next = new URLSearchParams(updateSpendParams(search, { tab: 'people' }));
    expect(next.get('tab')).toBe('people');
    expect(next.has('page')).toBe(false);
    for (const [key, value] of new URLSearchParams(search)) {
      if (key !== 'tab' && key !== 'page') expect(next.get(key)).toBe(value);
    }
  });

  it('clears narrowing filters without broadening scope or changing dates and sorting', () => {
    const next = new URLSearchParams(updateSpendParams('search=ops&workspaceId=w1&status=over&page=2&viewScope=my&rangeType=mtd&sort=name_desc', {
      search: null, workspaceId: null, status: null,
    }));
    expect(Object.fromEntries(next)).toEqual({ viewScope: 'my', rangeType: 'mtd', sort: 'name_desc' });
  });

  it('presentation preferences do not reset pagination', () => {
    expect(new URLSearchParams(updateSpendParams('page=4', { columns_groups: 'name,spendUsd', density: 'compact' })).get('page')).toBe('4');
  });

  it('carries reporting and authorization context into details and restores the exact results URL', () => {
    const returnTo = '/my-projects?search=R%26D&page=2&rangeType=custom&startDate=2026-08-01&endDate=2026-08-31&sort=name_desc&workspaceId=w1';
    const params = new URLSearchParams(spendDetailHref('/groups/group-1', returnTo).split('?')[1]);
    expect(params.get('returnTo')).toBe(returnTo);
    expect(params.get('rangeType')).toBe('custom');
    expect(params.get('startDate')).toBe('2026-08-01');
    expect(params.get('endDate')).toBe('2026-08-31');
    expect(params.has('viewScope')).toBe(false);
    expect(params.get('workspaceId')).toBe('w1');
    expect(params.has('search')).toBe(false);
    expect(params.has('tab')).toBe(false);
  });

  it('retains managed scope from Org Insights through project and owner links', () => {
    const projectHref = spendDetailHref('/workspaces/w1/projects/p1', '/org-insights?viewScope=managed&workspaceId=w1&rangeType=mtd');
    const ownerParams = new URLSearchParams(spendDetailHref('/users/u1', projectHref).split('?')[1]);
    expect(ownerParams.get('viewScope')).toBe('managed');
    expect(ownerParams.get('workspaceId')).toBe('w1');
    expect(ownerParams.get('rangeType')).toBe('mtd');
  });

  it('preserves a literal escaped canonical pool ID through nested detail links', () => {
    const canonicalPoolId = 'pool:team:R%2FD';
    const teamReturn = `/teams/${encodeURIComponent(canonicalPoolId)}`;
    const personHref = spendDetailHref(
      '/users/u1',
      `${teamReturn}?poolId=${encodeURIComponent(canonicalPoolId)}`,
    );
    const projectHref = spendDetailHref('/workspaces/w1/projects/p1', personHref);
    const params = new URLSearchParams(projectHref.split('?')[1]);
    expect(params.get('poolId')).toBe(canonicalPoolId);
    expect(params.get('returnTo')).toContain('poolId=pool%3Ateam%3AR%252FD');
  });

  it('always retains identity and total, rejects unavailable and duplicate columns', () => {
    const all = ['name', 'spendUsd', 'agentSpendUsd'];
    expect(spendColumns(all, all, 'agentSpendUsd,agentSpendUsd,invented')).toEqual(all);
    expect(spendColumns(all, all, '')).toEqual(['name', 'spendUsd']);
    expect(spendColumns(all, all, null)).toEqual(all);
  });

  it('rejects external and protocol-relative return destinations', () => {
    expect(sanitizeSpendReturnTo('https://evil.example')).toBe('/my-projects');
    expect(sanitizeSpendReturnTo('//evil.example')).toBe('/my-projects');
    expect(sanitizeSpendReturnTo('/spend?tab=projects&viewScope=my&page=2')).toBe('/my-projects?page=2');
    expect(sanitizeSpendReturnTo('/spend?tab=groups', '/my-team')).toBe('/my-team');
  });
});