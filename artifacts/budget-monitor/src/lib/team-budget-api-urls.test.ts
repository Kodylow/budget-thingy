import { describe, expect, it } from 'vitest';
import {
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
});