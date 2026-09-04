import { expect, test, type Page, type Route } from '@playwright/test';

type Role = 'account' | 'workspace_admin' | 'team_admin' | 'member' | 'denied' | 'signed_out';

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
    canEditAllocations: account,
    canPreviewRoles,
    canWriteGroupLimits: account,
    canWriteUserLimitsIn: account || role === 'workspace_admin' ? [WORKSPACE_ID] : [],
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
      workspaceIds: effectiveRole === 'account' || effectiveRole === 'team_admin' || effectiveRole === 'member'
        ? []
        : [WORKSPACE_ID],
      teamNames: effectiveRole === 'team_admin' ? ['Smoke Team'] : [],
      groupIds: [GROUP_ID],
      userIds: [member.userId],
      isPreview: effectiveRole !== role,
    },
    capabilities: {
      ...capabilities(effectiveRole, canPreviewRoles),
      canPreviewRoles,
    },
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
) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/auth/user') {
      const previewAs = route.request().headers()['x-preview-as'] ?? null;
      previewHeaders.push(previewAs);
      return json(route, authEnvelope(role, canPreviewRoles, previewAs));
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
      ['nav-dashboard', '/', '[data-testid="text-dashboard-title"]'],
      ['nav-alerts', '/alerts', '[data-testid="text-alerts-title"]'],
      ['nav-trends', '/trends', 'h1:has-text("Trends")'],
      ['nav-user-guide', '/user-guide', '[data-testid="page-user-guide"]'],
      ['nav-settings', '/settings', 'h1:has-text("Settings")'],
      ['nav-workspace-admins', '/workspace-admins', '[data-testid="page-workspace-admins"]'],
      ['nav-workspace-directory', '/workspace-directory', 'h1:has-text("Workspace Directory")'],
      ['nav-team-budgets', '/team-budgets', '[data-testid="page-team-budgets"]'],
    ] as const;

    await page.goto('/');
    await expectReady(page, '[data-testid="text-dashboard-title"]');
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
    await expectReady(page, '[data-testid="text-dashboard-title"]');
    await expect(page.locator('[data-testid="rbac-preview-control"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Account admin');
  });
});

test('builder capability enters and resets a scoped preview without losing real access', async ({ page }) => {
  const previewHeaders: Array<string | null> = [];
  await mockApi(page, 'account', true, previewHeaders);
  await page.goto('/');
  await expectReady(page, '[data-testid="text-dashboard-title"]');
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
  await expectReady(page, '[data-testid="text-dashboard-title"]');
  await expect(page.locator('[data-testid="badge-role"]')).toHaveText('Account admin');
});

test.describe('authorization route matrix', () => {
  for (const role of ['workspace_admin', 'team_admin', 'member'] as const) {
    test(`${role} sees scoped navigation and explicit account-only route states`, async ({ page }) => {
      const failures = watchBrowserFailures(page);
      await mockApi(page, role);
      await page.goto('/');
      const dashboardReady = role === 'member'
        ? '[data-testid="card-member-dashboard"]'
        : '[data-testid="text-dashboard-title"]';
      await expectReady(page, dashboardReady);
      await expect(page.locator('[data-testid="nav-workspace-admins"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="nav-settings"]')).toHaveCount(0);
      await page.goto('/workspace-admins');
      await expectReady(page, '[data-testid="workspace-admins-forbidden"]');
      await page.goto('/settings');
      await expectReady(page, '[data-testid="settings-forbidden"]');
      await page.goto('/workspace-directory');
      await expectReady(page, '[data-testid="workspace-directory-forbidden"]');
      await page.goto('/team-budgets');
      await expectReady(page, '[data-testid="team-budgets-forbidden"]');
      await page.goto('/user-guide');
      await expect(page).toHaveURL(/\/$/);
      await expectReady(page, dashboardReady);
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