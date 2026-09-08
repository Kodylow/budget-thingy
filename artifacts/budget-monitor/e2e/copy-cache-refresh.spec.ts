import { expect, test } from '@playwright/test';

const auth = {
  user: { id: 'task40-admin', email: 'task40.admin@example.test', firstName: 'Task40', lastName: 'Admin', profileImageUrl: null },
  auth: { authorizationRevision: 'task40-admin-r1', role: 'account', roles: ['account'], workspaceIds: ['task40-ws'], teamNames: ['Task40 Team'], groupIds: ['task40-group'], managedGroupIds: ['task40-group'], groupUserIds: { 'task40-group': ['task40-member'] }, userIds: ['task40-member'], isPreview: false, previewReadOnly: false },
  capabilities: { canManageAccess: true, canViewAccountUsage: true, canEditAllocations: true, canManageNotifications: true, canManageSystem: true, canPreviewRoles: true, canWriteGroupLimits: true, canWriteUserLimitsIn: ['task40-ws'], canRunChecks: true, canSendTestEmail: false },
};
const spend = {
  view: 'groups', scope: { viewScope: 'managed', label: 'Managed usage', workspaceIds: ['task40-ws'], groupIds: ['task40-group'], isPersonal: false },
  period: { start: '2026-09-01T00:00:00Z', endExclusive: '2026-09-05T00:00:00Z', timezone: 'UTC', label: 'Sep 1–4, 2026' },
  rows: [{ id: 'group:task40', kind: 'group', name: 'Synthetic Zero Group', workspaceId: 'task40-ws', workspaceName: 'Synthetic Workspace', spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0, allocationUsd: 100, remainingUsd: 100, percentUsed: 0, status: 'budgeted', memberCount: 1, ownerName: null, limitState: 'not_applicable', limitObservationStatus: 'not_applicable', currentCycleAgentSpendUsd: null, currentCycleRemainingUsd: null, currentCyclePercentUsed: null, sharedPool: false, usageObserved: true }],
  page: 1, pageSize: 25, totalRows: 1, filteredRows: 1,
  totals: { spendUsd: 0, agentSpendUsd: 0, otherServicesUsd: 0, allocationUsd: 100, internalExcludedUsd: 0, unbudgetedUsd: 0, unattributedSpendUsd: 0, reconciliationUsd: 0 },
  facets: { statuses: { budgeted: 1 }, workspaces: [{ id: 'task40-ws', name: 'Synthetic Workspace', count: 1 }] },
  metadata: { generationId: 'task40-gen', costBasis: 'allocation_eligible_committed', status: 'complete', dataAsOf: '2026-09-04T00:00:00Z', directoryDataAsOf: '2026-09-04T00:00:00Z', stale: false, coverage: { ratio: 1, requestedDays: 4, missingDays: [], failedWorkspaceDays: [] }, qualifications: [] },
};

test('cached zero survives interval refresh failure and one Retry recovers', async ({ page }) => {
  let fail = false;
  let failures = 0;
  await page.clock.install();
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/user') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(auth) });
    if (url.pathname === '/api/spend/groups') {
      if (fail && failures++ < 2) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic failure' }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(spend) });
    }
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto('/spend?tab=groups');
  await expect(page.getByText('Synthetic Zero Group')).toBeVisible();
  fail = true;
  await page.clock.runFor(62_000);
  await expect(page.getByText('Synthetic Zero Group')).toBeVisible();
  await expect(page.getByText('Couldn’t refresh data.', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(1);
  await expect(page.getByText('Could not load spend. Your filters are preserved.')).toHaveCount(0);
  await expect(page.getByText('Service unavailable', { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Synthetic Zero Group')).toBeVisible();
  await expect(page.getByText('Couldn’t refresh data.', { exact: true })).toHaveCount(0);
  expect(failures).toBe(2);
});