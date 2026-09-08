import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getNavSections } from '../components/app-shell';
import type { AuthCapabilities } from '@workspace/replit-auth-web';
import {
  dashboardRequestParams,
  dashboardReportingHref,
} from '../lib/dashboard-request';

const mockCapabilities = (overrides: Partial<AuthCapabilities> = {}): AuthCapabilities => ({
  canManageAccess: false,
  canViewAccountUsage: false,
  canEditAllocations: false,
  canManageFundingMappings: false,
  canManageNotifications: false,
  canManageSystem: false,
  canPreviewRoles: false,
  canWriteGroupLimits: false,
  canWriteUserLimitsIn: [],
  canRunChecks: false,
  ...overrides
});

describe('Dashboard reporting behaviors', () => {
  it('sends one generated dashboard request with URL-owned reporting controls', () => {
    expect(dashboardRequestParams({
      rangeType: 'billing',
      startDate: undefined,
      endDate: undefined,
      granularity: 'day',
      trendMode: 'cumulative',
      viewScope: 'all_authorized',
    })).toEqual({
      rangeType: 'billing',
      startDate: undefined,
      endDate: undefined,
      granularity: 'day',
      trendMode: 'cumulative',
      viewScope: 'all_authorized',
    });
    const source = readFileSync(new URL('./dashboard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('useGetDashboard(queryParams)');
    expect(source).not.toMatch(/useGetSummary|useGetTrends|useListGroups/);
  });

  it('preserves reporting controls without carrying obsolete scope filters', () => {
    const href = dashboardReportingHref(
      '/my-team',
      '?rangeType=billing&viewScope=managed&granularity=week&trendMode=period',
    );
    const url = new URL(href, 'https://example.test');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      rangeType: 'billing',
      granularity: 'week',
      trendMode: 'period',
    });
    expect(url.searchParams.has('viewScope')).toBe(false);
  });

  it('removes the dashboard breakdown and keeps the headline Spend navigation', () => {
    const source = readFileSync(new URL('./dashboard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onClick={navigateToReport}');
    expect(source).toContain('aria-label="Open reporting overview"');
    expect(source).not.toContain("navigateToSpend({ view: 'groups', search: item.label })");
    expect(source).not.toContain('Top budget groups by spend');
  });

  it('dashboard chart correctly parses trend modes to chart values', () => {
    const source = readFileSync(new URL('./dashboard-chart.tsx', import.meta.url), 'utf8');
    expect(source).toContain("trend.mode === 'cumulative' ? (b.valueUsd ?? null) : (b.spendUsd ?? null)");
    expect(source).toContain("Known cumulative spend · partial coverage");
    expect(source).toContain('AdminDataQualityNote');
    expect(source).toContain("coverageLabel(b)");
    expect(source).toContain('fill="#0D62FF"');
  });

  it('uses one spend headline and quiet facts without a chart options menu', () => {
    const source = readFileSync(new URL('./dashboard.tsx', import.meta.url), 'utf8');
    expect(source).toContain("const supportingFacts = cards");
    expect(source).toContain(".slice(0, 3)");
    expect(source).toContain('No summary for');
    expect(source).not.toContain('cards[0]!');
    expect(source).not.toContain('Chart options');
    expect(source).not.toContain('menu-dashboard-chart');
    expect(source).not.toContain('select-dashboard-granularity');
    expect(source).not.toContain('DashboardMetricCard');
  });

  it('keeps top snapshot badges and sends qualifications to the admin data-quality section', () => {
    const source = readFileSync(new URL('./dashboard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('status-dashboard-partial');
    expect(source).toContain('status-dashboard-stale');
    expect(source).not.toContain('status-dashboard-error');
    expect(source).not.toContain('dashboard-data-quality');
    expect(source).not.toContain('Reconciliation details');
    expect(source).not.toContain('Data details');
    expect(source).not.toContain('What needs my attention?');
    expect(source).not.toContain('Understand what drove spend');
    expect(source).not.toContain('Explore Spend');
    expect(source).toContain('metadata.qualifications');
    expect(source).toContain('card.qualification');
    expect(source).toContain('AdminDataQualityNote');
    expect(source).not.toContain('dashboard-data-qualifications');
    expect(source).not.toContain('This is an estimate for the selected horizon');
    expect(source).not.toContain('projection={isError ?');
  });

  it('dashboard range control implements narrow layout', () => {
    const source = readFileSync(new URL('../components/range-filter.tsx', import.meta.url), 'utf8');
    expect(source).toContain("min-w-0");
    expect(source).toContain("truncate");
    expect(source).toContain("max-w-[200px]");
  });

  it('gates settings visibility using canManageSystem/canManageNotifications, not canManageAccess', () => {
    const sectionsAccessOnly = getNavSections(mockCapabilities({ canManageAccess: true }), 'account');
    expect(sectionsAccessOnly.find(s => s.label === 'Management')?.items.find(i => i.path === '/settings')).toBeUndefined();

    const sectionsSystem = getNavSections(mockCapabilities({ canManageSystem: true }), 'account');
    expect(sectionsSystem.find(s => s.label === 'Management')?.items.find(i => i.path === '/settings')).toBeDefined();

    const sectionsNotifs = getNavSections(mockCapabilities({ canManageNotifications: true }), 'account');
    expect(sectionsNotifs.find(s => s.label === 'Management')?.items.find(i => i.path === '/settings')).toBeDefined();
  });

  it('shows Email activity (alerts) nav to scoped workspace/family managers but not ordinary members', () => {
    const sectionsMember = getNavSections(mockCapabilities(), 'member');
    expect(sectionsMember.find(s => s.label === 'Management')?.items.find(i => i.path === '/alerts')).toBeUndefined();

    const sectionsWorkspaceAdmin = getNavSections(mockCapabilities(), 'workspace_admin');
    expect(sectionsWorkspaceAdmin.find(s => s.label === 'Management')?.items.find(i => i.path === '/alerts')).toBeDefined();

    const sectionsTeamAdmin = getNavSections(mockCapabilities(), 'team_admin');
    expect(sectionsTeamAdmin.find(s => s.label === 'Management')?.items.find(i => i.path === '/alerts')).toBeDefined();
  });

  it('hides the Spend tab for regular members while keeping My Projects', () => {
    const items = getNavSections(mockCapabilities(), 'member').flatMap(section => section.items);
    expect(items.some(item => item.testId === 'nav-spend')).toBe(false);
    expect(items.map(item => item.testId)).toEqual(expect.arrayContaining([
      'nav-dashboard', 'nav-my-team', 'nav-my-projects',
    ]));
  });

  it.each(['member', 'workspace_admin', 'team_admin'] as const)(
    'hides account Spend for %s without the resolved capability',
    role => {
      const items = getNavSections(mockCapabilities(), role).flatMap(section => section.items);
      expect(items.some(item => item.testId === 'nav-spend')).toBe(false);
      expect(items.some(item => item.testId === 'nav-my-projects')).toBe(true);
    },
  );

  it('shows managed account reporting from the effective capability, including a scoped member such as Kody', () => {
    const items = getNavSections(
      mockCapabilities({ canViewAccountUsage: true }),
      'member',
    ).flatMap(section => section.items);
    expect(items.some(item => item.testId === 'nav-spend')).toBe(false);
    expect(items[0]).toEqual(expect.objectContaining({
      path: '/org-insights',
      testId: 'nav-org-insights',
    }));
    expect(items.some(item => item.testId === 'nav-dashboard')).toBe(false);
  });

  it.each(['account', 'workspace_admin', 'team_admin', 'member'] as const)(
    'uses the effective account-view capability rather than the %s role',
    role => {
      const withoutCapability = getNavSections(mockCapabilities(), role).flatMap(section => section.items);
      const withCapability = getNavSections(
        mockCapabilities({ canViewAccountUsage: true }),
        role,
      ).flatMap(section => section.items);
      expect(withoutCapability.some(item => item.testId === 'nav-spend')).toBe(false);
      expect(withCapability.some(item => item.testId === 'nav-spend')).toBe(false);
      expect(withoutCapability.some(item => item.testId === 'nav-org-insights')).toBe(false);
      expect(withCapability.some(item => item.testId === 'nav-org-insights')).toBe(true);
    },
  );

  it('keeps admin navigation without a Spend tab and provides Help and contact', () => {
    const sections = getNavSections(mockCapabilities({
      canViewAccountUsage: true,
      canEditAllocations: true,
      canWriteUserLimitsIn: ['workspace-1'],
    }), 'account');
    expect(sections[0].items.map(item => [item.path, item.label])).toEqual([
      ['/org-insights', 'Org Insights'],
      ['/my-team', 'My Team'],
      ['/my-projects', 'My Projects'],
      ['/allocations', 'Budget allocations'],
      ['/limits', 'Limits'],
    ]);
    expect(sections.find(s => s.label === 'Management')?.items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/alerts', label: 'Email activity' }),
      ]));
    expect(sections.flatMap(section => section.items).some(item => item.path === '/spend')).toBe(false);
    expect(sections.find(section => section.id === 'support')?.items)
      .toContainEqual(expect.objectContaining({ path: '/help', label: 'Help and contact' }));
  });

  it('shows Budget allocations to read-only account viewers without exposing it to members', () => {
    const readOnlyAccount = getNavSections(
      mockCapabilities({ canViewAccountUsage: true }),
      'account',
    );
    expect(readOnlyAccount.find(s => s.label === 'Spend monitoring')?.items)
      .toContainEqual(expect.objectContaining({
        path: '/allocations',
        label: 'Budget allocations',
      }));

    const member = getNavSections(mockCapabilities(), 'member');
    expect(member.flatMap(section => section.items).some(item => item.path === '/allocations'))
      .toBe(false);
  });

  it('shows My Team to members without widening their role from finance capabilities', () => {
    const sections = getNavSections(mockCapabilities({
      canViewAccountUsage: true,
      canEditAllocations: true,
    }), 'member');
    expect(sections[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/my-team', label: 'My Team' }),
    ]));
  });

  it('keeps Home personal while account viewers enter through Org Insights', () => {
    const source = readFileSync(new URL('./home.tsx', import.meta.url), 'utf8');
    expect(source).toContain('PersonalBudgetPanel');
    expect(source).not.toContain('TeamBudgetPanel');
    expect(source).toContain('BudgetTrajectory');
    expect(source).toContain("useGetTeamsBudgets");
    expect(source).toContain('useGetBudgetTeamReport');
    expect(source).not.toContain('auth?.teamNames');
    expect(source).not.toContain('My Organization');
    expect(source).not.toContain('all_authorized');
  });

  it('uses surviving role-safe return destinations for detail back links', () => {
    const getBackHref = (returnTo: string | null) => {
      return (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) ? returnTo : '/my-team';
    };

    expect(getBackHref('/teams/team-1')).toBe('/teams/team-1');
    expect(getBackHref('https://malicious.com')).toBe('/my-team');
    expect(getBackHref('//malicious.com')).toBe('/my-team');
    expect(getBackHref(null)).toBe('/my-team');
  });
});
