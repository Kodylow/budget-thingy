import { expect, test, type Page, type Route } from '@playwright/test';

const WORKSPACE_ID = 'workspace-exploration';
const GROUP_ID = 'group-exploration';

type FixtureMode = 'ready' | 'empty' | 'forbidden' | 'loading';

const metadata = {
  generationId: 'spend-exploration-1',
  costBasis: 'allocation_eligible_committed',
  status: 'complete',
  dataAsOf: '2026-09-04T00:00:00.000Z',
  directoryDataAsOf: '2026-09-04T00:00:00.000Z',
  stale: false,
  coverage: {
    ratio: 1,
    requestedDays: 4,
    missingDays: [],
    failedWorkspaceDays: [],
  },
  qualifications: [],
  limitObservation: {
    status: 'complete',
    observedAt: '2026-09-04T00:00:00.000Z',
    lastSuccessfulAt: '2026-09-04T00:00:00.000Z',
    lastAttemptAt: '2026-09-04T00:00:00.000Z',
    refreshStartedAt: null,
    generation: 'limits-1',
    error: null,
  },
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function authFixture(readOnly = false) {
  return {
    user: {
      id: 'account-exploration',
      email: 'exploration@example.test',
      firstName: 'Spend',
      lastName: 'Explorer',
      profileImageUrl: null,
    },
    auth: {
      authorizationRevision: `exploration-${readOnly}`,
      role: 'account',
      roles: ['account'],
      workspaceIds: [WORKSPACE_ID],
      teamNames: [],
      groupIds: [GROUP_ID],
      managedGroupIds: [],
      groupUserIds: { [GROUP_ID]: ['member-exploration'] },
      userIds: ['member-exploration'],
      isPreview: readOnly,
      previewReadOnly: readOnly,
    },
    capabilities: {
      canManageAccess: !readOnly,
      canViewAccountUsage: true,
      canEditAllocations: !readOnly,
      canManageNotifications: !readOnly,
      canManageSystem: !readOnly,
      canPreviewRoles: false,
      canWriteGroupLimits: !readOnly,
      canWriteUserLimitsIn: readOnly ? [] : [WORKSPACE_ID],
      canRunChecks: !readOnly,
      canSendTestEmail: false,
    },
  };
}

function spendFixture(view: string, url: URL, empty = false) {
  const page = Number(url.searchParams.get('page') || 1);
  const pageSize = Number(url.searchParams.get('pageSize') || 25);
  const kind = view === 'groups' ? 'group' : view === 'people' ? 'person' : view === 'projects' ? 'project' : 'pool';
  const row = {
    id: kind === 'group' ? `group:${WORKSPACE_ID}:${GROUP_ID}` : `${kind}:${WORKSPACE_ID}:one`,
    kind,
    name: kind === 'group' ? 'Exploration Group' : `Exploration ${kind}`,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Exploration Workspace',
    spendUsd: 42,
    agentSpendUsd: 30,
    otherServicesUsd: 12,
    allocationUsd: kind === 'project' ? null : 100,
    remainingUsd: kind === 'project' ? null : 58,
    percentUsed: kind === 'project' ? null : 42,
    status: kind === 'pool' ? 'shared' : 'budgeted',
    memberCount: kind === 'group' ? 1 : null,
    ownerName: kind === 'project' ? 'Spend Explorer' : null,
    limitState: kind === 'person' ? 'explicit' : 'not_applicable',
    limitObservationStatus: kind === 'person' ? 'complete' : 'not_applicable',
    currentCycleAgentSpendUsd: kind === 'person' ? 30 : null,
    currentCycleRemainingUsd: kind === 'person' ? 70 : null,
    currentCyclePercentUsed: kind === 'person' ? 30 : null,
    sharedPool: kind === 'pool',
    usageObserved: true,
  };
  const resultCount = empty ? 0 : 40;
  return {
    view,
    scope: {
      viewScope: url.searchParams.get('viewScope') || 'managed',
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
    rows: empty ? [] : [row],
    page,
    pageSize,
    totalRows: resultCount,
    filteredRows: resultCount,
    totals: {
      spendUsd: empty ? 0 : 42,
      agentSpendUsd: empty ? 0 : 30,
      otherServicesUsd: empty ? 0 : 12,
      allocationUsd: empty || kind === 'project' ? 0 : 100,
      internalExcludedUsd: 0,
      unbudgetedUsd: 0,
      unattributedUsd: 0,
      reconciliationUsd: 0,
    },
    facets: {
      statuses: { budgeted: resultCount },
      workspaces: [{ id: WORKSPACE_ID, name: 'Exploration Workspace', count: resultCount }],
    },
    metadata,
  };
}

function reportingDetailFixture() {
  return {
    kind: 'group',
    sourceGroups: [{
      groupId: GROUP_ID,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Exploration Workspace',
      role: 'member',
    }],
    headline: {
      familyKey: 'family-exploration',
      familyName: 'Exploration',
      spendUsd: 42,
      agentSpendUsd: 30,
      otherServicesUsd: 12,
      allocationUsd: 100,
      remainingUsd: 58,
      percentUsed: 42,
      memberCount: 1,
      membersSpendUsd: 42,
      unattributedSpendUsd: 0,
      isComplete: true,
    },
    groups: [{
      groupId: GROUP_ID,
      workspaceId: WORKSPACE_ID,
      workspaceName: 'Exploration Workspace',
      name: 'Exploration Group',
      familyKey: 'family-exploration',
      familyName: 'Exploration',
      role: 'member',
      isLegacy: false,
      memberCount: 1,
      spendUsd: 42,
      agentSpendUsd: 30,
      otherServicesUsd: 12,
      allocationUsd: 100,
      remainingUsd: 58,
      percentUsed: 42,
      sharedPool: false,
    }],
    members: [{
      workspaceId: WORKSPACE_ID,
      userId: 'member-exploration',
      username: 'spend-explorer',
      email: 'explorer@example.test',
      name: 'Spend Explorer',
      role: 'member',
      isDisabled: false,
      isInternal: false,
      groupIds: [GROUP_ID],
      spendUsd: 42,
      agentSpendUsd: 30,
      otherServicesUsd: 12,
      currentCycleAgentSpendUsd: 30,
      limitUsd: 100,
      remainingUsd: 70,
      percentUsed: 30,
      limitState: 'explicit',
      limitObservationStatus: 'complete',
    }],
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-09-05T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Sep 1–4, 2026',
    },
    metadata,
  };
}

async function mockSpendApi(
  page: Page,
  options: { mode?: FixtureMode; readOnly?: boolean; requests?: string[] } = {},
) {
  const { mode = 'ready', readOnly = false, requests = [] } = options;
  let releaseSpend: (() => void) | undefined;
  const spendGate = mode === 'loading'
    ? new Promise<void>((resolve) => { releaseSpend = resolve; })
    : undefined;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (url.pathname === '/api/auth/user') return json(route, authFixture(readOnly));
    if (url.pathname === '/api/status') {
      return json(route, {
        billingPeriodStart: '2026-09-01T00:00:00.000Z',
        billingPeriodEnd: '2026-10-01T00:00:00.000Z',
        billingPeriodLabel: 'September 2026',
        reportingRangeStart: '2026-09-01T00:00:00.000Z',
        reportingRangeEnd: '2026-09-05T00:00:00.000Z',
        reportingRangeLabel: 'September 1–4, 2026',
      });
    }
    const spendMatch = url.pathname.match(/^\/api\/spend\/(pools|groups|people|projects)$/);
    if (spendMatch) {
      if (spendGate) await spendGate;
      if (mode === 'forbidden') return json(route, { error: 'Forbidden' }, 403);
      return json(route, spendFixture(spendMatch[1], url, mode === 'empty'));
    }
    if (/^\/api\/spend\/(pools|groups|people|projects)\.csv$/.test(url.pathname)) {
      return route.fulfill({
        status: 200,
        contentType: 'text/csv',
        headers: { 'Content-Disposition': 'attachment; filename="spend.csv"' },
        body: '"name","spend_usd"\r\n"Exploration Group","42.00"\r\n',
      });
    }
    if (url.pathname === `/api/reporting/details/${GROUP_ID}`) {
      if (mode === 'forbidden') return json(route, { error: 'Forbidden' }, 403);
      return json(route, reportingDetailFixture());
    }
    if (url.pathname === `/api/groups/${GROUP_ID}/projects`) {
      return json(route, {
        projects: [],
        unattributedSpendUsd: 0,
        titlesComplete: true,
        usageHealth: { status: 'complete' },
      });
    }
    return json(route, {});
  });

  return { releaseSpend: () => releaseSpend?.() };
}

function params(page: Page) {
  return new URL(page.url()).searchParams;
}

test('debounced search follows browser Back and an obsolete timer cannot overwrite it', async ({ page }) => {
  await mockSpendApi(page);
  await page.goto('/spend?tab=groups&search=alpha');
  const search = page.getByRole('searchbox', { name: 'Search groups' });
  await expect(search).toHaveValue('alpha');
  await search.fill('bravo');
  await expect(page).toHaveURL(/search=bravo/);

  await search.fill('obsolete');
  await page.goBack();
  await expect(page).toHaveURL(/search=alpha/);
  await expect(search).toHaveValue('alpha');
  await page.waitForTimeout(400);
  expect(params(page).get('search')).toBe('alpha');
  await expect(search).toHaveValue('alpha');
});

test('changing views retains exploration scope and each view has independent required columns', async ({ page }) => {
  await mockSpendApi(page);
  await page.goto(`/spend?tab=groups&search=ops&status=budgeted&workspaceId=${WORKSPACE_ID}&sort=name_desc&columns_groups=name,spendUsd,memberCount`);

  await page.getByRole('combobox', { name: 'Spend view' }).click();
  await page.getByRole('option', { name: 'Members' }).click();
  await expect(page).toHaveURL(/tab=people/);
  for (const [key, value] of [
    ['search', 'ops'],
    ['status', 'budgeted'],
    ['workspaceId', WORKSPACE_ID],
    ['sort', 'name_desc'],
  ]) expect(params(page).get(key)).toBe(value);

  await page.getByRole('button', { name: 'Table options' }).click();
  const name = page.getByRole('menuitemcheckbox', { name: 'Member' });
  const total = page.getByRole('menuitemcheckbox', { name: 'Total spend' });
  await expect(name).toBeDisabled();
  await expect(total).toBeDisabled();
  await page.getByRole('menuitemcheckbox', { name: 'Other services' }).click();
  expect(params(page).get('columns_people')).toContain('otherServicesUsd');
  expect(params(page).get('columns_groups')).toBe('name,spendUsd,memberCount');

  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Spend view' }).click();
  await page.getByRole('option', { name: 'Groups' }).click();
  expect(params(page).get('columns_groups')).toBe('name,spendUsd,memberCount');
  expect(params(page).get('columns_people')).toContain('otherServicesUsd');
});

test('custom-range group exploration carries dates and Back to results restores the complete ledger state', async ({ page }) => {
  const requests: string[] = [];
  await mockSpendApi(page, { requests });
  const resultUrl = `/spend?tab=groups&rangeType=custom&startDate=2026-09-01&endDate=2026-09-04&search=Exploration&status=budgeted&workspaceId=${WORKSPACE_ID}&sort=name_asc&page=2&pageSize=10&density=compact&columns_groups=name,spendUsd,memberCount`;
  await page.goto(resultUrl);
  await page.getByRole('link', { name: 'Exploration Group', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/groups/${GROUP_ID}`));
  expect(params(page).get('rangeType')).toBe('custom');
  expect(params(page).get('startDate')).toBe('2026-09-01');
  expect(params(page).get('endDate')).toBe('2026-09-04');
  await expect(page.getByTestId('page-group-detail')).toBeVisible();
  const detailRequest = requests.find((request) => request.includes(`/api/reporting/details/${GROUP_ID}?`));
  expect(detailRequest).toContain('rangeType=custom');
  expect(detailRequest).toContain('startDate=2026-09-01');
  expect(detailRequest).toContain('endDate=2026-09-04');

  await page.getByTestId('link-group-detail-back').click();
  await expect(page).toHaveURL(new RegExp(resultUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  expect(Object.fromEntries(params(page))).toMatchObject({
    tab: 'groups',
    search: 'Exploration',
    status: 'budgeted',
    workspaceId: WORKSPACE_ID,
    sort: 'name_asc',
    page: '2',
    pageSize: '10',
    density: 'compact',
    columns_groups: 'name,spendUsd,memberCount',
  });
  await page.getByText('Explain this total', { exact: true }).click();
  await expect(page.getByText('All 40 filtered results, not just this page.', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'evidence/spend-exploration-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Next page' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await page.getByLabel('Spend results', { exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(240);
  await page.getByLabel('Spend results', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'evidence/spend-exploration-mobile.png' });
});

test('group Projects is URL-driven and browser Back returns to Members', async ({ page }) => {
  const requests: string[] = [];
  await mockSpendApi(page, { requests });
  await page.goto(`/groups/${GROUP_ID}?rangeType=custom&startDate=2026-09-01&endDate=2026-09-04`);
  await expect(page.getByTestId('page-group-detail')).toBeVisible();
  await page.getByTestId('tab-group-projects').click();
  await expect(page).toHaveURL(/tab=projects/);
  await expect.poll(() => requests.filter((request) => request.includes(`/api/groups/${GROUP_ID}/projects?`)).length).toBe(1);
  await page.goBack();
  await expect(page.getByTestId('tab-group-members')).toHaveAttribute('data-state', 'active');
  expect(params(page).get('tab')).toBeNull();
});

test('filtered export is scoped but excludes pagination and presentation parameters', async ({ page }) => {
  const requests: string[] = [];
  await mockSpendApi(page, { requests });
  await page.goto(`/spend?tab=groups&rangeType=custom&startDate=2026-09-01&endDate=2026-09-04&viewScope=all_authorized&search=ops&status=budgeted&workspaceId=${WORKSPACE_ID}&sort=name_asc&page=3&pageSize=10&density=compact&columns_groups=name,spendUsd`);
  await page.getByRole('button', { name: 'Table options' }).click();
  await page.getByRole('menuitem', { name: 'Export filtered CSV' }).click();
  await expect.poll(() => requests.find((request) => request.includes('/api/spend/groups.csv?'))).toBeTruthy();

  const exportRequest = requests.find((request) => request.includes('/api/spend/groups.csv?'));
  const exportParams = new URL(`http://fixture.test${exportRequest?.split(' ')[1]}`).searchParams;
  expect(Object.fromEntries(exportParams)).toMatchObject({
    rangeType: 'custom',
    startDate: '2026-09-01',
    endDate: '2026-09-04',
    viewScope: 'all_authorized',
    search: 'ops',
    status: 'budgeted',
    workspaceId: WORKSPACE_ID,
    sort: 'name_asc',
  });
  for (const key of ['page', 'pageSize', 'density', 'columns_groups']) {
    expect(exportParams.has(key)).toBe(false);
  }
  expect(requests.every((request) => request.startsWith('GET '))).toBe(true);
});

for (const scenario of ['loading', 'forbidden', 'empty'] as const) {
  test(`the exploration toolbar remains available in the ${scenario} state`, async ({ page }) => {
    const requests: string[] = [];
    const fixture = await mockSpendApi(page, { mode: scenario, requests });
    await page.goto(`/spend?tab=groups&search=kept&status=budgeted&workspaceId=${WORKSPACE_ID}`);
    await expect(page.getByRole('combobox', { name: 'Spend view' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search groups' })).toHaveValue('kept');
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Sort spend' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Table options' })).toBeVisible();
    if (scenario === 'forbidden') {
      await expect(page.getByText('This spend view is unavailable in your authorized scope.')).toBeVisible();
      await page.waitForTimeout(400);
      expect(requests.filter((request) => request.includes('/api/spend/groups?')).length).toBeLessThanOrEqual(3);
      expect(requests.filter((request) => request.includes('/api/auth/user'))).toHaveLength(2);
    } else if (scenario === 'empty') {
      await expect(page.getByText('No matching results')).toBeVisible();
    } else {
      await expect(page.locator('[data-virtual-scroll]')).toBeVisible();
      fixture.releaseSpend();
    }
    expect(params(page).get('search')).toBe('kept');
  });
}

test('read-only group detail has no Limits links and a denied detail is terminal', async ({ page }) => {
  await mockSpendApi(page, { readOnly: true });
  await page.goto(`/groups/${GROUP_ID}`);
  await expect(page.getByTestId('page-group-detail')).toBeVisible();
  await expect(page.getByRole('link', { name: /Manage limit/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Manage limits/ })).toHaveCount(0);

  await page.unrouteAll();
  await mockSpendApi(page, { mode: 'forbidden', readOnly: true });
  await page.goto(`/groups/${GROUP_ID}`);
  await expect(page.getByTestId('group-detail-unavailable')).toBeVisible();
  await expect(page.getByText('outside your authorized account scope', { exact: false })).toBeVisible();
});

test('a resource denial revalidates revoked authorization and removes protected content', async ({ page }) => {
  await mockSpendApi(page);
  await page.goto('/spend?tab=groups');
  await expect(page.getByRole('link', { name: 'Exploration Group', exact: true })).toBeVisible();
  await page.route('**/api/auth/user', (route) => json(route, { error: 'Forbidden' }, 403));
  await page.route('**/api/spend/groups?**', (route) => json(route, { error: 'Forbidden' }, 403));
  await page.getByRole('combobox', { name: 'Sort spend' }).click();
  await page.getByRole('option', { name: 'Name: A–Z' }).click();
  await expect(page.getByRole('link', { name: 'Exploration Group', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('auth-denied')).toBeVisible();
});

test('unchanged revisions preserve cached views and revision-only changes invalidate them', async ({ page }) => {
  const requests: string[] = [];
  await mockSpendApi(page, { requests });
  await page.goto('/spend?tab=people');
  await expect(page.getByText('Exploration person', { exact: true })).toBeVisible();
  const switchView = async (label: string) => {
    await page.getByRole('combobox', { name: 'Spend view' }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
  };
  let deniedRequests = 0;
  await page.route('**/api/spend/groups?**', (route) => {
    deniedRequests++;
    return json(route, { error: 'Forbidden' }, 403);
  });
  await switchView('Groups');
  await expect(page.getByText('This spend view is unavailable in your authorized scope.')).toBeVisible();
  expect(deniedRequests).toBeLessThanOrEqual(3);
  await switchView('Members');
  await expect(page.getByText('Exploration person', { exact: true })).toBeVisible();
  // A complete unchanged revision preserves successful protected query data.
  await expect.poll(() => requests.filter((request) => request.includes('/api/spend/people?')).length).toBe(1);

  // The next later 403 changes only the opaque authorization revision.
  await page.route('**/api/auth/user', (route) => json(route, {
    ...authFixture(false),
    auth: { ...authFixture(false).auth, authorizationRevision: 'exploration-revision-2' },
  }));
  await page.waitForTimeout(5100);
  await switchView('Groups');
  await expect(page.getByText('This spend view is unavailable in your authorized scope.')).toBeVisible();
  await switchView('Members');
  await expect(page.getByText('Exploration person', { exact: true })).toBeVisible();
  await expect.poll(() => requests.filter((request) => request.includes('/api/spend/people?')).length).toBe(2);

  // A further revision-only change invalidates once more; public grant arrays stay identical.
  await page.unroute('**/api/auth/user');
  await page.route('**/api/auth/user', (route) => json(route, {
    ...authFixture(false),
    auth: { ...authFixture(false).auth, authorizationRevision: 'exploration-revision-3' },
  }));
  await page.waitForTimeout(5100);
  await switchView('Groups');
  await expect(page.getByText('This spend view is unavailable in your authorized scope.')).toBeVisible();
  await switchView('Members');
  await expect(page.getByText('Exploration person', { exact: true })).toBeVisible();
  await expect.poll(() => requests.filter((request) => request.includes('/api/spend/people?')).length).toBe(3);
  expect(deniedRequests).toBeGreaterThanOrEqual(3);
  expect(deniedRequests).toBeLessThanOrEqual(9);
});

test('a slow authorization retry cannot restart the resource-denial loop', async ({ page }) => {
  const requests: string[] = [];
  await mockSpendApi(page, { mode: 'forbidden', requests });
  let authRequests = 0;
  await page.route('**/api/auth/user', async (route) => {
    authRequests++;
    if (authRequests === 2) await new Promise((resolve) => setTimeout(resolve, 5500));
    return json(route, authFixture());
  });
  await page.goto('/spend?tab=groups');
  await expect(page.getByText('This spend view is unavailable in your authorized scope.')).toBeVisible();
  await page.waitForTimeout(400);
  expect(authRequests).toBe(2);
  expect(requests.filter((request) => request.includes('/api/spend/groups?')).length).toBeLessThanOrEqual(3);
});