import assert from 'node:assert/strict';
import test from 'node:test';

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
  assert.equal(canUseRbacPreview('account_admin'), true);
  assert.equal(canUseRbacPreview('account_delegate'), true);
  assert.equal(canUseRbacPreview('account_editor'), false);
  assert.equal(canUseRbacPreview('workspace_admin'), false);
});

test('crafted preview state is discarded for ineligible sessions', () => {
  assert.equal(sanitizePreview('account_editor', groupPreview), null);
  assert.equal(sanitizePreview('workspace_admin', groupPreview), null);
  assert.deepEqual(sanitizePreview('account_admin', groupPreview), groupPreview);
});

test('group-admin preview narrows visible groups and direct navigation to every sibling', () => {
  const groups = [
    { groupId: 'group-a' },
    { groupId: 'group-a-member' },
    { groupId: 'group-a-viewer' },
    { groupId: 'group-b' },
  ];
  assert.deepEqual(
    filterGroupsForView(groups, 'workspace_admin', groupPreview),
    groups.slice(0, 3),
  );
  assert.equal(canOpenGroupInView('group-a', 'workspace_admin', groupPreview), true);
  assert.equal(canOpenGroupInView('group-a-member', 'workspace_admin', groupPreview), true);
  assert.equal(canOpenGroupInView('group-b', 'workspace_admin', groupPreview), false);
});

test('real group admins retain the complete server-authorized response', () => {
  const groups = [{ groupId: 'group-a' }, { groupId: 'group-b' }];
  assert.deepEqual(filterGroupsForView(groups, 'workspace_admin', null), groups);
});

test('legacy single-group preview state is migrated to a one-ID logical scope', () => {
  const legacy = {
    role: 'workspace_admin',
    groupId: 'group-a',
    groupName: 'Alpha - Admin',
  };
  assert.deepEqual(sanitizePreview('account_admin', legacy), {
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
  assert.deepEqual(sanitizePreview('account_delegate', requested), {
    role: 'workspace_admin',
    groupId: 'scope',
    groupName: 'Alpha',
    groupIds: ['group-a'],
  });
  const groups = [{ groupId: 'group-a' }, { groupId: 'group-b' }];
  assert.deepEqual(filterGroupsForView(groups, 'workspace_admin', null), groups);
});

test('email activity includes each sibling group and excludes unrelated or team alerts', () => {
  const alerts = [
    { entityType: 'group', entityId: 'group-a' },
    { entityType: 'group', entityId: 'group-a-member' },
    { entityType: 'group', entityId: 'group-b' },
    { entityType: 'team', entityId: 'group-a' },
  ];
  assert.deepEqual(filterAlertsForView(alerts, groupPreview), alerts.slice(0, 2));
  assert.deepEqual(filterAlertsForView(alerts, null), alerts);
});
