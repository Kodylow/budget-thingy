import { describe, expect, it } from 'vitest';
import type {
  AuthAuthorization,
  AuthCapabilities,
  AuthUser,
} from '@workspace/replit-auth-web';
import { protectedAuthorizationFingerprint } from './auth-transition';

const user = { id: 'user-1' } as AuthUser;
const capabilities = {
  canManageAccess: false,
  canEditAllocations: false,
  canPreviewRoles: true,
  canWriteGroupLimits: false,
  canWriteUserLimitsIn: ['workspace-2', 'workspace-1'],
} as AuthCapabilities;
const auth = {
  role: 'workspace_admin',
  roles: ['member', 'workspace_admin'],
  workspaceIds: ['workspace-2', 'workspace-1'],
  teamNames: ['Team B', 'Team A'],
  groupIds: ['group-2', 'group-1'],
  userIds: ['user-2', 'user-1'],
  isPreview: false,
  viewScope: 'managed',
  previewReadOnly: false,
} as AuthAuthorization;

function fingerprint(overrides: Partial<Parameters<typeof protectedAuthorizationFingerprint>[0]> = {}) {
  return protectedAuthorizationFingerprint({
    availability: 'authorized',
    user,
    auth,
    capabilities,
    preview: null,
    ...overrides,
  });
}

describe('protected authorization fingerprint', () => {
  it('is stable when unordered server scope arrays are reordered', () => {
    expect(fingerprint()).toBe(fingerprint({
      auth: {
        ...auth,
        roles: [...auth.roles].reverse(),
        workspaceIds: [...auth.workspaceIds].reverse(),
        teamNames: [...auth.teamNames].reverse(),
        groupIds: [...auth.groupIds].reverse(),
        userIds: [...auth.userIds].reverse(),
      },
      capabilities: {
        ...capabilities,
        canWriteUserLimitsIn: [...capabilities.canWriteUserLimitsIn].reverse(),
      },
    }));
  });

  it.each([
    ['roles', { ...auth, roles: ['workspace_admin'] }],
    ['teamNames', { ...auth, teamNames: ['Team A'] }],
    ['workspaceIds', { ...auth, workspaceIds: ['workspace-1'] }],
    ['groupIds', { ...auth, groupIds: ['group-1'] }],
    ['userIds', { ...auth, userIds: ['user-1'] }],
    ['isPreview', { ...auth, isPreview: true }],
    ['viewScope', { ...auth, viewScope: 'my' }],
    ['previewReadOnly', { ...auth, previewReadOnly: true }],
  ] as const)('changes when effective %s authorization changes', (_field, changedAuth) => {
    expect(fingerprint({ auth: changedAuth as AuthAuthorization })).not.toBe(fingerprint());
  });

  it('changes across identity, preview, availability, and capability boundaries', () => {
    expect(fingerprint({ user: { ...user, id: 'user-2' } })).not.toBe(fingerprint());
    expect(fingerprint({ preview: 'member:user-2' })).not.toBe(fingerprint());
    expect(fingerprint({ availability: 'denied' })).not.toBe(fingerprint());
    expect(fingerprint({
      capabilities: { ...capabilities, canManageAccess: true },
    })).not.toBe(fingerprint());
  });
});