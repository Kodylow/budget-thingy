import { describe, expect, it } from 'vitest';
import {
  buildLimitsTeamHierarchy,
  dedupeLimitDrafts,
  describeLimitValue,
  mergeLimitDrafts,
  nonnegativeUsdCents,
  personTargetKey,
  positiveUsdAmount,
  replaceConflictingDrafts,
  selectableTeamPersonKeys,
} from './limits-table-model';

describe('live limits table model', () => {
  it('accepts only positive finite amounts with cents precision', () => {
    expect(positiveUsdAmount('10.25')).toBe(10.25);
    for (const value of ['', '0', '-1', '1.001', 'Infinity', '01']) {
      expect(positiveUsdAmount(value)).toBeNull();
    }
  });

  it('accepts zero for local plans while preserving exact cent precision', () => {
    expect(nonnegativeUsdCents('0')).toBe(0);
    expect(nonnegativeUsdCents('1000.25')).toBe(100025);
    expect(nonnegativeUsdCents('70368744177664.01')).toBe(7036874417766401);
    for (const value of ['', '-1', '1.001', '01', 'Infinity']) {
      expect(nonnegativeUsdCents(value)).toBeNull();
    }
    expect(nonnegativeUsdCents('90071992547409.92')).toBeNull();
  });

  it('deduplicates exact workspace and target identities without merging workspaces', () => {
    const a = { workspaceId: 'a', type: 'workspace_user_limit' as const, targetId: 'user', amountUsd: 10 };
    const updated = { ...a, amountUsd: null };
    const b = { ...a, workspaceId: 'b', amountUsd: 20 };
    expect(dedupeLimitDrafts([a, b, updated])).toEqual([updated, b]);
    expect(personTargetKey('a', 'user')).not.toBe(personTargetKey('b', 'user'));
  });

  it('blocks conflicting overlap amounts until the operator explicitly replaces them', () => {
    const original = { workspaceId: 'a', type: 'workspace_user_limit' as const, targetId: 'user', amountUsd: 10 };
    const same = { ...original };
    const conflict = { ...original, amountUsd: 20 };
    const otherWorkspace = { ...conflict, workspaceId: 'b' };
    const merged = mergeLimitDrafts([original], [same, conflict, otherWorkspace]);

    expect(merged.drafts).toEqual([original, otherWorkspace]);
    expect(merged.conflicts).toEqual([{
      key: personTargetKey('a', 'user'),
      existing: original,
      proposed: conflict,
    }]);
    expect(replaceConflictingDrafts(merged.drafts, merged.conflicts)).toEqual([
      conflict,
      otherWorkspace,
    ]);
  });

  it('does not collapse absent, inherited, and unavailable values', () => {
    expect(describeLimitValue('none', null)).toBe('No configured limit');
    expect(describeLimitValue('inherited', null)).toBe('Inherited · amount unavailable');
    expect(describeLimitValue('unavailable', null)).toBe('Unavailable');
  });

  it('builds canonical allocation teams across workspaces and keeps same people as distinct targets', () => {
    const member = (userId: string, groupIds: string[]) => ({
      userId, groupIds, eligible: true, isInternal: false, isDisabled: false,
    });
    const hierarchy = buildLimitsTeamHierarchy([
      { workspaceId: 'ws-a', workspaceName: 'A', groups: [{ groupId: 'ga', name: 'A Members' }], members: [member('same-user', ['ga'])] },
      { workspaceId: 'ws-b', workspaceName: 'B', groups: [{ groupId: 'gb', name: 'B Members' }], members: [member('same-user', ['gb'])] },
    ], [
      { workspaceId: 'ws-a', groupId: 'ga', teamName: 'Product' },
      { workspaceId: 'ws-b', groupId: 'gb', teamName: 'Product' },
    ]);
    expect(hierarchy).toHaveLength(1);
    expect(hierarchy[0].groups).toHaveLength(2);
    expect(selectableTeamPersonKeys(hierarchy[0])).toEqual([
      personTargetKey('ws-a', 'same-user'),
      personTargetKey('ws-b', 'same-user'),
    ]);
  });

  it('keeps unmapped groups and people without a known group reachable', () => {
    const hierarchy = buildLimitsTeamHierarchy([{
      workspaceId: 'ws-a',
      workspaceName: 'A',
      groups: [{ groupId: 'unmapped', name: 'Contractors' }],
      members: [
        { userId: 'in-unmapped', groupIds: ['unmapped'], eligible: true, isInternal: false, isDisabled: false },
        { userId: 'no-group', groupIds: [], eligible: true, isInternal: false, isDisabled: false },
        { userId: 'unknown-group', groupIds: ['not-observed'], eligible: true, isInternal: false, isDisabled: false },
      ],
    }], []);
    expect(hierarchy[0].name).toBe('Unmapped groups');
    expect(hierarchy[0].groups[0].members[0].member.userId).toBe('in-unmapped');
    expect(hierarchy[0].ungroupedPeople.map(person => person.member.userId)).toEqual(['no-group', 'unknown-group']);
  });
});