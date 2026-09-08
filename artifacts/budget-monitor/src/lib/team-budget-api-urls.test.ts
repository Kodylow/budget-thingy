import { describe, expect, it } from 'vitest';
import {
  getGetBudgetTeamReportUrl,
  getUpdateTeamAnnualAllocationUrl,
  getUpdateTeamVisibilityUrl,
} from '@workspace/api-client-react';

describe('team budget administration URLs', () => {
  it('encodes team names as one path segment', () => {
    const teamName = 'Strategy / Research?';
    expect(getUpdateTeamAnnualAllocationUrl(teamName)).toBe(
      '/api/admin/team-budgets/Strategy%20%2F%20Research%3F/allocation',
    );
    expect(getUpdateTeamVisibilityUrl(teamName)).toBe(
      '/api/admin/team-budgets/Strategy%20%2F%20Research%3F/visibility',
    );
  });

  it('scopes a member Home report to own teams and the selected workspace', () => {
    const url = new URL(getGetBudgetTeamReportUrl('pool:team:Own', {
      scope: 'own',
      workspaceId: 'workspace-1',
      rangeType: 'custom',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      includeBudgetTracking: true,
      trackingRange: 'selected',
    }), 'https://example.test');
    expect(url.searchParams.get('scope')).toBe('own');
    expect(url.searchParams.get('workspaceId')).toBe('workspace-1');
    expect(url.searchParams.get('trackingRange')).toBe('selected');
  });
});