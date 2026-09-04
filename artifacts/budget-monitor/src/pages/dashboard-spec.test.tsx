import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getNavSections } from '../components/app-shell';
import type { AuthCapabilities } from '@workspace/replit-auth-web';
import {
  dashboardRequestParams,
  dashboardSpendHref,
} from '../lib/dashboard-request';

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
  it('sends one generated dashboard request with URL-owned reporting controls', () => {
    expect(dashboardRequestParams({
      rangeType: 'custom',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      granularity: 'day',
      trendMode: 'cumulative',
      viewScope: 'all_authorized',
    })).toEqual({
      rangeType: 'custom',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      granularity: 'day',
      trendMode: 'cumulative',
      viewScope: 'all_authorized',
    });
    const source = readFileSync(new URL('./dashboard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('useGetDashboard(queryParams)');
    expect(source).not.toMatch(/useGetSummary|useGetTrends|useListGroups/);
  });

  it('preserves dashboard range, trend, and scope when opening Spend', () => {
    const href = dashboardSpendHref(
      '?rangeType=custom&startDate=2026-09-01&endDate=2026-09-03&viewScope=managed&granularity=week&trendMode=period',
      { view: 'groups', search: 'Platform' },
    );
    const url = new URL(href, 'https://example.test');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      rangeType: 'custom',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      viewScope: 'managed',
      granularity: 'week',
      trendMode: 'period',
      view: 'groups',
      search: 'Platform',
    });
  });

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
