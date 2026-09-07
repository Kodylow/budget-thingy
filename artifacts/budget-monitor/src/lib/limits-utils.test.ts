import { describe, it, expect } from 'vitest';
import {
  getSelectableContextUserIds,
  getContextSelectionUpdate,
  getSelectableGroupUserIds,
  isMemberSelectable,
  isValidAmount,
  parseLimitsUrlContext,
  resolveLimitsWorkspaceId,
} from './limits-utils';
import { SetLimitsMember, SetLimitsGroup } from '@workspace/api-client-react';

describe('limits-utils', () => {
  describe('isValidAmount', () => {
    it('accepts valid amounts', () => {
      expect(isValidAmount('1')).toBe(true);
      expect(isValidAmount('10.5')).toBe(true);
      expect(isValidAmount('10.50')).toBe(true);
      expect(isValidAmount('0.01')).toBe(true);
      expect(isValidAmount('9999.99')).toBe(true);
    });

    it('rejects invalid amounts', () => {
      expect(isValidAmount('')).toBe(false);
      expect(isValidAmount('0')).toBe(false);
      expect(isValidAmount('0.00')).toBe(false);
      expect(isValidAmount('-1')).toBe(false);
      expect(isValidAmount('10.555')).toBe(false);
      expect(isValidAmount('abc')).toBe(false);
    });
  });

  describe('isMemberSelectable', () => {
    it('selects only eligible, non-internal, active members', () => {
      expect(isMemberSelectable({ eligible: true, isInternal: false, isDisabled: false } as SetLimitsMember)).toBe(true);

      expect(isMemberSelectable({ eligible: false, isInternal: false, isDisabled: false } as SetLimitsMember)).toBe(false);
      expect(isMemberSelectable({ eligible: true, isInternal: true, isDisabled: false } as SetLimitsMember)).toBe(false);
      expect(isMemberSelectable({ eligible: true, isInternal: false, isDisabled: true } as SetLimitsMember)).toBe(false);
    });
  });

  describe('getSelectableGroupUserIds', () => {
    it('intersects group eligible users with member selectability', () => {
      const group = { eligibleUserIds: ['1', '2', '3'] } as SetLimitsGroup;
      const members = [
        { userId: '1', eligible: true, isInternal: false, isDisabled: false },
        { userId: '2', eligible: false, isInternal: false, isDisabled: false },
        { userId: '3', eligible: true, isInternal: true, isDisabled: false },
        { userId: '4', eligible: true, isInternal: false, isDisabled: false }, // Not in group
      ] as SetLimitsMember[];

      const selectable = getSelectableGroupUserIds(group, members);
      expect(selectable).toEqual(['1']);
    });
  });

  describe('deep-link context', () => {
    it('parses workspace and explicit single or clustered group targets', () => {
      expect(parseLimitsUrlContext('?workspaceId=ws-1&groupId=group-1')).toEqual({
        workspaceId: 'ws-1',
        groupIds: ['group-1'],
      });
      expect(parseLimitsUrlContext('?workspaceId=ws-2&groupIds=group-2%2Cgroup-3&groupId=group-2')).toEqual({
        workspaceId: 'ws-2',
        groupIds: ['group-2', 'group-3'],
      });
    });

    it('initializes only an authorized requested workspace', () => {
      expect(resolveLimitsWorkspaceId('ws-2', 'ws-1', ['ws-1', 'ws-2'])).toBe('ws-2');
      expect(resolveLimitsWorkspaceId('outside-scope', 'ws-1', ['ws-1', 'ws-2'])).toBe('ws-1');
      expect(resolveLimitsWorkspaceId('outside-scope', null, ['ws-1'])).toBe('ws-1');
      expect(resolveLimitsWorkspaceId('outside-scope', null, ['ws-1', 'ws-2'])).toBeNull();
      expect(resolveLimitsWorkspaceId('outside-scope', null, [])).toBeNull();
    });

    it('selects only visible, eligible members of explicit context groups', () => {
      const groups = [
        { groupId: 'requested', eligibleUserIds: ['visible', 'hidden', 'internal'] },
        { groupId: 'other', eligibleUserIds: ['other-visible'] },
      ] as SetLimitsGroup[];
      const members = [
        { userId: 'visible', eligible: true, isInternal: false, isDisabled: false },
        { userId: 'internal', eligible: true, isInternal: true, isDisabled: false },
        { userId: 'other-visible', eligible: true, isInternal: false, isDisabled: false },
      ] as SetLimitsMember[];

      expect(getSelectableContextUserIds(['requested'], groups, members)).toEqual(['visible']);
      expect(getSelectableContextUserIds(['missing'], groups, members)).toEqual([]);
      expect(getSelectableContextUserIds([], groups, members)).toEqual([]);
    });

    it('resets contextual selection when context changes or is removed', () => {
      const groups = [
        { groupId: 'one', eligibleUserIds: ['member-one'] },
        { groupId: 'two', eligibleUserIds: ['member-two'] },
      ] as SetLimitsGroup[];
      const members = [
        { userId: 'member-one', eligible: true, isInternal: false, isDisabled: false },
        { userId: 'member-two', eligible: true, isInternal: false, isDisabled: false },
      ] as SetLimitsMember[];

      expect(getContextSelectionUpdate(null, [], groups, members)).toBeNull();
      expect(getContextSelectionUpdate('', ['one'], groups, members)).toEqual({
        contextKey: 'one',
        userIds: ['member-one'],
      });
      expect(getContextSelectionUpdate('one', ['two'], groups, members)).toEqual({
        contextKey: 'two',
        userIds: ['member-two'],
      });
      expect(getContextSelectionUpdate('two', ['unknown'], groups, members)).toEqual({
        contextKey: 'unknown',
        userIds: [],
      });
      expect(getContextSelectionUpdate('unknown', [], groups, members)).toEqual({
        contextKey: '',
        userIds: [],
      });
    });

    it('retains manual selection while the URL context is unchanged', () => {
      expect(getContextSelectionUpdate('one', ['one'], [], [])).toBeNull();
      expect(getContextSelectionUpdate('', [], [], [])).toBeNull();
    });
  });
});
