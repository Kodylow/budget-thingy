import { describe, expect, it } from 'vitest';
import {
  legacyReportingDestination,
  reportingNavigationHref,
  reportingNavigationKey,
  teamOverviewHref,
} from './reporting-navigation';

describe('reporting navigation', () => {
  it('carries reporting context but not ledger scope, filters, or pagination', () => {
    const href = reportingNavigationHref(
      '/my-team',
      'rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&projectionHorizon=term_end&viewScope=managed&workspaceId=w1&page=2',
    );
    expect(href).toBe('/my-team?rangeType=custom&startDate=2026-05-20&endDate=2026-09-06&projectionHorizon=term_end');
  });

  it('keeps Org Insights account-wide and free from inherited filters', () => {
    expect(reportingNavigationHref('/org-insights', 'rangeType=month&workspaceId=w1'))
      .toBe('/org-insights');
  });

  it('builds canonical team paths by encoding the raw ID exactly once', () => {
    expect(teamOverviewHref('pool:team:R%2FD', 'rangeType=full-term&viewScope=managed'))
      .toBe('/teams/pool%3Ateam%3AR%252FD?rangeType=full-term');
  });

  it('gives standalone destinations their own active navigation key', () => {
    expect(reportingNavigationKey('/my-projects', 'page=2')).toBe('/my-projects');
    expect(reportingNavigationKey('/my-team', 'rangeType=month')).toBe('/my-team');
  });

  it('maps legacy personal, selected-team, and generic reporting URLs safely', () => {
    expect(legacyReportingDestination('view=projects&viewScope=my&page=2', false))
      .toBe('/my-projects?page=2');
    expect(legacyReportingDestination('poolId=pool%3Ateam%3AA%252FB', true))
      .toBe('/teams/pool%3Ateam%3AA%252FB');
    expect(legacyReportingDestination('rangeType=month', true)).toBe('/org-insights');
    expect(legacyReportingDestination('rangeType=month', false)).toBe('/my-team?rangeType=month');
  });
});