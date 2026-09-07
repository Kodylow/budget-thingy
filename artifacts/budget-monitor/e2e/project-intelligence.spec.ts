import { expect, test, type Page, type Route } from '@playwright/test';
import type { SpendProjectRow } from '@workspace/api-client-react';

// Deliberately separate from the broad navigation suite. These are browser
// contract fixtures, not claims about the live Enterprise account.
const workspaceId = 'intelligence-workspace';
const projectId = 'intelligence-project';
const ownerId = 'intelligence-owner';
const asOf = '2026-09-07T12:00:00.000Z';
const coverage = { ratio: 1, requestedDays: 7, missingDays: [], failedWorkspaceDays: [] };
const scope = {
  viewScope: 'all_authorized', label: 'All authorized usage',
  workspaceIds: [workspaceId], groupIds: [], isPersonal: false,
};
const period = {
  start: '2026-09-01T00:00:00.000Z', endExclusive: '2026-09-08T00:00:00.000Z',
  timezone: 'UTC', label: 'September 1–7, 2026',
};
const metadata = {
  generationId: 'intelligence-fixture', costBasis: 'allocation_eligible_committed',
  status: 'complete', dataAsOf: asOf, directoryDataAsOf: asOf, stale: false,
  coverage, qualifications: [],
};
const staleEvaluation = {
  evaluatedAt: asOf, staleCutoff: '2026-08-08T12:00:00.000Z',
  monthStart: '2026-09-01T00:00:00.000Z', monthEndExclusive: '2026-10-01T00:00:00.000Z',
  availability: 'complete', coverage,
};
const project: SpendProjectRow = {
  id: `project:${workspaceId}:${projectId}`, projectId, kind: 'project',
  name: 'Intelligence sample project', workspaceId, workspaceName: 'Sample Workspace',
  ownerId, ownerName: 'Sample Owner', createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z', metadataAvailability: 'complete',
  hasDeployment: true, isPublished: true, deploymentAvailability: 'complete',
  deployments: [
    { id: 'public-deployment', url: 'https://example.test/sample', privacy: 'public', status: 'running', createdAt: asOf, updatedAt: asOf },
    { id: 'private-deployment', url: 'javascript:alert(1)', privacy: 'private', status: 'stopped', createdAt: null, updatedAt: null },
  ],
  usageObserved: true, spendUsd: 42, agentSpendUsd: 30, otherServicesUsd: 12,
  currentMonthSpendUsd: 42, currentMonthUsageAvailability: 'complete',
  staleButSpending: true, status: 'unbudgeted',
  allocationUsd: null, remainingUsd: null, percentUsed: null, memberCount: null,
  limitState: 'not_applicable', limitObservationStatus: 'not_applicable', sharedPool: false,
};
const ownedWithoutSpend: SpendProjectRow = {
  ...project, id: `project:${workspaceId}:no-spend`, projectId: 'no-spend',
  name: 'Owned without spend', updatedAt: null, hasDeployment: false,
  isPublished: false, deployments: [], spendUsd: 0, agentSpendUsd: 0,
  otherServicesUsd: 0, currentMonthSpendUsd: 0, staleButSpending: false,
};

function projectsResponse(rows = [project]) {
  return {
    view: 'projects', scope, period, rows, page: 1, pageSize: 25,
    totalRows: rows.length, filteredRows: rows.length,
    totals: {
      spendUsd: 42, agentSpendUsd: 30, otherServicesUsd: 12,
      currentMonthSpendUsd: 42, allocationUsd: 0, internalExcludedUsd: 0,
      unbudgetedUsd: 42, unattributedUsd: 0, reconciliationUsd: 0,
    },
    facets: { statuses: { unbudgeted: rows.length }, workspaces: [{ id: workspaceId, name: 'Sample Workspace', count: rows.length }] },
    metadata, staleEvaluation,
  };
}

function auth(admin = true) {
  return {
    user: { id: ownerId, email: 'sample@example.test', firstName: 'Sample', lastName: 'Owner', profileImageUrl: null },
    auth: {
      authorizationRevision: `intelligence-${admin}`, role: admin ? 'account' : 'member',
      roles: [admin ? 'account' : 'member'], workspaceIds: [workspaceId],
      teamNames: [], groupIds: [], managedGroupIds: [], groupUserIds: {},
      userIds: [ownerId], isPreview: !admin, previewReadOnly: !admin,
    },
    capabilities: {
      canManageAccess: admin, canViewAccountUsage: admin, canEditAllocations: admin,
      canManageNotifications: admin, canManageSystem: admin, canPreviewRoles: false,
      canWriteGroupLimits: admin, canWriteUserLimitsIn: admin ? [workspaceId] : [],
      canRunChecks: admin, canSendTestEmail: false,
    },
  };
}

function reply(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const group = {
  workspaceId, groupId: 'admins-group', name: 'Admins', kind: 'admins',
  memberCount: 1, membershipAvailability: 'complete', dataAsOf: asOf,
};
const staleDrillThrough = `/spend?view=projects&viewScope=all_authorized&workspaceId=${workspaceId}&rangeType=mtd&staleButSpending=true`;

async function mockIntelligence(page: Page, options: { admin?: boolean; forbidden?: boolean; authState?: { admin: boolean } } = {}) {
  const requests: URL[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url);
    if (url.pathname === '/api/auth/user') return reply(route, auth(options.authState?.admin ?? options.admin ?? true));
    if (url.pathname === '/api/status') return reply(route, {
      billingPeriodStart: period.start, billingPeriodEnd: staleEvaluation.monthEndExclusive,
      billingPeriodLabel: 'September 2026',
    });
    if (url.pathname === '/api/directory/workspaces') {
      return reply(route, { workspaces: [{ id: workspaceId, name: 'Sample Workspace', slug: 'sample', memberCount: 1 }] });
    }
    if (url.pathname === '/api/spend/projects') return reply(route, projectsResponse());
    if (url.pathname === '/api/spend/people') return reply(route, {
      ...projectsResponse([]), view: 'people',
    });
    if (url.pathname === '/api/dashboard') return reply(route, {
      scope, period, metadata, cards: [], trend: { buckets: [] },
      accounting: { grossSpendUsd: 42, eligibleSpendUsd: 42 },
      projection: null, insights: null,
      staleSpend: { ...staleEvaluation, spendUsd: 42, projectCount: 1, drillThrough: staleDrillThrough },
    });
    if (url.pathname === `/api/workspaces/${workspaceId}/projects/${projectId}`) {
      return options.forbidden
        ? reply(route, { error: 'Project not found' }, 404)
        : reply(route, { scope, period, project, metadata, staleEvaluation });
    }
    if (url.pathname === `/api/users/${ownerId}/projects`) {
      return reply(route, {
        user: { userId: ownerId, name: 'Sample Owner', username: 'sample-owner', email: null },
        projects: projectsResponse([project, ownedWithoutSpend]),
      });
    }
    if (url.pathname === '/api/directory/workspace-groups') {
      return reply(route, {
        workspaces: [{ workspaceId, workspaceName: 'Sample Workspace', groups: [
          group,
          { ...group, groupId: 'empty-group', name: 'Guests', kind: 'guests', memberCount: 0 },
          { ...group, groupId: 'unknown-group', name: 'Unobserved custom', kind: 'custom', memberCount: null, membershipAvailability: 'unavailable' },
        ] }],
        availability: 'complete', dataAsOf: asOf,
      });
    }
    const groupMatch = url.pathname.match(/\/groups\/([^/]+)\/members$/);
    if (groupMatch) {
      const empty = groupMatch[1] === 'empty-group';
      return reply(route, {
        workspaceId, group: empty ? { ...group, groupId: 'empty-group', name: 'Guests', memberCount: 0 } : group,
        members: empty ? [] : [{ userId: 'unknown-id', username: null, name: null, email: null, fallbackLabel: 'Unknown member (unknown-id)' }],
        page: 1, pageSize: 25, totalMembers: empty ? 0 : 1, availability: 'complete', dataAsOf: asOf,
      });
    }
    return reply(route, {});
  });
  return requests;
}

test('project to owner navigation preserves scope and includes owned projects without spend', async ({ page }) => {
  const requests = await mockIntelligence(page);
  await page.goto(`/spend?tab=projects&viewScope=all_authorized&workspaceId=${workspaceId}&rangeType=mtd`);
  await page.getByRole('link', { name: project.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/projects/${projectId}`));
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(page.locator('a[href="https://example.test/sample"]')).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByText('running', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('stopped', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/project-detail-sample.png', fullPage: true });
  await page.getByRole('link', { name: 'Sample Owner', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/users/${ownerId}`));
  await expect(page.getByText('Owned without spend', { exact: true })).toBeVisible();
  const ownerRequest = requests.find(url => url.pathname === `/api/users/${ownerId}/projects`);
  expect(ownerRequest?.searchParams.get('workspaceId')).toBe(workspaceId);
  expect(ownerRequest?.searchParams.get('viewScope')).toBe('all_authorized');
});

test('URL-backed project filters and update sorting survive reload', async ({ page }) => {
  const requests = await mockIntelligence(page);
  await page.goto(`/spend?tab=projects&workspaceId=${workspaceId}&deployedOnly=true&staleButSpending=true&sort=updated_at_asc`);
  await expect(page.getByRole('link', { name: project.name, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: project.name, exact: true })).toBeVisible();
  const projectRequests = requests.filter(url => url.pathname === '/api/spend/projects');
  expect(projectRequests.length).toBeGreaterThanOrEqual(2);
  for (const url of projectRequests) {
    expect(url.searchParams.get('deployedOnly')).toBe('true');
    expect(url.searchParams.get('staleButSpending')).toBe('true');
    expect(url.searchParams.get('sort')).toBe('updated_at_asc');
  }
});

test('stale spend card opens the matching month-to-date project population', async ({ page }) => {
  const requests = await mockIntelligence(page);
  await page.goto(`/org-insights?workspaceId=${workspaceId}`);
  await expect(page.getByTestId('org-card-stale')).toContainText('$42.00');
  await expect(page.getByTestId('org-card-stale')).toContainText('This month');
  await page.getByRole('link', { name: 'View Stale Projects' }).click();
  const params = new URL(page.url()).searchParams;
  expect(params.get('workspaceId')).toBe(workspaceId);
  expect(params.get('staleButSpending')).toBe('true');
  expect(params.get('rangeType')).toBe('mtd');
  await expect(page.getByRole('link', { name: project.name, exact: true })).toBeVisible();
  const request = requests.find(url => url.pathname === '/api/spend/projects');
  expect(request?.searchParams.get('workspaceId')).toBe(workspaceId);
  expect(request?.searchParams.get('staleButSpending')).toBe('true');
});

test('workspace groups expand by keyboard and distinguish empty and unknown membership', async ({ page }) => {
  await mockIntelligence(page);
  await page.goto(`/access?workspaceId=${workspaceId}`);
  await expect(page.getByRole('heading', { name: 'Workspace groups' })).toBeVisible();
  const admins = page.getByRole('button', { name: /Admins/ });
  await admins.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Unknown member (unknown-id)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Guests/ }).click();
  await expect(page.getByText(/No explicit members/i)).toBeVisible();
  await expect(page.getByText('Unobserved custom', { exact: true })).toBeVisible();
});

test('member preview cannot load admin groups and forbidden project detail contains no prior metadata', async ({ page }) => {
  const requests = await mockIntelligence(page, { admin: false, forbidden: true });
  await page.goto(`/access?workspaceId=${workspaceId}`);
  await expect(page.getByRole('heading', { name: 'Workspace groups' })).toHaveCount(0);
  expect(requests.some(url => url.pathname.includes('/directory/workspace-groups'))).toBe(false);
  await page.goto(`/workspaces/${workspaceId}/projects/${projectId}?workspaceId=${workspaceId}&viewScope=my`);
  await expect(page.getByRole('heading', { name: project.name })).toHaveCount(0);
  await expect(page.locator('a[href="https://example.test/sample"]')).toHaveCount(0);
  await expect(page.getByText(/not found|unavailable|outside|access/i).first()).toBeVisible();
});

test('effective identity change removes previously visible access groups', async ({ page }) => {
  const authState = { admin: true };
  await mockIntelligence(page, { authState });
  await page.goto(`/access?workspaceId=${workspaceId}`);
  await expect(page.getByRole('heading', { name: 'Workspace groups' })).toBeVisible();
  authState.admin = false;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workspace groups' })).toHaveCount(0);
});