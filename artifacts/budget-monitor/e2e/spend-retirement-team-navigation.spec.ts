import { expect, test, type Page, type Route } from '@playwright/test';

const TEAM_A = 'pool:team:Platform%2FCore';
const TEAM_B = 'pool:team:Research';
const WORKSPACE_A = 'workspace-platform';
const WORKSPACE_B = 'workspace-research';
const PROJECT_ID = 'project-alpha';
const AS_OF = '2026-09-08T12:00:00.000Z';

const reporting = {
  acquisitionCoverage: 'complete',
  rosterAttributionBasis: 'current_membership',
  creatorCoverage: 'complete',
  creatorAttributionBasis: 'current_catalog',
  freshness: 'fresh',
  valueBasis: 'verified',
  comparisonsVerified: true,
};

const metadata = {
  generationId: 'retirement-e2e-generation',
  costBasis: 'allocation_eligible_committed',
  status: 'complete',
  dataAsOf: AS_OF,
  directoryDataAsOf: AS_OF,
  stale: false,
  coverage: {
    ratio: 1,
    requestedDays: 30,
    missingDays: [],
    failedWorkspaceDays: [],
  },
  qualifications: [],
  limitObservation: {
    status: 'complete',
    observedAt: AS_OF,
    lastSuccessfulAt: AS_OF,
    lastAttemptAt: AS_OF,
    refreshStartedAt: null,
    generation: 'limits-generation',
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

function auth(account = true) {
  const role = account ? 'account' : 'member';
  return {
    user: {
      id: 'retirement-user',
      email: 'retirement@example.test',
      firstName: 'Retirement',
      lastName: 'Tester',
      profileImageUrl: null,
    },
    auth: {
      authorizationRevision: `retirement-${role}`,
      role,
      roles: [role],
      workspaceIds: account ? [WORKSPACE_A, WORKSPACE_B] : [WORKSPACE_A],
      teamNames: account ? [] : ['Platform/Core'],
      groupIds: ['group-platform'],
      managedGroupIds: [],
      groupUserIds: { 'group-platform': ['retirement-user'] },
      userIds: ['retirement-user'],
      isPreview: false,
      previewReadOnly: false,
    },
    capabilities: {
      canManageAccess: account,
      canViewAccountUsage: account,
      canEditAllocations: account,
      canManageFundingMappings: account,
      canManageNotifications: account,
      canManageSystem: account,
      canPreviewRoles: false,
      canWriteGroupLimits: account,
      canWriteUserLimitsIn: account ? [WORKSPACE_A, WORKSPACE_B] : [],
      canRunChecks: account,
      canSendTestEmail: false,
    },
  };
}

function project(workspaceId = WORKSPACE_A) {
  return {
    id: `project:${workspaceId}:${PROJECT_ID}`,
    projectId: PROJECT_ID,
    kind: 'project',
    name: workspaceId === WORKSPACE_A ? 'Alpha personal project' : 'Research simulator',
    workspaceId,
    workspaceName: workspaceId === WORKSPACE_A ? 'Platform Workspace' : 'Research Workspace',
    ownerId: 'retirement-user',
    ownerName: 'Retirement Tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    metadataAvailability: 'complete',
    hasDeployment: true,
    isPublished: true,
    deploymentAvailability: 'complete',
    deployments: [],
    usageObserved: true,
    spendUsd: workspaceId === WORKSPACE_A ? 31 : 73,
    agentSpendUsd: workspaceId === WORKSPACE_A ? 25 : 61,
    otherServicesUsd: workspaceId === WORKSPACE_A ? 6 : 12,
    allocationUsd: null,
    remainingUsd: null,
    percentUsed: null,
    currentMonthSpendUsd: workspaceId === WORKSPACE_A ? 31 : 73,
    currentMonthUsageAvailability: 'complete',
    status: 'unbudgeted',
    memberCount: null,
    limitState: 'not_applicable',
    limitObservationStatus: 'not_applicable',
    sharedPool: false,
    staleButSpending: false,
  };
}

function projectTable(url: URL) {
  const row = project();
  return {
    view: 'projects',
    scope: {
      viewScope: 'my',
      label: 'My usage',
      workspaceIds: [WORKSPACE_A],
      groupIds: ['group-platform'],
      isPersonal: true,
    },
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-10-01T00:00:00.000Z',
      timezone: 'UTC',
      label: 'September 2026',
    },
    rows: url.searchParams.get('search') === 'Alpha' ? [row] : [row],
    page: Number(url.searchParams.get('page') || 1),
    pageSize: Number(url.searchParams.get('pageSize') || 25),
    totalRows: 1,
    filteredRows: 1,
    totals: {
      spendUsd: 31,
      agentSpendUsd: 25,
      otherServicesUsd: 6,
      currentMonthSpendUsd: 31,
      allocationUsd: 0,
      internalExcludedUsd: 0,
      unbudgetedUsd: 31,
      unattributedUsd: 0,
      reconciliationUsd: 0,
    },
    facets: {
      statuses: { unbudgeted: 1 },
      workspaces: [{ id: WORKSPACE_A, name: 'Platform Workspace', count: 1 }],
    },
    metadata,
    personalProjectCatalog: {
      coverage: 'complete',
      requestedWorkspaceCount: 1,
      observedWorkspaceCount: 1,
      failedWorkspaceIds: [],
    },
  };
}

function memberDashboard() {
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  return {
    scope: {
      viewScope: 'my',
      label: 'My usage',
      workspaceIds: [WORKSPACE_A],
      groupIds: ['group-platform'],
      isPersonal: true,
    },
    period: projectTable(new URL('https://fixture.test')).period,
    contractTerm: {
      start: '2026-05-20T00:00:00.000Z',
      endExclusive: '2027-05-21T00:00:00.000Z',
      timezone: 'UTC',
      label: 'Contract term',
    },
    metadata,
    cards: [{ key: 'eligible_spend', label: 'Spend', value: 31, unit: 'usd', qualification: null }],
    trend: { buckets: [] },
    accounting: { grossSpendUsd: 31, eligibleSpendUsd: 31 },
    projection: null,
    insights: {
      activeUsers: 1,
      avgSpendPerActiveUserUsd: 31,
      activeDays: 6,
      busiestDay: { date: '2026-09-07', spendUsd: 31 },
      previousPeriodSpendUsd: 26,
      changePercent: 10,
      categories: [],
      monthly: months.map((month, index) => ({
        start: `${month}-01T00:00:00.000Z`,
        endExclusive: `${index === 5 ? '2026-10' : months[index + 1]}-01T00:00:00.000Z`,
        spendUsd: 20 + index,
        agentSpendUsd: 15 + index,
        otherSpendUsd: 5,
        activeUsers: 1,
        isPartial: index === 5,
        isMissing: false,
      })),
      topSpenders: [{ id: 'retirement-user', name: 'Retirement Tester', spendUsd: 31 }],
      projectCount: 1,
    },
    staleSpend: null,
  };
}

function peopleTable() {
  const base = projectTable(new URL('https://fixture.test'));
  return {
    ...base,
    view: 'people',
    rows: [{
      id: 'person:workspace-platform:retirement-user',
      kind: 'person',
      name: 'Retirement Tester',
      workspaceId: WORKSPACE_A,
      workspaceName: 'Platform Workspace',
      userId: 'retirement-user',
      username: 'retirement',
      email: 'retirement@example.test',
      spendUsd: 31,
      agentSpendUsd: 25,
      otherServicesUsd: 6,
      allocationUsd: 100,
      remainingUsd: 75,
      percentUsed: 25,
      usageObserved: true,
      status: 'budgeted',
      memberCount: null,
      limitState: 'explicit',
      limitObservationStatus: 'complete',
      sharedPool: false,
    }],
    personalProjectCatalog: undefined,
  };
}

function orgInsights() {
  const team = (id: string, name: string, spendUsd: number) => ({
    id,
    name,
    allocationUsd: 500,
    spendUsd,
    remainingUsd: 500 - spendUsd,
    percentUsed: spendUsd / 5,
    complete: true,
    reporting,
    points: [
      { date: '2026-06-01', spendUsd: spendUsd / 4 },
      { date: '2026-07-01', spendUsd: spendUsd / 2 },
      { date: '2026-08-01', spendUsd: spendUsd * 0.75 },
      { date: '2026-09-01', spendUsd },
    ],
  });
  return {
    periodStart: '2026-05-20',
    periodEnd: '2027-05-20',
    asOf: '2026-09-08',
    complete: true,
    reporting,
    qualification: null,
    summary: {
      accountSpendUsd: 104,
      teamAllocationUsd: 1000,
      remainingUsd: 896,
      teamsOverBudget: 0,
      unassignedSpendUsd: 0,
      fundedTeamCount: 2,
      resolvedTeamCount: 2,
      unresolvedTeamCount: 0,
    },
    accountPoints: [
      { date: '2026-06-01', spendUsd: 26 },
      { date: '2026-07-01', spendUsd: 52 },
      { date: '2026-08-01', spendUsd: 78 },
      { date: '2026-09-01', spendUsd: 104 },
    ],
    teams: [
      team(TEAM_A, 'Platform/Core', 31),
      team(TEAM_B, 'Research', 73),
    ],
  };
}

function teamReport(id: string) {
  const isA = id === TEAM_A;
  const name = isA ? 'Platform/Core' : 'Research';
  const workspaceId = isA ? WORKSPACE_A : WORKSPACE_B;
  const spendUsd = isA ? 31 : 73;
  const memberName = isA ? 'Ada Platform' : 'Riley Research';
  const groupId = isA ? 'group-platform' : 'group-research';
  const member = {
    workspaceId,
    userId: isA ? 'ada-platform' : 'riley-research',
    username: isA ? 'ada' : 'riley',
    email: isA ? 'ada@example.test' : 'riley@example.test',
    name: memberName,
    role: 'member',
    isDisabled: false,
    isInternal: false,
    groupIds: [groupId],
    spendUsd,
    agentSpendUsd: spendUsd - 6,
    otherServicesUsd: 6,
    currentCycleAgentSpendUsd: spendUsd - 6,
    limitUsd: 100,
    remainingUsd: 100 - (spendUsd - 6),
    percentUsed: spendUsd - 6,
    limitState: 'explicit',
    limitObservationStatus: 'complete',
  };
  const group = {
    groupId,
    workspaceId,
    workspaceName: isA ? 'Platform Workspace' : 'Research Workspace',
    name: `${name} Members`,
    familyKey: name.toLowerCase(),
    familyName: name,
    role: 'member',
    isLegacy: false,
    memberCount: 1,
    spendUsd,
    agentSpendUsd: spendUsd - 6,
    otherServicesUsd: 6,
    allocationUsd: 500,
    remainingUsd: 500 - spendUsd,
    percentUsed: spendUsd / 5,
    sharedPool: false,
  };
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  return {
    kind: 'team',
    id,
    name,
    headline: {
      familyKey: null,
      familyName: name,
      usageObserved: true,
      spendUsd,
      agentSpendUsd: spendUsd - 6,
      otherServicesUsd: 6,
      allocationUsd: 500,
      remainingUsd: 500 - spendUsd,
      percentUsed: spendUsd / 5,
      memberCount: 1,
      membersSpendUsd: spendUsd,
      unattributedSpendUsd: 0,
      isComplete: true,
    },
    groups: [group],
    sourceGroups: [{
      groupId,
      workspaceId,
      workspaceName: group.workspaceName,
      role: 'member',
    }],
    members: [member],
    hierarchy: [{
      workspaceId,
      workspaceName: group.workspaceName,
      spendUsd,
      agentSpendUsd: spendUsd - 6,
      otherServicesUsd: 6,
      usageObserved: true,
      isComplete: true,
      memberCount: 1,
      unattributedSpendUsd: 0,
      groups: [{
        groupId,
        name: group.name,
        familyKey: group.familyKey,
        spendUsd,
        agentSpendUsd: spendUsd - 6,
        otherServicesUsd: 6,
        usageObserved: true,
        isComplete: true,
        memberCount: 1,
        unattributedSpendUsd: 0,
        members: [member],
      }],
    }],
    hierarchyUnattributedSpendUsd: 0,
    budgetTracking: {
      budgetKind: 'annual',
      workspaceCount: 1,
      periodStart: '2026-05-20',
      periodEnd: '2027-05-20',
      periodLabel: 'May 20, 2026 – May 20, 2027',
      reportingStart: '2026-05-20',
      reportingEnd: '2026-09-08',
      reportingLabel: 'Budget to date',
      asOf: '2026-09-08',
      allocationUsd: 500,
      spendUsd,
      remainingUsd: 500 - spendUsd,
      percentUsed: spendUsd / 5,
      scopeComplete: true,
      usageComplete: true,
      benchmarkEligible: true,
      comparisonsMatchBudgetWindow: true,
      qualification: null,
      reporting,
      points: [],
    },
    overview: {
      insights: {
        activeUsers: 1,
        avgSpendPerActiveUserUsd: spendUsd,
        activeDays: 6,
        busiestDay: { date: '2026-09-07', spendUsd },
        previousPeriodSpendUsd: spendUsd - 5,
        changePercent: 10,
        categories: [
          { key: 'agent', label: 'Agent', spendUsd: spendUsd - 6, activeUsers: 1 },
          { key: 'other', label: 'Other services', spendUsd: 6, activeUsers: 1 },
        ],
        monthly: months.map((month, index) => ({
          start: `${month}-01T00:00:00.000Z`,
          endExclusive: `${index === 5 ? '2026-10' : months[index + 1]}-01T00:00:00.000Z`,
          spendUsd: spendUsd - (5 - index) * 2,
          agentSpendUsd: spendUsd - (5 - index) * 2 - 6,
          otherSpendUsd: 6,
          activeUsers: 1,
          isPartial: index === 5,
          isMissing: false,
        })),
        topSpenders: [{ id: member.userId, name: memberName, spendUsd }],
        projectCount: 1,
      },
      projects: [project(workspaceId)],
      projectAttributionComplete: true,
    },
    period: {
      start: '2026-09-01T00:00:00.000Z',
      endExclusive: '2026-10-01T00:00:00.000Z',
      timezone: 'UTC',
      label: 'September 2026',
    },
    metadata,
  };
}

type ApiOptions = {
  account?: boolean;
  teamErrors?: Record<string, 403 | 404>;
};

async function interceptAllApi(page: Page, options: ApiOptions = {}) {
  const requests: URL[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', (error) => unexpected.push(`Browser error: ${error.message}`));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(url);
    if (request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/auth/user') return json(route, auth(options.account !== false));
    if (url.pathname === '/api/org-insights') return json(route, orgInsights());
    if (url.pathname === '/api/dashboard') return json(route, memberDashboard());
    if (url.pathname === '/api/spend/projects') return json(route, projectTable(url));
    if (url.pathname === '/api/spend/people') return json(route, peopleTable());
    if (url.pathname === '/api/users/ada-platform/projects') {
      return json(route, {
        user: {
          userId: 'ada-platform',
          name: 'Ada Platform',
          username: 'ada',
          email: 'ada@example.test',
        },
        projects: projectTable(url),
      });
    }
    if (url.pathname === '/api/users/retirement-user/projects') {
      return json(route, {
        user: {
          userId: 'retirement-user',
          name: 'Retirement Tester',
          username: 'retirement',
          email: 'retirement@example.test',
        },
        projects: projectTable(url),
      });
    }
    if (url.pathname === `/api/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`) {
      return json(route, {
        scope: projectTable(url).scope,
        period: projectTable(url).period,
        project: project(),
        metadata,
      });
    }
    const teamMatch = url.pathname.match(/^\/api\/reporting\/teams\/([^/]+)$/);
    if (teamMatch) {
      const id = decodeURIComponent(teamMatch[1]);
      const error = options.teamErrors?.[id];
      if (error) return json(route, { error: error === 403 ? 'Forbidden' : 'Team not found' }, error);
      if (id === TEAM_A || id === TEAM_B) return json(route, teamReport(id));
      return json(route, { error: 'Team not found' }, 404);
    }
    unexpected.push(`${request.method()} ${url.pathname}${url.search}`);
    return route.abort('blockedbyclient');
  });
  return { requests, unexpected };
}

test('retired generic Spend and Reports URLs redirect to role-safe reporting pages', async ({ page, browser }) => {
  const api = await interceptAllApi(page);

  await page.goto('/spend?rangeType=month');
  await expect(page).toHaveURL('/org-insights');
  await expect(page.getByRole('heading', { name: 'Organization Budget Overview' })).toBeVisible();

  await page.goto('/reports?rangeType=billing');
  await expect(page).toHaveURL('/org-insights');
  expect(api.unexpected).toEqual([]);

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  const memberApi = await interceptAllApi(memberPage, { account: false });
  await memberPage.goto('/spend?rangeType=month');
  await expect(memberPage).toHaveURL(/\/my-team\?rangeType=full-term/);
  await expect(memberPage.getByRole('heading', { name: 'My Team' })).toBeVisible();
  expect(memberApi.unexpected).toEqual([]);
  await memberContext.close();
});

test('personal project legacy URL opens standalone My Projects and preserves detail return', async ({ page }) => {
  const api = await interceptAllApi(page, { account: false });

  await page.goto('/spend?tab=projects&viewScope=my&search=Alpha&sort=name_asc&page=1');
  await expect(page).toHaveURL(/\/my-projects\?.*search=Alpha/);
  await expect(page.getByRole('heading', { name: 'My Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Alpha personal project' })).toBeVisible();
  const projectsRequest = api.requests.find((url) => url.pathname === '/api/spend/projects');
  expect(projectsRequest?.searchParams.get('viewScope')).toBe('my');
  expect(projectsRequest?.searchParams.get('search')).toBe('Alpha');

  await page.getByRole('link', { name: 'Alpha personal project' }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`));
  const detailRequest = api.requests.find((url) => url.pathname === `/api/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`);
  expect(detailRequest?.searchParams.get('viewScope')).toBe('my');

  await page.getByRole('link', { name: 'Retirement Tester', exact: true }).click();
  await expect(page).toHaveURL(/\/users\/retirement-user/);
  const ownerRequest = api.requests.find((url) => url.pathname === '/api/users/retirement-user/projects');
  expect(ownerRequest?.searchParams.get('viewScope')).toBe('my');
  await page.getByRole('button', { name: /back/i }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`));
  await page.getByRole('button', { name: /back/i }).click();
  await expect(page).toHaveURL(/\/my-projects\?.*search=Alpha/);
  expect(api.unexpected).toEqual([]);
});

test('Org Insights uses canonical team IDs and keeps distinct team data across refresh and history', async ({ page }) => {
  const api = await interceptAllApi(page);
  await page.goto('/org-insights');

  await page.getByRole('link', { name: 'Platform/Core', exact: true }).click();
  await expect(page).toHaveURL(`/teams/${encodeURIComponent(TEAM_A)}`);
  await expect(page.getByRole('heading', { name: 'Platform/Core', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Ada Platform', { exact: true })).toBeVisible();
  await expect(page.getByText('Alpha personal project', { exact: true })).toBeVisible();
  await expect(page.getByText('Six-month activity', { exact: true })).toBeVisible();
  await expect(page.locator('.recharts-responsive-container').first()).toBeVisible();
  await expect(page.locator('.recharts-bar-rectangle path').first()).toBeVisible();
  await page.screenshot({ path: '/tmp/selected-team-desktop.png', fullPage: true });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Platform/Core', exact: true, level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('/org-insights');
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Platform/Core', exact: true, level: 1 })).toBeVisible();

  await page.getByRole('link', { name: 'Ada Platform', exact: true }).click();
  await expect(page).toHaveURL(/\/users\/ada-platform/);
  await page.getByRole('link', { name: 'Alpha personal project', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`));
  await expect.poll(() => api.requests.some((url) => url.pathname === `/api/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`)).toBe(true);
  const scopedUserRequest = api.requests.find((url) => url.pathname === '/api/users/ada-platform/projects');
  const scopedProjectRequest = api.requests.find((url) => url.pathname === `/api/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`);
  expect(scopedUserRequest?.searchParams.get('poolId')).toBe(TEAM_A);
  expect(scopedProjectRequest?.searchParams.get('poolId')).toBe(TEAM_A);
  await page.getByRole('button', { name: /back/i }).click();
  await expect(page).toHaveURL(/\/users\/ada-platform/);
  await page.getByRole('button', { name: /back/i }).click();
  await expect(page).toHaveURL(`/teams/${encodeURIComponent(TEAM_A)}`);

  await Promise.all([
    page.waitForRequest((request) => decodeURIComponent(new URL(request.url()).pathname).endsWith(`/reporting/teams/${TEAM_A}`)),
    page.getByRole('button', { name: 'Refresh data' }).click(),
  ]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Platform/Core', exact: true, level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Alpha personal project', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspaces/${WORKSPACE_A}/projects/${PROJECT_ID}`));
  await page.getByRole('button', { name: /back/i }).click();
  await expect(page).toHaveURL(`/teams/${encodeURIComponent(TEAM_A)}`);
  await page.getByRole('link', { name: 'Org Insights', exact: true }).click();
  await expect(page).toHaveURL('/org-insights');
  await page.getByRole('link', { name: 'Research', exact: true }).click();
  await expect(page).toHaveURL(`/teams/${encodeURIComponent(TEAM_B)}`);
  await expect(page.getByRole('heading', { name: 'Research', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText('Riley Research', { exact: true })).toBeVisible();
  await expect(page.getByText('Research simulator', { exact: true })).toBeVisible();

  const teamRequests = api.requests.filter((url) => url.pathname.startsWith('/api/reporting/teams/'));
  expect(teamRequests.some((url) => decodeURIComponent(url.pathname.split('/').pop()!) === TEAM_A)).toBe(true);
  expect(teamRequests.some((url) => decodeURIComponent(url.pathname.split('/').pop()!) === TEAM_B)).toBe(true);
  expect(api.unexpected).toEqual([]);
});

test('unknown and forbidden canonical teams show explicit errors without broad fallback requests', async ({ page }) => {
  const forbidden = 'pool:team:Forbidden';
  const api = await interceptAllApi(page, { teamErrors: { [forbidden]: 403 } });

  await page.goto(`/teams/${encodeURIComponent('pool:team:Unknown')}`);
  await expect(page.getByText(/unable|unavailable|not found|outside|access/i).first()).toBeVisible();
  await expect(page).toHaveURL(`/teams/${encodeURIComponent('pool:team:Unknown')}`);

  await page.goto(`/teams/${encodeURIComponent(forbidden)}`);
  await expect(page.getByText(/forbidden|access|unable|unavailable/i).first()).toBeVisible();
  await expect(page).toHaveURL(`/teams/${encodeURIComponent(forbidden)}`);
  expect(api.requests.some((url) => url.pathname === '/api/dashboard')).toBe(false);
  expect(api.requests.some((url) => url.pathname === '/api/org-insights')).toBe(false);
  expect(api.unexpected).toEqual([]);
});

test('selected team overview does not overflow a compact mobile viewport', async ({ page }) => {
  const api = await interceptAllApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/teams/${encodeURIComponent(TEAM_A)}`);
  await expect(page.getByRole('heading', { name: 'Platform/Core', exact: true, level: 1 })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: '/tmp/selected-team-mobile.png', fullPage: true });
  expect(api.unexpected).toEqual([]);
});