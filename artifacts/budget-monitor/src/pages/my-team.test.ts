import { describe, expect, it } from 'vitest';
import type { SpendTableRow } from '@workspace/api-client-react';
import { resolveLimitStatus, resolveMyTeamScope } from './my-team';

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

describe('My Team budget status presentation', () => {
  const row = (currentCycleAgentSpendUsd: number | null, allocationUsd: number | null) => ({
    limitState: allocationUsd == null ? 'no_limit' : 'explicit',
    currentCycleAgentSpendUsd,
    allocationUsd,
  } as SpendTableRow);

  it('uses the approved within, near, and over budget states', () => {
    expect(resolveLimitStatus(row(40, 100))).toBe('Within budget');
    expect(resolveLimitStatus(row(90, 100))).toBe('Near limit');
    expect(resolveLimitStatus(row(101, 100))).toBe('Over budget');
    expect(resolveLimitStatus(row(0, 0))).toBe('Within budget');
    expect(resolveLimitStatus(row(1, 0))).toBe('Over budget');
  });

  it('does not imply a status when no limit can be compared', () => {
    expect(resolveLimitStatus(row(40, null))).toBeNull();
    expect(resolveLimitStatus(row(null, 100))).toBeNull();
  });
});