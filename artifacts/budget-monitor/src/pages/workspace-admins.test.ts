import { describe, expect, it } from 'vitest';
import { normalizeWorkspaceAdminFamilies } from './workspace-admins';

describe('normalizeWorkspaceAdminFamilies', () => {
  it('preserves complete records and nullable directory fields', () => {
    expect(normalizeWorkspaceAdminFamilies([{
      workspaceId: 'workspace-1',
      workspaceName: 'Growth',
      familyKey: 'team-growth',
      familyName: 'Growth Team',
      teamName: null,
      isLegacy: false,
      admins: [{
        userId: 'user-1',
        username: 'admin',
        email: null,
        name: null,
      }],
    }])).toEqual([{
      workspaceId: 'workspace-1',
      workspaceName: 'Growth',
      familyKey: 'team-growth',
      familyName: 'Growth Team',
      teamName: null,
      isLegacy: false,
      admins: [{
        userId: 'user-1',
        username: 'admin',
        email: null,
        name: null,
      }],
    }]);
  });

  it('returns a stable empty result for absent or malformed response roots', () => {
    expect(normalizeWorkspaceAdminFamilies(undefined)).toEqual([]);
    expect(normalizeWorkspaceAdminFamilies({ error: 'unavailable' })).toEqual([]);
    expect(normalizeWorkspaceAdminFamilies([])).toEqual([]);
  });

  it('makes incomplete family and admin records safe to search, sort, and render', () => {
    const [family] = normalizeWorkspaceAdminFamilies([{
      workspaceId: null,
      workspaceName: null,
      familyKey: undefined,
      familyName: 12,
      admins: [{ userId: null, username: undefined }, null],
    }]);

    expect(family).toMatchObject({
      workspaceId: 'unknown-workspace-1',
      workspaceName: 'Unknown workspace',
      familyKey: 'unknown-family-1',
      familyName: 'Unnamed family',
      teamName: null,
      isLegacy: false,
    });
    expect(family?.admins).toEqual([{
      userId: 'unknown-workspace-1-unknown-family-1-admin-1',
      username: 'Unknown',
      email: null,
      name: null,
    }]);

    expect(() => {
      family?.workspaceName.localeCompare('Other');
      family?.familyName.toLowerCase();
      family?.admins.some((admin) => admin.username.toLowerCase().includes('unknown'));
    }).not.toThrow();
  });

  it('drops non-object records without rejecting usable directory entries', () => {
    const result = normalizeWorkspaceAdminFamilies([
      null,
      'bad',
      { workspaceId: 'workspace-1', familyKey: 'family-1', admins: 'bad' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.admins).toEqual([]);
  });
});