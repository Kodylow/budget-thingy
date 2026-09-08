import { describe, expect, it } from 'vitest';
import { reportingNavigationHref, reportingNavigationKey } from './reporting-navigation';

describe('reporting navigation', () => {
  it('keeps selected dates when opening forecast details', () => {
    for (const path of ['/overview']) {
    const href = reportingNavigationHref('/my-team?viewScope=managed', 'rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&projectionHorizon=term_end&page=2');
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
    const href = reportingNavigationHref('/my-team?viewScope=managed', 'rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&projectionHorizon=term_end&page=2');
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
    expect(query.get('rangeType')).toBe('custom');
    expect(query.get('startDate')).toBe('2026-05-20');
    expect(query.get('endDate')).toBe('2026-09-06');
    expect(query.get('workspaceId')).toBe('workspace-1');
    expect(query.has('page')).toBe(false);
  });

  it('preserves dates and horizon when opening My Team', () => {
    const href = reportingNavigationHref('/my-team?viewScope=managed', 'rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&projectionHorizon=term_end&page=2');
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
