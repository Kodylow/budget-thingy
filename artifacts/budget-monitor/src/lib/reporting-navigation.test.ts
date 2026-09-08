import { describe, expect, it } from 'vitest';
import { reportingNavigationHref, reportingNavigationKey } from './reporting-navigation';

describe('reporting navigation', () => {
  it('keeps selected dates when opening forecast details', () => {
    for (const path of ['/overview']) {
      const href = reportingNavigationHref(`${path}?viewScope=all_authorized`, 'rangeType=custom&startDate=2026-09-01&endDate=2026-09-04&viewScope=my&page=2');
      const url = new URL(href, 'https://example.test');
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get('rangeType')).toBe('custom');
      expect(url.searchParams.get('startDate')).toBe('2026-09-01');
      expect(url.searchParams.get('endDate')).toBe('2026-09-04');
      expect(url.searchParams.get('viewScope')).toBe('all_authorized');
      expect(url.searchParams.has('page')).toBe(false);
    }
  });
  it('opens account-wide organization insights without inherited Home filters', () => {
    expect(reportingNavigationHref(
      '/org-insights',
      'workspaceId=workspace-1&rangeType=custom&startDate=2026-09-01&endDate=2026-09-04&viewScope=my',
    )).toBe('/org-insights');
  });
  it('keeps the period while the destination deliberately selects personal projects', () => {
    const href = reportingNavigationHref('/spend?tab=projects&viewScope=my', 'rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&viewScope=all_authorized&projectionHorizon=term_end&page=4');
    const query = new URL(href, 'https://example.test').searchParams;
    expect(query.get('viewScope')).toBe('my');
    expect(query.get('tab')).toBe('projects');
    expect(query.get('startDate')).toBe('2026-05-20');
    expect(query.get('endDate')).toBe('2026-09-06');
    expect(query.get('projectionHorizon')).toBe('term_end');
    expect(query.has('page')).toBe(false);
  });

  it('selects one navigation intent for a shared Spend route', () => {
    expect(reportingNavigationKey('/spend', 'tab=projects&viewScope=my')).toBe('/spend?tab=projects&viewScope=my');
    expect(reportingNavigationKey('/spend', 'tab=people&viewScope=managed')).toBe('/my-team');
    expect(reportingNavigationKey('/my-team', 'viewScope=my')).toBe('/my-team');
    expect(reportingNavigationKey('/spend', 'tab=projects&viewScope=all_authorized')).toBe('/spend');
    expect(reportingNavigationKey('/allocations', 'tab=projects&viewScope=my')).toBe('/allocations');
  });
  it('preserves explicit reporting and projection meanings without ledger filters', () => {
    const href = reportingNavigationHref('/', 'rangeType=custom&startDate=2026-01-01&endDate=2026-09-05&viewScope=my&projectionHorizon=planning_end&planningEndDate=2026-12-31&page=3&search=team');
    const query = new URL(href, 'https://example.test').searchParams;
    expect(query.get('endDate')).toBe('2026-09-05');
    expect(query.get('planningEndDate')).toBe('2026-12-31');
    expect(query.get('viewScope')).toBe('my');
    expect(query.has('page')).toBe(false);
    expect(query.has('search')).toBe(false);
  });

  it('does not attach reporting ranges to the limit editor or management', () => {
    expect(reportingNavigationHref('/limits', 'rangeType=mtd')).toBe('/limits');
    expect(reportingNavigationHref('/settings', 'planningEndDate=2026-12-31')).toBe('/settings');
    expect(reportingNavigationHref('/spend', '')).toBe('/spend');
  });

  it('preserves selected dates when opening Custom Reports', () => {
    const href = reportingNavigationHref('/reports', 'rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&workspaceId=workspace-1&page=3');
    const query = new URL(href, 'https://example.test').searchParams;
    expect(query.get('rangeType')).toBe('custom');
    expect(query.get('startDate')).toBe('2026-05-20');
    expect(query.get('endDate')).toBe('2026-09-06');
    expect(query.get('workspaceId')).toBe('workspace-1');
    expect(query.has('page')).toBe(false);
  });

  it('preserves dates and horizon when opening My Team', () => {
    const href = reportingNavigationHref('/my-team?viewScope=managed', 'rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&projectionHorizon=term_end&page=2');
    const query = new URL(href, 'https://example.test').searchParams;
    expect(query.get('viewScope')).toBe('managed');
    expect(query.get('startDate')).toBe('2026-05-20');
    expect(query.get('endDate')).toBe('2026-09-06');
    expect(query.get('projectionHorizon')).toBe('term_end');
    expect(query.has('page')).toBe(false);
  });
});
