import { test, expect } from 'vitest';
import {
  buildGroupClusters,
  buildLogicalGroupScopes,
  higherRole,
  roleBadgeClass,
  roleLabel,
  sumAttributedRollup,
} from './group-clusters';

const base = {
  workspaceId: 'ws',
  workspaceName: 'Workspace',
  teamName: 'Team',
  familyKey: 'project',
  familyName: 'Project',
  isLegacy: false,
  memberCount: 2,
  spendLoaded: true,
  spendUsd: 60,
  rollupSpendLoaded: true,
};
const roleGroups = [
  { ...base, groupId: 'admin', name: 'opaque one', role: 'admin', rollupMemberCount: 2, rollupSpendUsd: 50 },
  { ...base, groupId: 'member', name: 'opaque two', role: 'member', rollupMemberCount: 1, rollupSpendUsd: 20 },
];

test('family rollup uses server-attributed values', () => {
  expect(sumAttributedRollup(roleGroups)).toEqual({ memberCount: 3, spendUsd: 70, spendLoaded: true });
});

test('builds and sorts families and role groups only from explicit metadata', () => {
  const [cluster] = buildGroupClusters([...roleGroups].reverse());
  expect(cluster.baseName).toBe('Project');
  expect(cluster.groupIds).toEqual(['admin', 'member']);
  expect(cluster.groupRoles).toEqual({ admin: 'admin', member: 'member' });
  expect(cluster.memberCount).toBe(3);
  expect(cluster.spendUsd).toBe(70);
});

test('logical scopes keep same-named families in separate workspaces', () => {
  const scopes = buildLogicalGroupScopes([
    ...roleGroups,
    ...roleGroups.map((item) => ({
      ...item,
      workspaceId: 'other',
      workspaceName: 'Other',
      groupId: `other-${item.groupId}`,
    })),
  ]);
  expect(scopes.map((scope) => scope.displayName)).toEqual([
    'Project · Other',
    'Project · Workspace',
  ]);
  expect(scopes.map((scope) => scope.groupIds)).toEqual([
    ['other-admin', 'other-member'],
    ['admin', 'member'],
  ]);
});

test('does not mutate API response order', () => {
  const input = [...roleGroups].reverse();

  const clusters = buildGroupClusters([
    { ...base, groupId: 'missing', name: 'Missing role', role: null, rollupMemberCount: 1, rollupSpendUsd: 10 },
    { ...base, groupId: 'unknown', name: 'Unknown role', role: 'new-role', rollupMemberCount: 1, rollupSpendUsd: 20 },
  ]);
  expect(clusters[0]?.groupRoles).toEqual({
    missing: 'unsuffixed',
    unknown: 'unsuffixed',
  });
  expect(clusters[0]?.groups.map((group) => roleLabel(group.role))).toEqual(['Group', 'Group']);
});

test('missing directory roles use the neutral group presentation', () => {
  expect(roleLabel(undefined)).toBe('Group');
  expect(roleLabel(null)).toBe('Group');
  expect(higherRole(undefined, null)).toBe('unsuffixed');
  expect(roleBadgeClass(undefined)).toContain('text-slate-500');
});
