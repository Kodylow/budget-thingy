import { expect, test } from '@playwright/test';

const auth = (revision: string) => ({
  user: { id: 'revalidation-user', email: 'revalidation@example.test', firstName: 'Revalidation', lastName: 'Probe', profileImageUrl: null },
  auth: {
    authorizationRevision: revision, role: 'account', roles: ['account'], workspaceIds: ['ws-revalidation'],
    teamNames: [], groupIds: ['group-revalidation'], managedGroupIds: [], groupUserIds: { 'group-revalidation': ['member-revalidation'] },
    userIds: ['member-revalidation'], isPreview: false, previewReadOnly: false,
  },
  capabilities: {
    canManageAccess: true, canViewAccountUsage: true, canEditAllocations: true, canManageNotifications: true,
    canManageSystem: true, canPreviewRoles: false, canWriteGroupLimits: true, canWriteUserLimitsIn: ['ws-revalidation'],
    canRunChecks: true, canSendTestEmail: false,
  },
});

const spend = {
  view: 'groups', scope: { viewScope: 'managed', label: 'Managed usage', workspaceIds: ['ws-revalidation'], groupIds: ['group-revalidation'], isPersonal: false },
  period: { start: '2026-09-01T00:00:00Z', endExclusive: '2026-09-05T00:00:00Z', timezone: 'UTC', label: 'Sep 1–4, 2026' },
  rows: [{ id: 'group:ws-revalidation:group-revalidation', kind: 'group', name: 'Revalidation Group', workspaceId: 'ws-revalidation', workspaceName: 'Revalidation Workspace', spendUsd: 42, agentSpendUsd: 30, otherServicesUsd: 12, allocationUsd: 100, remainingUsd: 58, percentUsed: 42, status: 'budgeted', memberCount: 1, ownerName: null, limitState: 'not_applicable', limitObservationStatus: 'not_applicable', currentCycleAgentSpendUsd: null, currentCycleRemainingUsd: null, currentCyclePercentUsed: null, sharedPool: false, usageObserved: true }],
  page: 1, pageSize: 25, totalRows: 1, filteredRows: 1,
  totals: { spendUsd: 42, agentSpendUsd: 30, otherServicesUsd: 12, allocationUsd: 100, internalExcludedUsd: 0, unbudgetedUsd: 0, unattributedSpendUsd: 0, reconciliationUsd: 0 },
  facets: { statuses: { budgeted: 1 }, workspaces: [{ id: 'ws-revalidation', name: 'Revalidation Workspace', count: 1 }] },
  metadata: { generationId: 'revalidation', costBasis: 'allocation_eligible_committed', status: 'complete', dataAsOf: '2026-09-04T00:00:00Z', directoryDataAsOf: '2026-09-04T00:00:00Z', stale: false, coverage: { ratio: 1, requestedDays: 4, missingDays: [], failedWorkspaceDays: [] }, qualifications: [] },
};

test('same-revision resource 403 keeps local controls and batches one background auth check', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname === '/api/auth/user') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(auth('revalidation-r1')) });
    if (url.pathname === '/api/status') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
    if (url.pathname === '/api/spend/groups') return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(spend) });
  });
  await page.goto('/spend?tab=groups');
  await expect(page.getByText('This spend view is unavailable in your authorized scope.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sort spend' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search groups' })).toBeVisible();
  expect(requests.filter(request => request.includes('/api/spend/groups?')).length).toBeLessThanOrEqual(3);
  expect(requests.filter(request => request.includes('/api/auth/user')).length).toBeLessThanOrEqual(2);
});

test('unavailable authorization fails closed without protected resource requests', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === '/api/auth/user') {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'unavailable' }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({}) });
  });
  await page.goto('/spend?tab=groups');
  await expect(page.getByTestId('auth-unavailable')).toBeVisible();
  expect(requests.some(request => request.startsWith('/api/spend/'))).toBe(false);
});