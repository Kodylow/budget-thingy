import { expect, test, type Page, type Route } from '@playwright/test';

type Role =
  | 'account'
  | 'workspace_admin'
  | 'team_admin'
  | 'member'
  | 'denied'
  | 'signed_out'
  | 'unavailable';

const WORKSPACE_ID = 'workspace-smoke';
const GROUP_ID = 'group-smoke';
const FAMILY_KEY = 'family-smoke';
const usageHealth = {
  status: 'complete',
  dataAsOf: '2026-09-04T00:00:00.000Z',
  coverage: {
    requestedDays: 1,
    requestedWorkspaceDays: 1,
    presentWorkspaceDays: 1,
    failedWorkspaceDays: [],
    missingWorkspaceDays: [],
    presentAccountDays: 1,
    missingAccountDays: [],
    ratio: 1,
  },
  accountWorkspaceUnreconciledUsd: 0,
};
const group = {
  groupId: GROUP_ID,
  workspaceId: WORKSPACE_ID,
  workspaceName: 'Smoke Workspace',
  name: 'Smoke Team - Member',
  familyKey: FAMILY_KEY,
  familyName: 'Smoke Team',
  role: 'member',
  isLegacy: false,
  teamName: 'Smoke Team',
  type: 'custom',
  memberCount: 1,
  rollupMemberCount: 1,
  spendUsd: 10,
  paceSpendUsd: 10,
  projectSpendUsd: 10,
  rollupSpendUsd: 10,
  budgetUsd: 100,
  budgetSource: 'app',
  remainingUsd: 90,
  percentUsed: 10,
  thresholdsFired: [],
  history: [],
  projectedSpendUsd: 20,
};
const member = {
  userId: 'member-smoke',
  username: 'smoke-member',
  email: 'smoke@example.test',
  name: 'Smoke Member',
  role: 'member',
  isDisabled: false,
  spendUsd: 10,
  aiSpendUsd: 10,
  nonAiSpendUsd: 0,
};

function capabilities(role: Role, canPreviewRoles = false) {
  const account = role === 'account';
  return {
    canManageAccess: account,
    canViewAccountUsage: account,
    canEditAllocations: account,
    canManageNotifications: account,
    canManageSystem: account,
    canPreviewRoles,
    canWriteGroupLimits: account,
    canWriteUserLimitsIn: account || role === 'workspace_admin' ? [WORKSPACE_ID] : [],
    canRunChecks: account,
    canSendTestEmail: false,
  };
}

function authEnvelope(role: Role, canPreviewRoles = false, previewAs: string | null = null) {
  if (role === 'signed_out') {
    return { user: null, auth: null, capabilities: capabilities(role) };
  }
  const user = {
    id: `${role}-smoke`,
    email: `${role}@example.test`,
    firstName: 'Route',
    lastName: 'Smoke',
    profileImageUrl: null,
  };
  if (role === 'denied') return { user, auth: null, capabilities: capabilities(role) };
  const previewRole = canPreviewRoles && previewAs
    ? previewAs.split(':', 1)[0] as Role
    : null;
  const effectiveRole = previewRole && ['workspace_admin', 'team_admin', 'member'].includes(previewRole)
    ? previewRole
    : role;
  return {
    user,
    auth: {
      role: effectiveRole,
      roles: [effectiveRole],
      workspaceIds: effectiveRole === 'workspace_admin' ? [WORKSPACE_ID] : [],
      teamNames: effectiveRole === 'team_admin' ? ['Smoke Team'] : [],
      groupIds: [GROUP_ID],
      managedGroupIds: effectiveRole === 'team_admin' ? [GROUP_ID] : [],
      groupUserIds: { [GROUP_ID]: [member.userId] },
      userIds: [member.userId],
      isPreview: effectiveRole !== role,
      previewReadOnly: effectiveRole !== role,
    },
    capabilities: {
      ...capabilities(effectiveRole, canPreviewRoles),
      canPreviewRoles,
    },
  };
}

function dashboardFixture(role: Role, url: URL, generation = 'generation-1') {
  const personal = role === 'member';
  const viewScope = personal
    ? 'my'
    : (url.searchParams.get('viewScope') ?? 'managed');
  return {
    scope: {
      viewScope,
      label: personal ? 'My usage' : viewScope === 'all_authorized' ? 'All authorized usage' : 'Managed usage',
      workspaceIds: role === 'workspace_admin' || role === 'account' ? [WORKSPACE_ID] : [],
      groupIds: [GROUP_ID],
      isPersonal: personal,
    },
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-09-05T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Sep 1–4, 2026',
    },
    cardVariant: personal ? 'personal_usage' : 'usage_analysis',
    cards: [
      { key: personal ? 'your_agent_spend' : 'spend', label: personal ? 'Your Agent spend' : 'Spend', value: 10, unit: 'usd', qualification: null },
      { key: 'agent_spend', label: 'Agent spend', value: 8, unit: 'usd', qualification: null },
      { key: 'other_services', label: 'Other services', value: 2, unit: 'usd', qualification: null },
      { key: 'members_with_spend', label: 'Members with spend', value: 1, unit: 'count', qualification: 'Known members only' },
    ],
    trend: {
      granularity: url.searchParams.get('granularity') ?? 'day',
      mode: url.searchParams.get('trendMode') ?? 'period',
      buckets: [
        { start: '2026-09-01T00:00:00.000Z', endExclusive: '2026-09-02T00:00:00.000Z', spendUsd: 10, valueUsd: 10, isPartial: false, isMissing: false },
        { start: '2026-09-02T00:00:00.000Z', endExclusive: '2026-09-03T00:00:00.000Z', spendUsd: null, valueUsd: null, isPartial: true, isMissing: true },
      ],
    },
    breakdown: [{
      id: `group:${WORKSPACE_ID}:${GROUP_ID}`,
      label: 'Smoke Team',
      spendUsd: 10,
      kind: 'group',
      drillThrough: `/spend?tab=groups&viewScope=${viewScope}&rangeType=custom&startDate=2026-09-01&endDate=2026-09-04&search=Smoke+Team`,
    }],
    accounting: {
      eligibleSpendUsd: 10,
      grossSpendUsd: 12,
      internalExcludedUsd: 2,
      unbudgetedUsd: 0,
      unattributedUsd: 0,
      reconciliationUsd: 0,
      agentSpendUsd: 8,
      otherServicesUsd: 2,
    },
    metadata: {
      generationId: generation,
      costBasis: 'allocation_eligible_committed',
      status: 'partial',
      dataAsOf: '2026-09-04T00:00:00.000Z',
      directoryDataAsOf: '2026-09-04T00:00:00.000Z',
      stale: true,
      coverage: { ratio: 0.75, requestedDays: 4, missingDays: ['2026-09-02'], failedWorkspaceDays: [] },
      qualifications: ['Partial usage coverage; missing facts are not zero.'],
      limitObservation: {
        status: 'unavailable',
        observedAt: null,
        lastSuccessfulAt: null,
        lastAttemptAt: null,
        refreshStartedAt: null,
        generation: null,
        error: null,
      },
    },
  };
}

function spendFixture(view: 'pools' | 'groups' | 'people' | 'projects', url: URL) {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '25');
  const totalRows = 125;
  const kind = view === 'pools' ? 'pool' : view === 'groups' ? 'group' : view === 'people' ? 'person' : 'project';
  const start = (page - 1) * pageSize;
  const rows = Array.from({ length: Math.min(pageSize, Math.max(0, totalRows - start)) }, (_, index) => {
    const ordinal = start + index + 1;
    return {
      id: kind === 'group'
        ? `group:${WORKSPACE_ID}:${ordinal === 1 ? GROUP_ID : `group-${ordinal}`}`
        : `${kind}:${WORKSPACE_ID}:${ordinal}`,
      kind,
      name: ordinal === 1 ? 'Smoke Team' : `${view.slice(0, -1)} ${ordinal}`,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Smoke Workspace',
      spendUsd: ordinal === 1 ? 10 : ordinal,
      agentSpendUsd: ordinal === 1 ? 8 : ordinal,
      otherServicesUsd: ordinal === 1 ? 2 : 0,
      allocationUsd: view === 'projects' ? null : 100,
      remainingUsd: view === 'projects' ? null : 90,
      percentUsed: view === 'projects' ? null : 10,
      status: view === 'pools' ? 'shared' : view === 'people' ? 'unavailable' : 'budgeted',
      memberCount: view === 'groups' ? 1 : null,
      ownerName: view === 'projects' ? 'Smoke Member' : null,
      limitState: view === 'people' ? 'unavailable' : 'not_applicable',
      limitObservationStatus: view === 'people' ? 'unavailable' : 'not_applicable',
      sharedPool: view === 'pools' && ordinal === 1,
    };
  });
  return {
    view,
    scope: {
      viewScope: url.searchParams.get('viewScope') ?? 'managed',
      label: 'Managed usage',
      workspaceIds: [WORKSPACE_ID],
      groupIds: [GROUP_ID],
      isPersonal: false,
    },
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-09-05T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Sep 1–4, 2026',
    },
    rows,
    page,
    pageSize,
    totalRows,
    filteredRows: totalRows,
    totals: {
      spendUsd: 7875,
      agentSpendUsd: 7873,
      otherServicesUsd: 2,
      allocationUsd: view === 'projects' ? 0 : 12500,
      internalExcludedUsd: 2,
      unbudgetedUsd: 0,
      unattributedUsd: 0,
      reconciliationUsd: 0,
    },
    facets: {
      statuses: { budgeted: 124, unavailable: 1 },
      workspaces: [
        { id: WORKSPACE_ID, name: 'Smoke Workspace', count: totalRows },
        { id: 'workspace-secondary', name: 'Secondary Workspace', count: 0 },
      ],
    },
    metadata: dashboardFixture('account', url).metadata,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockApi(
  page: Page,
  role: Role,
  canPreviewRoles = false,
  previewHeaders: Array<string | null> = [],
  observedRequests: string[] = [],
  rejectPreview = false,
) {
  let dashboardGeneration = 0;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    observedRequests.push(`${route.request().method()} ${path}${url.search}`);
    if (path === '/api/auth/user') {
      if (role === 'unavailable') {
        return json(route, { error: 'Authorization temporarily unavailable' }, 503);
      }
      const previewAs = route.request().headers()['x-preview-as'] ?? null;
      previewHeaders.push(previewAs);
      if (rejectPreview && previewAs) {
        return json(route, { error: 'Preview target is no longer available' }, 400);
      }
      return json(route, authEnvelope(role, canPreviewRoles, previewAs));
    }
    if (path === '/api/dashboard') {
      const previewAs = route.request().headers()['x-preview-as'] ?? null;
      const effectiveRole = previewAs?.startsWith('member:')
        ? 'member'
        : previewAs?.startsWith('team_admin:')
          ? 'team_admin'
          : previewAs?.startsWith('workspace_admin:')
            ? 'workspace_admin'
            : role;
      dashboardGeneration += 1;
      return json(route, dashboardFixture(effectiveRole, url, `generation-${dashboardGeneration}`));
    }
    const spendMatch = path.match(/^\/api\/spend\/(pools|groups|people|projects)$/);
    if (spendMatch) {
      return json(route, spendFixture(spendMatch[1] as 'pools' | 'groups' | 'people' | 'projects', url));
    }
    if (/^\/api\/spend\/(pools|groups|people|projects)\.csv$/.test(path)) {
      return route.fulfill({
        status: 200,
        contentType: 'text/csv',
        headers: { 'Content-Disposition': 'attachment; filename="spend.csv"' },
        body: '"name","spend_usd"\r\n"Smoke Team","10.00"\r\n',
      });
    }
    if (path === '/api/groups') {
      return json(route, {
        groups: [group],
        usageHealth,
        billingPeriodLabel: 'September 2026',
        unattributedProjectSpendUsd: 0,
        teamRawSpend: { 'Smoke Team': { spendUsd: 10 } },
        workspaceTeamRawSpend: [{ workspaceId: WORKSPACE_ID, teamName: 'Smoke Team', spendUsd: 10 }],
        teamBudgets: { 'Smoke Team': 100 },
      });
    }
    if (path === '/api/summary') {
      return json(route, {
        totalGroups: 1,
        budgetedGroups: 1,
        totalSpendUsd: 10,
        totalBudgetUsd: 100,
        totalRemainingUsd: 90,
        groupsOver50: 0,
        groupsOver75: 0,
        groupsOver90: 0,
        groupsOver100: 0,
        alertsSentThisPeriod: 0,
        billingPeriodLabel: 'September 2026',
        reportingRangeStart: '2026-09-01',
        reportingRangeEnd: '2026-10-01',
        billingPeriodDiffersFromReportingCutoff: false,
        pacePeriodStart: '2026-09-01',
        pacePeriodEnd: '2026-10-01',
        pacePeriodLabel: 'September 2026',
        pacePeriodIsFallback: false,
        usageHealth,
      });
    }
    if (path === '/api/trends') {
      return json(route, {
        buckets: ['2026-09-01'],
        bucketRanges: [{ start: '2026-09-01', end: '2026-09-02', isPartial: false }],
        totals: [10],
        series: [{ name: 'Smoke Team', type: 'team', data: [10] }],
        usageHealth,
      });
    }
    if (path === '/api/users/activity') {
      return json(route, {
        usageHealth,
        users: [{
          userId: member.userId,
          username: member.username,
          email: member.email,
          teamName: 'Smoke Team',
          groupName: group.name,
          spendUsd: 10,
          aiSpendUsd: 10,
          nonAiSpendUsd: 0,
          workspaceRole: 'member',
        }],
      });
    }
    if (path === '/api/teams/budgets') {
      return json(route, { budgets: [{ teamName: 'Smoke Team', amountUsd: 100, workspaceIds: [WORKSPACE_ID] }] });
    }
    if (path === '/api/directory/workspaces') {
      return json(route, [{ workspaceId: WORKSPACE_ID, workspaceName: 'Smoke Workspace', memberCount: 1 }]);
    }
    if (path === '/api/directory/members') {
      return json(route, [{
        userId: member.userId,
        username: member.username,
        name: member.name,
        email: member.email,
        isAccountAdmin: false,
        workspaces: [{
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Smoke Workspace',
          role: 'member',
          isDisabled: false,
          spendUsd: 10,
          reAttributedSpendUsd: 0,
        }],
      }]);
    }
    if (path === '/api/directory/groups') {
      return json(route, [{
        groupId: GROUP_ID,
        groupName: group.name,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        familyKey: FAMILY_KEY,
        familyName: 'Smoke Team',
        role: 'member',
        isLegacy: false,
        teamName: 'Smoke Team',
      }]);
    }
    if (path === '/api/workspace-admins') {
      return json(route, [{
        groupId: GROUP_ID,
        groupName: group.name,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        familyKey: FAMILY_KEY,
        familyName: 'Smoke Team',
        role: 'member',
        isLegacy: false,
        teamName: 'Smoke Team',
        admins: [{ userId: 'admin-smoke', username: 'smoke-admin', email: null, name: null }],
      }]);
    }
    if (path === '/api/alerts') return json(route, []);
    if (path === '/api/app-admins' || path === '/api/admins') return json(route, []);
    if (path === '/api/settings/email') {
      return json(route, { automatedEmailEnabled: false, updatedAt: '2026-09-04T00:00:00.000Z' });
    }
    if (path === '/api/status') {
      return json(route, {
        directory: { status: 'ok', message: null },
        usage: { status: 'ok', message: null },
      });
    }
    if (path === '/api/admin/team-budgets/history') return json(route, { teams: [], issues: [] });
    if (path === '/api/admin/team-budgets/audit') return json(route, { changes: [] });
    if (/^\/api\/directory\/workspaces\/[^/]+\/members$/.test(path)) {
      return json(route, {
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Smoke Workspace',
        billingPeriod: 'current',
        connector: { status: 'available', canWrite: true, error: null },
        members: [{
          userId: member.userId,
          username: member.username,
          name: member.name,
          email: member.email,
          role: 'member',
          isDisabled: false,
          budgetUsd: 100,
          usageUsd: 10,
          remainingUsd: 90,
        }],
      });
    }
    if (/^\/api\/directory\/workspaces\/[^/]+\/usage-limit-audits$/.test(path)) return json(route, []);
    const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      if (groupMatch[1] !== GROUP_ID) return json(route, { error: 'Not found' }, 404);
      return json(route, {
        group,
        members: [member],
        membersSpendUsd: 10,
        unattributedSpendUsd: 0,
        usageHealth,
        rangeLabel: 'September 2026',
      });
    }
    const groupProjectsMatch = path.match(/^\/api\/groups\/([^/]+)\/projects$/);
    if (groupProjectsMatch) {
      if (groupProjectsMatch[1] !== GROUP_ID) return json(route, { error: 'Not found' }, 404);
      return json(route, { projects: [], unattributedSpendUsd: 0, usageHealth, titlesComplete: true });
    }
    if (/^\/api\/clusters\/[^/]+\/projects$/.test(path)) {
      return path.includes(GROUP_ID)
        ? json(route, { projects: [], unattributedSpendUsd: 0, usageHealth, titlesComplete: true })
        : json(route, { error: 'Not found' }, 404);
    }
    if (/^\/api\/clusters\/[^/]+\/headline$/.test(path)) {
      return path.includes(GROUP_ID)
        ? json(route, { spendUsd: 10, usageHealth })
        : json(route, { error: 'Not found' }, 404);
    }
    return json(route, {});
  });
}

function watchBrowserFailures(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  return failures;
}

async function expectReady(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading page' })).toHaveCount(0);
}

test.describe('authenticated account route smoke', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page, 'account');
  });

  test('opens every navigation page by link and hard refresh without browser failures', async ({ page }) => {
    const failures = watchBrowserFailures(page);
    const routes = [
      ['nav-dashboard', '/', '[data-testid="text-dashboard-scope"]'],
      ['nav-spend', '/spend', 'h1:has-text("Spend details")'],
      ['nav-alerts', '/alerts', '[data-testid="text-alerts-title"]'],
      ['nav-settings', '/settings', '[data-testid="text-settings-title"]'],
      ['nav-access', '/access', 'h1:has-text("Access Management")'],
      ['nav-help', '/help', 'h1:has-text("User Guide")'],
    ] as const;

    await page.goto('/');
    await expectReady(page, '[data-testid="text-dashboard-scope"]');
    for (const [navId, path, ready] of routes) {
      await page.locator(`[data-testid="${navId}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`));
      await expectReady(page, ready);
      await page.reload();
      await expectReady(page, ready);
    }
    expect(failures).toEqual([]);
  });

  test('loads discovered dynamic routes and gives invalid URLs terminal fallbacks', async ({ page }) => {
    const failures = watchBrowserFailures(page);
    await page.goto('/');
    const discoveredGroupId = await page.evaluate(async () => {
      const response = await fetch('/api/groups');
      const body = await response.json();
      return body.groups[0].groupId as string;
    });

    await page.goto(`/groups/${discoveredGroupId}`);
    await expectReady(page, '[data-testid="page-group-detail"]');
    await page.reload();
    await expectReady(page, '[data-testid="page-group-detail"]');

    await page.goto(`/clusters?ids=${discoveredGroupId}&name=Smoke%20Team`);
    await expectReady(page, '[data-testid="page-cluster-detail"]');
    await page.reload();
    await expectReady(page, '[data-testid="page-cluster-detail"]');
    expect(failures).toEqual([]);

    await page.goto('/groups/unavailable');
    await expectReady(page, '[data-testid="group-detail-unavailable"]');
    await page.goto('/clusters?ids=unavailable&name=Unavailable');
    await expectReady(page, '[data-testid="cluster-detail-unavailable"]');
    await page.goto(`/clusters?ids=${discoveredGroupId},unavailable&name=Partial`);
    await expectReady(page, '[data-testid="cluster-detail-unavailable"]');
    expect(failures.every((failure) =>
      failure === 'console: Failed to load resource: the server responded with a status of 404 (Not Found)'
    )).toBe(true);
  });

  test('ordinary account admins do not receive builder preview controls', async ({ page }) => {
    await page.goto('/');
    await expectReady(page, '[data-testid="text-dashboard-scope"]');
    await expect(page.locator('[data-testid="rbac-preview-control"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Account admin');
  });
});

test('builder capability enters and resets a scoped preview without losing real access', async ({ page }) => {
  const previewHeaders: Array<string | null> = [];
  await mockApi(page, 'account', true, previewHeaders);
  await page.goto('/');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await expect(page.locator('[data-testid="rbac-preview-control"]')).toBeVisible();
  await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Account admin');

  await page.locator('[data-testid="select-rbac-preview"]').click();
  await page.getByText('Smoke Workspace', { exact: true }).click();
  await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Workspace admin');
  await expect(page.locator('[data-testid="button-reset-rbac-preview"]')).toBeVisible();
  expect(previewHeaders).toContain(`workspace_admin:${WORKSPACE_ID}`);

  await page.locator('[data-testid="button-reset-rbac-preview"]').click();
  await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Account admin');
  await expect(page.locator('[data-testid="button-reset-rbac-preview"]')).toHaveCount(0);
  expect(previewHeaders.at(-1)).toBeNull();

  await page.reload();
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Account admin');
});

test('invalid builder preview clears protected content and can reset to real access', async ({ page }) => {
  await mockApi(page, 'account', true, [], [], true);
  await page.goto('/');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await page.locator('[data-testid="select-rbac-preview"]').click();
  await page.getByText('Smoke Workspace', { exact: true }).click();
  await expectReady(page, '[data-testid="auth-invalid-preview"]');
  await expect(page.locator('[data-testid="text-dashboard-scope"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="nav-"]')).toHaveCount(0);
  await page.locator('[data-testid="button-reset-invalid-preview"]').click();
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Account admin');
});

test.describe('authorization route matrix', () => {
  for (const role of ['workspace_admin', 'team_admin', 'member'] as const) {
    test(`${role} sees scoped navigation and explicit account-only route states`, async ({ page }) => {
      const failures = watchBrowserFailures(page);
      await mockApi(page, role);
      await page.goto('/');
      const dashboardReady = '[data-testid="text-dashboard-scope"]';
      await expectReady(page, dashboardReady);
      await expect(page.locator('[data-testid="nav-workspace-admins"]')).toHaveCount(0);
      if (role !== 'workspace_admin') {
        await expect(page.locator('[data-testid="nav-settings"]')).toHaveCount(0);
      }
      await page.goto('/access');
      await expectReady(page, '[data-testid="access-forbidden"]');
      await page.goto('/settings');
      await expectReady(page, '[data-testid="settings-forbidden"]');
      await page.goto('/allocations');
      await expectReady(page, '[data-testid="allocations-forbidden"]');
      expect(failures).toEqual([]);
    });
  }

  test('denied users see only the access-denied gate', async ({ page }) => {
    const failures = watchBrowserFailures(page);
    await mockApi(page, 'denied');
    await page.goto('/workspace-admins');
    await expectReady(page, '[data-testid="auth-denied"]');
    await expect(page.locator('[data-testid^="nav-"]')).toHaveCount(0);
    expect(failures).toEqual([]);
  });

  test('signed-out users see only the login gate after direct refresh', async ({ page }) => {
    const failures = watchBrowserFailures(page);
    await mockApi(page, 'signed_out');
    await page.goto('/workspace-admins');
    await expectReady(page, '[data-testid="auth-signed-out"]');
    await page.reload();
    await expectReady(page, '[data-testid="auth-signed-out"]');
    expect(failures).toEqual([]);
  });
});

test('authorization unavailable never paints protected data and remains retryable', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'unavailable', false, [], observedRequests);
  await page.goto('/spend?tab=people');
  await expectReady(page, '[data-testid="auth-unavailable"]');
  await expect(page.locator('[data-testid="text-dashboard-scope"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Spend details|My usage/ })).toHaveCount(0);
  await expect(page.locator('[data-testid^="nav-"]')).toHaveCount(0);
  expect(observedRequests.some((request) => request.includes('/api/dashboard'))).toBe(false);
  expect(observedRequests.some((request) => request.includes('/api/spend/'))).toBe(false);
  await page.locator('[data-testid="button-retry-auth"]').click();
  await expect(page.locator('[data-testid="auth-unavailable"]')).toBeVisible();
});

test('dashboard and Spend keep one authorized UTC window through drill-through and back', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', false, [], observedRequests);
  await page.goto('/?rangeType=custom&startDate=2026-09-01&endDate=2026-09-04&viewScope=all_authorized');
  await expectReady(page, '[data-testid="text-dashboard-scope"]');
  await expect(page.locator('[data-testid="text-dashboard-scope"]')).toHaveText('All authorized usage');
  await expect(page.locator('[data-testid="text-dashboard-period"]')).toContainText('Sep 1–4, 2026');
  await expect(page.locator('[data-testid="status-dashboard-partial"]')).toBeVisible();
  await expect(page.locator('[data-testid="status-dashboard-stale"]')).toBeVisible();
  await expect(page.getByText('Gross Spend:')).toBeVisible();

  await page.locator(`[data-testid="link-dashboard-breakdown-group:${WORKSPACE_ID}:${GROUP_ID}"]`).click();
  await expect(page).toHaveURL(/\/spend\?.*tab=groups/);
  await expect(page.getByRole('heading', { name: 'Spend details' })).toBeVisible();
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();
  await page.getByRole('link', { name: 'Smoke Team' }).click();
  await expectReady(page, '[data-testid="page-group-detail"]');
  await page.goBack();
  await expect(page).toHaveURL(/\/spend\?.*tab=groups/);
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();

  const dashboardRequest = observedRequests.find((request) => request.includes('/api/dashboard?'));
  expect(dashboardRequest).toContain('rangeType=custom');
  expect(dashboardRequest).toContain('startDate=2026-09-01');
  expect(dashboardRequest).toContain('endDate=2026-09-04');
  const spendRequest = observedRequests.find((request) => request.includes('/api/spend/groups?'));
  expect(spendRequest).toContain('rangeType=custom');
  expect(spendRequest).toContain('startDate=2026-09-01');
  expect(spendRequest).toContain('endDate=2026-09-04');
});

test('large Spend view supports paging, density, keyboard focus, and authorized CSV', async ({ page }) => {
  const observedRequests: string[] = [];
  await mockApi(page, 'account', false, [], observedRequests);
  await page.goto('/spend?tab=groups&pageSize=100&viewScope=managed');
  await expect(page.getByText('Showing 1–100 of 125 results')).toBeVisible();
  await expect(page.locator('table')).toHaveAttribute('aria-rowcount', '126');
  await page.getByPlaceholder('Search...').focus();
  await expect(page.getByPlaceholder('Search...')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('button[role="combobox"]').filter({ hasText: 'Comfortable' })).toBeFocused();
  await page.locator('button[role="combobox"]').filter({ hasText: 'Comfortable' }).click();
  await page.getByRole('option', { name: 'Compact' }).click();
  await expect(page).toHaveURL(/density=compact/);

  const csvRequest = page.waitForRequest((request) =>
    request.url().includes('/api/spend/groups.csv'));
  await page.getByRole('button', { name: 'Export' }).click();
  const request = await csvRequest;
  const exportUrl = new URL(request.url());
  expect(exportUrl.searchParams.get('rangeType')).toBe('billing');
  expect(exportUrl.searchParams.get('viewScope')).toBe('managed');
  expect(observedRequests.some((entry) => entry.includes('/api/spend/groups.csv'))).toBe(true);
});

test('Spend remains usable at a mobile breakpoint without exposing desktop-only export', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, 'member');
  await page.goto('/spend?tab=people&pageSize=25');
  await expect(page.getByRole('heading', { name: 'My usage' })).toBeVisible();
  await expect(page.locator('[data-testid="button-open-navigation"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export' })).toBeHidden();
  await expect(page.getByText('Showing 1–25 of 125 results')).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
});