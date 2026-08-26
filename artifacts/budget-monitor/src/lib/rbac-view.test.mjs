import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canOpenGroupInView,
  canUseRbacPreview,
  filterGroupsForView,
  sanitizePreview,
} from './rbac-view.ts';

const groupPreview = {
  role: 'workspace_admin',
  groupId: 'group-a',
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

test('group-admin preview narrows visible groups and direct navigation', () => {
  const groups = [{ groupId: 'group-a' }, { groupId: 'group-b' }];
  assert.deepEqual(
    filterGroupsForView(groups, 'workspace_admin', groupPreview),
    [{ groupId: 'group-a' }],
  );
  assert.equal(canOpenGroupInView('group-a', 'workspace_admin', groupPreview), true);
  assert.equal(canOpenGroupInView('group-b', 'workspace_admin', groupPreview), false);
});

test('real group admins retain the complete server-authorized response', () => {
  const groups = [{ groupId: 'group-a' }, { groupId: 'group-b' }];
  assert.deepEqual(filterGroupsForView(groups, 'workspace_admin', null), groups);
});