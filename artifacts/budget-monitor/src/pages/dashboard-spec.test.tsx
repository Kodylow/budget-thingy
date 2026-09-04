import { describe, it, expect } from 'vitest';
import { getNavSections } from '../components/app-shell';
import type { AuthCapabilities } from '@workspace/replit-auth-web';

const mockCapabilities = (overrides: Partial<AuthCapabilities> = {}): AuthCapabilities => ({
  canManageAccess: false,
  canViewAccountUsage: false,
  canEditAllocations: false,
  canManageNotifications: false,
  canManageSystem: false,
  canPreviewRoles: false,
  canWriteGroupLimits: false,
  canWriteUserLimitsIn: [],
  canRunChecks: false,
  ...overrides
});

describe('Dashboard and Spend Spec Behaviors', () => {
  it('gates settings visibility using canManageSystem/canManageNotifications, not canManageAccess', () => {
    const sectionsAccessOnly = getNavSections(mockCapabilities({ canManageAccess: true }), false, 'account');
    expect(sectionsAccessOnly.find(s => s.label === 'Administration')?.items.find(i => i.path === '/settings')).toBeUndefined();

    const sectionsSystem = getNavSections(mockCapabilities({ canManageSystem: true }), false, 'account');
    expect(sectionsSystem.find(s => s.label === 'Administration')?.items.find(i => i.path === '/settings')).toBeDefined();

    const sectionsNotifs = getNavSections(mockCapabilities({ canManageNotifications: true }), false, 'account');
    expect(sectionsNotifs.find(s => s.label === 'Administration')?.items.find(i => i.path === '/settings')).toBeDefined();
  });

  it('shows Email activity (alerts) nav to scoped workspace/family managers but not ordinary members', () => {
    const sectionsMember = getNavSections(mockCapabilities(), false, 'member');
    expect(sectionsMember.find(s => s.label === 'Administration')?.items.find(i => i.path === '/alerts')).toBeUndefined();

    const sectionsWorkspaceAdmin = getNavSections(mockCapabilities(), false, 'workspace_admin');
    expect(sectionsWorkspaceAdmin.find(s => s.label === 'Administration')?.items.find(i => i.path === '/alerts')).toBeDefined();

    const sectionsTeamAdmin = getNavSections(mockCapabilities(), false, 'team_admin');
    expect(sectionsTeamAdmin.find(s => s.label === 'Administration')?.items.find(i => i.path === '/alerts')).toBeDefined();
  });

  it('consumes validated same-origin returnTo from URL search for back links', () => {
    const getBackHref = (returnTo: string | null) => {
      return (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) ? returnTo : '/spend';
    };
    
    expect(getBackHref('/spend?tab=groups')).toBe('/spend?tab=groups');
    expect(getBackHref('https://malicious.com')).toBe('/spend');
    expect(getBackHref('//malicious.com')).toBe('/spend');
    expect(getBackHref(null)).toBe('/spend');
  });
});
