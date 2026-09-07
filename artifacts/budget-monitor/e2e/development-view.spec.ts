import { expect, test, type Page, type Route } from '@playwright/test';

type DevelopmentUser = {
  userId: string;
  name: string | null;
  username: string | null;
  email: string | null;
};

const users: DevelopmentUser[] = [
  { userId: 'user-alpha', name: 'Alice Alpha', username: 'aalpha', email: 'alice@example.test' },
  { userId: 'user-beta', name: 'Bob Beta', username: 'budgetbob', email: 'bob@example.test' },
  { userId: 'user-gamma', name: 'Carol Gamma', username: 'cgamma', email: 'carol@example.test' },
];

const selectionKey = 'budget-monitor:development-view-user';

function authEnvelope(userId: string) {
  const user = users.find(candidate => candidate.userId === userId)
    ?? { userId, name: userId, username: null, email: `${userId}@example.test` };
  const account = userId !== 'user-beta';
  const role = account ? 'account' : 'member';
  return {
    user: {
      id: user.userId,
      email: user.email,
      firstName: user.name?.split(' ')[0] ?? null,
      lastName: user.name?.split(' ').slice(1).join(' ') || null,
      profileImageUrl: null,
    },
    auth: {
      authorizationRevision: `development-${userId}`,
      role,
      roles: [role],
      workspaceIds: account ? [] : ['ws-development'],
      teamNames: [],
      groupIds: ['group-development'],
      managedGroupIds: [],
      groupUserIds: { 'group-development': [userId] },
      userIds: [userId],
      isPreview: true,
      previewReadOnly: true,
    },
    capabilities: {
      canManageAccess: account,
      canViewAccountUsage: account,
      canEditAllocations: false,
      canManageNotifications: false,
      canManageSystem: false,
      canPreviewRoles: false,
      canWriteGroupLimits: false,
      canWriteUserLimitsIn: [],
      canRunChecks: false,
      canSendTestEmail: false,
    },
  };
}

const signedOutEnvelope = {
  user: null,
  auth: null,
  capabilities: {
    canManageAccess: false,
    canViewAccountUsage: false,
    canEditAllocations: false,
    canManageNotifications: false,
    canManageSystem: false,
    canPreviewRoles: false,
    canWriteGroupLimits: false,
    canWriteUserLimitsIn: [],
    canRunChecks: false,
    canSendTestEmail: false,
  },
};

function spendFixture(userId: string) {
  const identity = users.find(user => user.userId === userId)?.name ?? userId;
  return {
    view: 'groups',
    scope: {
      viewScope: 'managed',
      label: 'Managed usage',
      workspaceIds: ['ws-development'],
      groupIds: ['group-development'],
      isPersonal: false,
    },
    period: {
      start: '2026-09-01T00:00:00Z',
      endExclusive: '2026-09-05T00:00:00Z',
      timezone: 'UTC',
      label: 'Sep 1–4, 2026',
    },
    rows: [{
      id: `group:${userId}`,
      kind: 'group',
      name: `${identity} protected spend`,
      workspaceId: 'ws-development',
      workspaceName: 'Development Workspace',
      spendUsd: 42,
      agentSpendUsd: 30,
      otherServicesUsd: 12,
      allocationUsd: 100,
      remainingUsd: 58,
      percentUsed: 42,
      status: 'budgeted',
      memberCount: 1,
      ownerName: null,
      limitState: 'not_applicable',
      limitObservationStatus: 'not_applicable',
      currentCycleAgentSpendUsd: null,
      currentCycleRemainingUsd: null,
      currentCyclePercentUsed: null,
      sharedPool: false,
      usageObserved: true,
    }],
    page: 1,
    pageSize: 25,
    totalRows: 1,
    filteredRows: 1,
    totals: {
      spendUsd: 42,
      agentSpendUsd: 30,
      otherServicesUsd: 12,
      allocationUsd: 100,
      internalExcludedUsd: 0,
      unbudgetedUsd: 0,
      unattributedSpendUsd: 0,
      reconciliationUsd: 0,
    },
    facets: {
      statuses: { budgeted: 1 },
      workspaces: [{ id: 'ws-development', name: 'Development Workspace', count: 1 }],
    },
    metadata: {
      generationId: `development-${userId}`,
      costBasis: 'allocation_eligible_committed',
      status: 'complete',
      dataAsOf: '2026-09-04T00:00:00Z',
      directoryDataAsOf: '2026-09-04T00:00:00Z',
      stale: false,
      coverage: { ratio: 1, requestedDays: 4, missingDays: [], failedWorkspaceDays: [] },
      qualifications: [],
    },
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installDevelopmentApi(
  page: Page,
  directory: DevelopmentUser[] = users,
) {
  const authHeaders: string[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/dev-view') {
      return fulfillJson(route, { enabled: true, users: directory });
    }
    const selected = await route.request().headerValue('x-dev-view-as');
    if (url.pathname === '/api/auth/user') {
      authHeaders.push(selected ?? '');
      return fulfillJson(route, selected ? authEnvelope(selected) : signedOutEnvelope);
    }
    if (url.pathname === '/api/status') return fulfillJson(route, {});
    return fulfillJson(route, spendFixture(selected ?? 'missing-development-user'));
  });
  return authHeaders;
}

async function chooseUser(page: Page, name: string) {
  await page.getByTestId('dev-view-chip').click();
  await page.getByRole('option', { name: new RegExp(name) }).click();
}

test('starts signed out, previews only after selection, and exits without a stale header', async ({ page }) => {
  const authHeaders = await installDevelopmentApi(page);

  await page.goto('/help');

  await expect(page.getByTestId('auth-signed-out')).toBeVisible();
  await expect(page.getByTestId('button-login')).toBeVisible();
  await expect(page.getByTestId('dev-view-chip')).toContainText('Preview as a person');
  expect(await page.evaluate(key => sessionStorage.getItem(key), selectionKey)).toBeNull();
  expect(authHeaders.some(Boolean)).toBe(false);

  await chooseUser(page, 'Alice Alpha');
  await expect(page.getByTestId('auth-signed-out')).toHaveCount(0);
  await expect(page.getByTestId('dev-view-chip')).toContainText('Alice Alpha');
  await expect.poll(() => authHeaders.at(-1)).toBe('user-alpha');

  await page.getByTestId('dev-view-chip').click();
  await page.getByTestId('button-exit-dev-view').click();
  await expect(page.getByTestId('auth-signed-out')).toBeVisible();
  await expect.poll(() => authHeaders.at(-1)).toBe('');
  expect(await page.evaluate(key => sessionStorage.getItem(key), selectionKey)).toBeNull();
});

test('retains the selected identity across navigation and reload', async ({ page }) => {
  const authHeaders = await installDevelopmentApi(page);
  await page.addInitScript(key => {
    if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, 'user-alpha');
  }, selectionKey);
  await page.goto('/help');
  await chooseUser(page, 'Carol Gamma');
  await expect(page.getByTestId('dev-view-chip')).toContainText('Carol Gamma');

  await page.goto('/does-not-exist');
  await expect(page.getByTestId('dev-view-chip')).toContainText('Carol Gamma');
  await expect(page.getByTestId('nav-org-insights')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('dev-view-chip')).toContainText('Carol Gamma');
  expect(await page.evaluate(key => sessionStorage.getItem(key), selectionKey)).toBe('user-gamma');
  expect(authHeaders.filter(Boolean).every(value => users.some(user => user.userId === value))).toBe(true);
  expect(authHeaders.at(-1)).toBe('user-gamma');
});

test('supports searchable keyboard and mobile chip interactions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(key => sessionStorage.setItem(key, 'user-alpha'), selectionKey);
  await installDevelopmentApi(page);
  await page.goto('/help');

  const chip = page.getByTestId('dev-view-chip');
  await chip.focus();
  await page.keyboard.press('Enter');
  const search = page.getByPlaceholder('Search name, username, or email');
  await search.fill('Carol');
  await expect(page.getByRole('option', { name: /Carol Gamma/ })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await search.fill('budgetbob');
  await expect(page.getByRole('option', { name: /Bob Beta/ })).toBeVisible();
  await search.fill('alice@example.test');
  await expect(page.getByRole('option', { name: /Alice Alpha/ })).toBeVisible();
  await search.fill('nobody-here');
  await expect(page.getByText('No matches', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByRole('option')).toHaveCount(users.length);
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();

  await chip.click();
  await page.getByRole('button', { name: 'Close view-as menu' }).click();
  await expect(search).toBeHidden();
  await expect(chip).toBeInViewport();
});

test('drops deferred authorization and protected responses during rapid switches', async ({ page }) => {
  await page.addInitScript(key => sessionStorage.setItem(key, 'user-alpha'), selectionKey);
  let releaseFirstBetaAuth!: () => void;
  const firstBetaAuthWaiting = new Promise<void>(resolve => { releaseFirstBetaAuth = resolve; });
  let firstBetaAuthStarted!: () => void;
  const sawFirstBetaAuth = new Promise<void>(resolve => { firstBetaAuthStarted = resolve; });
  let betaAuthRequests = 0;
  let releaseBetaSpend!: () => void;
  const betaSpendWaiting = new Promise<void>(resolve => { releaseBetaSpend = resolve; });
  let betaSpendStarted!: () => void;
  const sawBetaSpend = new Promise<void>(resolve => { betaSpendStarted = resolve; });

  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/dev-view') {
      return fulfillJson(route, { enabled: true, users });
    }
    const selected = await route.request().headerValue('x-dev-view-as');
    if (url.pathname === '/api/auth/user') {
      if (!selected) return fulfillJson(route, signedOutEnvelope);
      if (selected === 'user-beta' && ++betaAuthRequests === 1) {
        firstBetaAuthStarted();
        await firstBetaAuthWaiting;
      }
      try {
        return await fulfillJson(route, authEnvelope(selected));
      } catch {
        // Switching identities is expected to abort an obsolete auth request.
        return;
      }
    }
    if (url.pathname === '/api/status') return fulfillJson(route, {});
    if (selected === 'user-beta') {
      betaSpendStarted();
      await betaSpendWaiting;
    }
    try {
      return await fulfillJson(route, spendFixture(selected ?? 'missing-development-user'));
    } catch {
      // Switching identities is expected to abort an obsolete protected request.
    }
  });

  await page.goto('/spend?tab=groups');
  await expect(page.getByText('Alice Alpha protected spend')).toBeVisible();
  await chooseUser(page, 'Bob Beta');
  await sawFirstBetaAuth;
  await chooseUser(page, 'Carol Gamma');
  releaseFirstBetaAuth();
  await expect(page.getByText('Carol Gamma protected spend')).toBeVisible();

  await chooseUser(page, 'Bob Beta');
  await sawBetaSpend;
  await chooseUser(page, 'Carol Gamma');
  await expect(page.getByText('Carol Gamma protected spend')).toBeVisible();
  releaseBetaSpend();
  await expect(page.getByText('Bob Beta protected spend')).toHaveCount(0);
  await expect(page.getByText('Alice Alpha protected spend')).toHaveCount(0);
});

test('recovers from directory outage, empty directory, and an invalid retained selection', async ({ page }) => {
  let directoryAttempt = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/dev-view') {
      directoryAttempt += 1;
      if (directoryAttempt === 1) {
        return fulfillJson(route, { enabled: true, error: 'directory offline' }, 503);
      }
      if (directoryAttempt === 2) {
        return fulfillJson(route, { enabled: true, users: [] });
      }
      return fulfillJson(route, { enabled: true, users });
    }
    const selected = await route.request().headerValue('x-dev-view-as');
    if (url.pathname === '/api/auth/user') {
      if (!selected) {
        return fulfillJson(route, signedOutEnvelope);
      }
      if (selected === 'removed-user') {
        return fulfillJson(route, { error: 'Invalid development identity' }, 400);
      }
      return fulfillJson(route, authEnvelope(selected));
    }
    return fulfillJson(route, {});
  });
  await page.addInitScript(key => sessionStorage.setItem(key, 'removed-user'), selectionKey);
  await page.goto('/help');

  await page.getByTestId('dev-view-chip').click();
  await expect(page.getByRole('alert')).toContainText('development directory is unavailable');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No enabled users');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('option', { name: /Alice Alpha/ })).toBeVisible();
  await page.getByRole('option', { name: /Alice Alpha/ }).click();
  await expect(page.getByTestId('dev-view-chip')).toContainText('Alice Alpha');
  await expect(page.getByTestId('auth-development-recovery')).toHaveCount(0);
});

test('keeps OAuth navigation headerless while development preview is available', async ({ page }) => {
  let loginHeader: string | null | undefined;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/dev-view') {
      return fulfillJson(route, { enabled: true, users });
    }
    if (url.pathname === '/api/auth/user') {
      return fulfillJson(route, signedOutEnvelope);
    }
    if (url.pathname === '/api/login') {
      loginHeader = await route.request().headerValue('x-dev-view-as');
      return fulfillJson(route, { reached: true });
    }
    return fulfillJson(route, {});
  });

  await page.goto('/help');
  await page.getByTestId('button-login').click();
  await expect.poll(() => loginHeader).toBeNull();
});

test('keeps the chip available on a forbidden route', async ({ page }) => {
  await page.addInitScript(key => sessionStorage.setItem(key, 'user-beta'), selectionKey);
  await installDevelopmentApi(page);
  await page.goto('/access');

  await expect(page.getByTestId('access-forbidden')).toBeVisible();
  await expect(page.getByTestId('dev-view-chip')).toContainText('Bob Beta');
  await expect(page.getByTestId('nav-org-insights')).toHaveCount(0);
});

test('uses normal signed-out login and no chip when development mode is disabled', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/dev-view') {
      return fulfillJson(route, { enabled: false, users: [] });
    }
    if (url.pathname === '/api/auth/user') {
      return fulfillJson(route, { error: 'Unauthorized' }, 401);
    }
    return fulfillJson(route, {});
  });

  await page.goto('/help');
  await expect(page.getByTestId('auth-signed-out')).toBeVisible();
  await expect(page.getByTestId('button-login')).toBeVisible();
  await expect(page.getByTestId('dev-view-chip')).toHaveCount(0);
});