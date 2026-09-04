import { test, expect } from 'vitest';
import { buildDirectoryHierarchy } from './workspace-directory-groups';

const group = (overrides: Record<string, unknown>) => ({
  groupId: 'g1',
  groupName: 'Alpha - Member',
  workspaceId: 'w1',
  workspaceName: 'Alpha workspace',
  teamName: 'Team A',
  familyKey: 'alpha',
  familyName: 'Alpha',
  role: 'member' as const,
  isLegacy: false,
  ...overrides,
});

test('sorts workspace, team, family, and role-group levels', () => {
  const result = buildDirectoryHierarchy([
    group({ groupId: 'g3', workspaceId: 'w2', workspaceName: 'Beta', teamName: 'Zulu', familyName: 'Zulu' }),
    group({ groupId: 'g2', familyKey: 'alpha', role: 'viewer', groupName: 'Alpha - Viewer' }),
    group({ groupId: 'g1', familyKey: 'alpha', role: 'admin', groupName: 'Alpha - Admin' }),
  ]);
  expect(result.map((workspace) => workspace.workspaceName)).toEqual(['Alpha workspace', 'Beta']);
  expect(result[0]!.teams[0]!.families[0]!.groups.map((item) => item.groupName))
    .toEqual(['Alpha - Admin', 'Alpha - Viewer']);
});

test('hides legacy groups by default and includes them on request', () => {
  const groups = [group({}), group({ groupId: 'legacy', familyKey: 'old', familyName: 'Old', isLegacy: true })];
  expect(buildDirectoryHierarchy(groups)[0]!.teams[0]!.families).toHaveLength(1);
  expect(buildDirectoryHierarchy(groups, { showLegacy: true })[0]!.teams[0]!.families).toHaveLength(2);
});

test('keeps same-named families in separate workspaces', () => {
  const result = buildDirectoryHierarchy([
    group({ workspaceId: 'w1', workspaceName: 'One' }),
    group({ groupId: 'g2', workspaceId: 'w2', workspaceName: 'Two' }),
  ]);
  expect(result).toHaveLength(2);
  expect(result.map((workspace) => workspace.teams[0]!.families[0]!.familyName)).toEqual(['Alpha', 'Alpha']);
});

test('searches explicit workspace, team, family, group, and role fields', () => {
  const groups = [group({}), group({ groupId: 'g2', familyKey: 'beta', familyName: 'Beta', role: 'viewer' })];
  expect(buildDirectoryHierarchy(groups, { search: 'viewer' })[0]!.teams[0]!.families[0]!.familyName).toBe('Beta');
});