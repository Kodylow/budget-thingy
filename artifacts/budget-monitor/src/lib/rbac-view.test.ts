// @ts-nocheck
import { test, expect } from "vitest";

import {
  canOpenGroupInView,
  canUseRbacPreview,
  filterAlertsForView,
  filterGroupsForView,
  sanitizePreview,
} from './rbac-view.ts';

const groupPreview = {
  role: 'workspace_admin',
  groupId: 'workspace::Alpha',
  groupIds: ['group-a', 'group-a-member', 'group-a-viewer'],
  groupName: 'Alpha',
};

test('only true account admins and the designated delegate may preview', () => {
  expect(canUseRbacPreview('account_admin')).toBe(true);
  expect(canUseRbacPreview('account_delegate')).toBe(true);
  expect(canUseRbacPreview('account_editor')).toBe(false);
  expect(canUseRbacPreview('workspace_admin')).toBe(false);
});

test('crafted preview state is discarded for ineligible sessions', () => {
  expect(sanitizePreview('account_editor', groupPreview)).toBe(null);
  expect(sanitizePreview('workspace_admin', groupPreview)).toBe(null);
  expect(sanitizePreview('account_admin', groupPreview)).toEqual(groupPreview);
});

test('group-admin preview narrows visible groups and direct navigation to every sibling', () => {
  const groups = [
    { groupId: 'group-a' },
    { groupId: 'group-a-member' },
    { groupId: 'group-a-viewer' },
    { groupId: 'group-b' },
  ];
  expect(filterGroupsForView(groups, 'workspace_admin', groupPreview)).toEqual(groups.slice(0, 3));
  expect(canOpenGroupInView('group-a', 'workspace_admin', groupPreview)).toBe(true);
  expect(canOpenGroupInView('group-a-member', 'workspace_admin', groupPreview)).toBe(true);
  expect(canOpenGroupInView('group-b', 'workspace_admin', groupPreview)).toBe(false);
});

test('real group admins retain the complete server-authorized response', () => {
  const groups = [{ groupId: 'group-a' }, { groupId: 'group-b' }];
  expect(filterGroupsForView(groups, 'workspace_admin', null)).toEqual(groups);
});

test('legacy single-group preview state is migrated to a one-ID logical scope', () => {
  const legacy = {
    role: 'workspace_admin',
    groupId: 'group-a',
    groupName: 'Alpha - Admin',
  };
  expect(sanitizePreview('account_admin', legacy)).toEqual({
    ...legacy,
    groupIds: ['group-a'],
  });
});

test('invalid IDs are removed and reset state remains unrestricted', () => {
  const requested = {
    role: 'workspace_admin',
    groupId: ' scope ',
    groupName: ' Alpha ',
    groupIds: ['group-a', '', 'group-a', null],
  };
  expect(sanitizePreview('account_delegate', requested)).toEqual({
    role: 'workspace_admin',
    groupId: 'scope',
    groupName: 'Alpha',
    groupIds: ['group-a'],
  });
  const groups = [{ groupId: 'group-a' }, { groupId: 'group-b' }];
  expect(filterGroupsForView(groups, 'workspace_admin', null)).toEqual(groups);
});

test('email activity includes each sibling group and excludes unrelated or team alerts', () => {
  const alerts = [
    { entityType: 'group', entityId: 'group-a' },
    { entityType: 'group', entityId: 'group-a-member' },
    { entityType: 'group', entityId: 'group-b' },
    { entityType: 'team', entityId: 'group-a' },
  ];
  expect(filterAlertsForView(alerts, groupPreview)).toEqual(alerts.slice(0, 2));
  expect(filterAlertsForView(alerts, null)).toEqual(alerts);
});
