import { describe, expect, it } from 'vitest';
import { resolveMyTeamScope } from './my-team';

describe('My Team role scope', () => {
  it('always forces members to their own scope', () => {
    expect(resolveMyTeamScope('member')).toEqual({ authorized: true, viewScope: 'my' });
  });

  it('uses managed scope for team and workspace administrators', () => {
    for (const role of ['team_admin', 'workspace_admin'] as const) {
      expect(resolveMyTeamScope(role)).toEqual({ authorized: true, viewScope: 'managed' });
    }
  });

  it('uses whole-organization scope only for an effective account admin', () => {
    expect(resolveMyTeamScope('account', true)).toEqual({
      authorized: true,
      viewScope: 'all_authorized',
    });
    expect(resolveMyTeamScope('account', false)).toEqual({
      authorized: true,
      viewScope: 'managed',
    });
    expect(resolveMyTeamScope('member', true)).toEqual({
      authorized: true,
      viewScope: 'my',
    });
  });

  it('guards denied, loading, and unauthenticated roles before requests are enabled', () => {
    for (const role of ['denied', null] as const) {
      expect(resolveMyTeamScope(role).authorized).toBe(false);
    }
  });
});