import { describe, expect, it } from 'vitest';
import {
  checkCanAccessSettings,
  checkCanPreviewRoles,
  checkCanTestEmail,
  checkIsDenied,
  checkRealIsAccountAdmin,
} from './auth-helpers';

const capabilities = {
  canManageAccess: true,
  canEditAllocations: true,
  canPreviewRoles: false,
  canWriteGroupLimits: false,
  canWriteUserLimitsIn: ['workspace-1'],
};

describe('authorization helpers', () => {
  it('recognizes only the account role as real account access', () => {
    expect(checkRealIsAccountAdmin('account')).toBe(true);
    expect(checkRealIsAccountAdmin('workspace_admin')).toBe(false);
    expect(checkRealIsAccountAdmin('team_admin')).toBe(false);
    expect(checkRealIsAccountAdmin('member')).toBe(false);
  });

  it('derives email testing from access-management capability', () => {
    expect(checkCanTestEmail(capabilities)).toBe(true);
    expect(checkCanTestEmail({ ...capabilities, canManageAccess: false })).toBe(false);
  });

  it('derives role preview only from the dedicated server capability', () => {
    expect(checkCanPreviewRoles(capabilities)).toBe(false);
    expect(checkCanPreviewRoles({ ...capabilities, canPreviewRoles: true })).toBe(true);
    expect(checkCanPreviewRoles(undefined)).toBe(false);
  });

  it('marks only authenticated users without authorization as denied', () => {
    expect(checkIsDenied(true, null)).toBe(true);
    expect(checkIsDenied(false, null)).toBe(false);
    expect(checkIsDenied(true, { role: 'member' })).toBe(false);
  });

  it('permits settings when any account-access signal is present', () => {
    expect(checkCanAccessSettings(true, false, false)).toBe(true);
    expect(checkCanAccessSettings(false, true, false)).toBe(true);
    expect(checkCanAccessSettings(false, false, true)).toBe(true);
    expect(checkCanAccessSettings(false, false, false)).toBe(false);
  });
});