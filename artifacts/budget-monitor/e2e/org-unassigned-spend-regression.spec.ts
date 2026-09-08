import { expect, test, type Page, type Route } from '@playwright/test';

const reporting = {
  acquisitionCoverage: 'complete',
  rosterAttributionBasis: 'observed_roster',
  creatorCoverage: 'complete',
  creatorAttributionBasis: 'not_applicable',
  freshness: 'fresh',
  valueBasis: 'verified',
  comparisonsVerified: true,
};

const authFixture = {
  user: {
    id: 'unassigned-account',
    email: 'unassigned@example.test',
    firstName: 'Unassigned',
    lastName: 'Account',
    profileImageUrl: null,
  },
  auth: {
    authorizationRevision: 'unassigned-regression',
    role: 'account',
    roles: ['account'],
    workspaceIds: [],
    teamNames: [],
    groupIds: [],
    managedGroupIds: [],
    groupUserIds: {},
    userIds: [],
    isPreview: false,
    previewReadOnly: false,
  },
  capabilities: {
    canManageAccess: true,
    canViewAccountUsage: true,
    canEditAllocations: true,
    canManageFundingMappings: true,
    canManageNotifications: true,
    canManageSystem: true,
    canPreviewRoles: false,
    canWriteGroupLimits: true,
    canWriteUserLimitsIn: [],
    canRunChecks: true,
    canSendTestEmail: false,
  },
};

function overview(
  unassignedSpendUsd: number | null,
  unassignedDetail: {
    observation: 'complete' | 'partial' | 'unavailable';
    workspaces: Array<{
      workspaceId: string | null;
      workspaceName: string | null;
      spendUsd: number;
      rows: Array<{
        id: string;
        groupName: string | null;
        source: 'unmapped_group' | 'no_group' | 'unresolved_difference';
        spendUsd: number;
      }>;
    }>;
  },
) {
  return {
    periodStart: '2026-05-20',
    periodEnd: '2027-05-20',
    asOf: '2026-09-08',
    complete: unassignedDetail.observation === 'complete',
    reporting,
    qualification: null,
    summary: {
      accountSpendUsd: 300,
      teamAllocationUsd: 400,
      remainingUsd: 100,
      teamsOverBudget: 0,
      unassignedSpendUsd,
      fundedTeamCount: 0,
      resolvedTeamCount: 0,
      unresolvedTeamCount: 0,
    },
    unassignedDetail,
    accountPoints: [
      { date: '2026-05-20', spendUsd: 0 },
      { date: '2026-09-08', spendUsd: 300 },
    ],
    teams: [],
  };
}

const detailedOverview = overview(47.25, {
  observation: 'partial',
  workspaces: [
    {
      workspaceId: 'ws-north',
      workspaceName: 'North Workspace',
      spendUsd: 42.25,
      rows: [
        { id: 'platform', groupName: 'Platform', source: 'unmapped_group', spendUsd: 30 },
        { id: 'no-group', groupName: null, source: 'no_group', spendUsd: 12.25 },
      ],
    },
    {
      workspaceId: null,
      workspaceName: null,
      spendUsd: 5,
      rows: [
        { id: 'difference', groupName: null, source: 'unresolved_difference', spendUsd: 5 },
      ],
    },
  ],
});

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installApi(page: Page, getOverview: (route: Route) => void | Promise<void>) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/dev-view') return json(route, { enabled: false, users: [] });
    if (path === '/api/auth/user') return json(route, authFixture);
    if (path === '/api/org-insights') return getOverview(route);
    return json(route, {});
  });
}

for (const { width, columns, availableWidth } of [
  { width: 320, columns: 1 },
  { width: 390, columns: 1 },
  { width: 768, columns: 2 },
  { width: 1088, columns: 4 }, // 1024px after page padding
  { width: 1440, columns: 5 },
  { width: 1440, columns: 4, availableWidth: 1088 }, // sidebar-sized constraint
]) {
  test(`summary borders and values align at ${width}px${availableWidth ? ' with constrained content' : ''}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let current = {
      ...detailedOverview,
      summary: {
        ...detailedOverview.summary,
        accountSpendUsd: 123456789.01 as number | null,
        teamAllocationUsd: 98765432.10 as number | null,
        remainingUsd: -24691356.91 as number | null,
        teamsOverBudget: 2 as number | null,
        fundedTeamCount: 123,
        resolvedTeamCount: 121,
        unresolvedTeamCount: 2,
      },
    };
    await installApi(page, async route => {
      await held;
      return json(route, current);
    });
    await page.goto('/org-insights');
    if (availableWidth) {
      // Exercise usable width independently of viewport media queries.
      await page.locator('main').evaluate((main, size) => {
        main.style.width = `${size}px`;
      }, availableWidth);
    }
    const loading = page.getByTestId('org-summary-loading');
    await expect(loading).toBeVisible();
    const loadingColumns = await loading.evaluate(el => getComputedStyle(el).gridTemplateColumns);
    expect(loadingColumns.split(' ')).toHaveLength(columns);
    release();
    const grid = page.getByRole('region', { name: 'Organization budget summary' });
    const cards = grid.locator('.org-summary-card');
    await expect(cards).toHaveCount(5);
    await page.evaluate(() => document.fonts.ready);
    expect(await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns)).toBe(loadingColumns);

    async function expectAlignedAndReadable() {
      const measurements = await cards.evaluateAll(elements => elements.map(card => {
        const border = card.getBoundingClientRect();
        const header = card.firstElementChild!;
        const label = header.firstElementChild!;
        const value = header.lastElementChild!;
        const range = document.createRange();
        range.selectNodeContents(value);
        const valueLines = [...range.getClientRects()];
        const textFits = [label, value, card.children[1]].filter(Boolean).every(element => {
          range.selectNodeContents(element);
          return [...range.getClientRects()].every(rect =>
            rect.left >= border.left + 15 && rect.right <= border.right - 15 &&
            rect.top >= border.top && rect.bottom <= border.bottom);
        });
        return {
          top: border.top, height: border.height, bottom: border.bottom,
          labelTop: label.getBoundingClientRect().top,
          valueTop: value.getBoundingClientRect().top,
          baseline: valueLines[0].bottom,
          valueLines: valueLines.length,
          textFits,
          padding: getComputedStyle(card).padding,
          overflow: card.scrollWidth > card.clientWidth,
        };
      }));
      for (let i = 0; i < measurements.length; i += columns) {
        const row = measurements.slice(i, i + columns);
        for (const card of row) {
          for (const key of ['top', 'height', 'bottom', 'labelTop', 'valueTop', 'baseline'] as const) {
            expect(Math.abs(card[key] - row[0][key]), key).toBeLessThanOrEqual(1);
          }
          expect(card.padding).toBe('16px');
          expect(card.textFits).toBe(true);
          expect(card.valueLines).toBe(1);
          expect(card.overflow).toBe(false);
        }
      }
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth &&
        [...document.querySelectorAll('main, .org-summary-grid')].every(el => el.scrollWidth <= el.clientWidth),
      )).toBe(true);
    }

    await expectAlignedAndReadable();
    await expect(page.getByTestId('org-card-account-spend')).toContainText('$123,456,789.01');
    await expect(page.getByTestId('org-card-team-funding')).toContainText('$98,765,432.10');
    await expect(page.getByTestId('org-card-remaining')).toContainText('-$24,691,356.91');
    await expect(page.getByTestId('org-card-remaining')).toContainText('Remaining Team Budgets (Known)');
    await expect(page.getByTestId('org-card-over-budget')).toContainText('Attention 121 of 123 funded teams; 2 unresolved.');
    await expect(page.getByTestId('org-card-unassigned')).toContainText('View workspace and group details →');
    await expect(cards.nth(0).locator(':scope > div')).toHaveCount(1); // no empty detail region
    await page.screenshot({ path: testInfo.outputPath('summary-known.png') });

    const trigger = grid.getByRole('button', { name: 'Inspect Unassigned Spend' });
    const triggerBox = await trigger.boundingBox();
    const borderBox = await cards.last().boundingBox();
    expect(triggerBox).toEqual(borderBox);
    await trigger.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(trigger).toBeFocused();
    expect(await trigger.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).boxShadow !== 'none')).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('org-unassigned-dialog')).toContainText('North Workspace');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await page.keyboard.press(' ');
    await expect(page.getByTestId('org-unassigned-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    // The blank padded corner activates the same dialog, not just its text.
    await trigger.click({ position: { x: 4, y: 4 } });
    await expect(page.getByTestId('org-unassigned-dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    current = {
      ...current,
      summary: { ...current.summary, accountSpendUsd: null, teamAllocationUsd: null, remainingUsd: null, teamsOverBudget: null },
    };
    await page.getByTestId('refresh-org-insights').click();
    await expect(cards.first()).toContainText('Unavailable');
    await expectAlignedAndReadable();
    current = {
      ...current,
      summary: { ...detailedOverview.summary, fundedTeamCount: 1, resolvedTeamCount: 1, unresolvedTeamCount: 0 },
    };
    await page.getByTestId('refresh-org-insights').click();
    await expect(cards.first()).toContainText('$300.00');
    await expectAlignedAndReadable();
    await expect(grid).not.toContainText('(Known)');
    await expect(grid).not.toContainText('Attention');
  });
}

test('unassigned is the only interactive summary and its real dialog is keyboard accessible', async ({ page }) => {
  await installApi(page, route => json(route, detailedOverview));
  await page.goto('/org-insights');

  const trigger = page.getByRole('button', { name: 'Inspect Unassigned Spend' });
  const cards = trigger.locator('xpath=ancestor::section[1]');
  await expect(cards.getByRole('button')).toHaveCount(1);
  for (const testId of [
    'org-card-account-spend',
    'org-card-team-funding',
    'org-card-remaining',
    'org-card-over-budget',
  ]) {
    await expect(page.getByTestId(testId)).not.toHaveAttribute('role', 'button');
    await expect(page.getByTestId(testId).locator('button')).toHaveCount(0);
  }

  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('org-unassigned-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('org-card-unassigned')).toContainText('$47.25');
  await expect(page.getByTestId('unassigned-detail-total')).toHaveText('$47.25');
  await expect(dialog).toContainText('Funding Period: 2026-05-20 to 2027-05-20');
  await expect(dialog).toContainText('Recorded through: 2026-09-08');
  await expect(dialog).toContainText('North Workspace');
  await expect(dialog).toContainText('(ws-north)');
  await expect(dialog).toContainText('Subtotal: $42.25');
  await expect(dialog).toContainText('Workspace unresolved');
  await expect(dialog).toContainText('Subtotal: $5.00');
  await expect(dialog.getByRole('row').filter({ hasText: 'Platform' }))
    .toContainText('Group not mapped to a budget team');
  await expect(dialog.getByRole('row').filter({ hasText: 'No group / unresolved attribution' }))
    .toContainText('Workspace-level attribution');
  await expect(dialog).toContainText('Unresolved accounting difference');
  await expect(dialog).toContainText('These amounts do not identify a missing owner.');
  await page.screenshot({
    path: 'e2e/evidence/org-unassigned-spend-dialog-desktop.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({
    path: 'e2e/evidence/org-unassigned-spend-dialog-mobile.png',
    fullPage: true,
  });

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.keyboard.press(' ');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('a refresh retains one committed response, then updates card and open detail together', async ({ page }) => {
  let calls = 0;
  let releaseRefresh!: () => void;
  const refreshHeld = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const updated = overview(9, {
    observation: 'complete',
    workspaces: [{
      workspaceId: 'ws-south',
      workspaceName: 'South Workspace',
      spendUsd: 9,
      rows: [{ id: 'south', groupName: null, source: 'no_group', spendUsd: 9 }],
    }],
  });
  await installApi(page, async route => {
    calls++;
    if (calls === 1) return json(route, detailedOverview);
    await refreshHeld;
    return json(route, updated);
  });
  await page.goto('/org-insights');
  await page.getByTestId('refresh-org-insights').click();
  await expect(page.getByTestId('refresh-org-insights')).toContainText('Updating');
  await page.getByRole('button', { name: 'Inspect Unassigned Spend' }).click();
  const dialog = page.getByTestId('org-unassigned-dialog');
  await expect(page.getByTestId('org-card-unassigned')).toContainText('$47.25');
  await expect(page.getByTestId('unassigned-detail-total')).toHaveText('$47.25');
  await expect(dialog).toContainText('North Workspace');

  releaseRefresh();
  await expect(page.getByTestId('refresh-org-insights')).toContainText('Refresh');
  await expect(page.getByTestId('org-card-unassigned')).toContainText('$9.00');
  await expect(page.getByTestId('unassigned-detail-total')).toHaveText('$9.00');
  await expect(dialog).toContainText('South Workspace');
  await expect(dialog).not.toContainText('North Workspace');
});

test('observed zero is distinct from unavailable detail', async ({ page }) => {
  let current = overview(0, { observation: 'complete', workspaces: [] });
  await installApi(page, route => json(route, current));
  await page.goto('/org-insights');
  const trigger = page.getByRole('button', { name: 'Inspect Unassigned Spend' });
  await trigger.click();
  await expect(page.getByTestId('org-unassigned-dialog')).toContainText(
    'No unassigned spend in the recorded usage for this funding period.',
  );
  await page.keyboard.press('Escape');

  current = overview(null, { observation: 'unavailable', workspaces: [] });
  await page.getByTestId('refresh-org-insights').click();
  await expect(page.getByTestId('org-card-unassigned')).toContainText('Unavailable');
  await trigger.click();
  await expect(page.getByTestId('org-unassigned-dialog')).toContainText(
    'Unassigned spend details are unavailable. Missing usage is not zero.',
  );
});

for (const status of [401, 403]) {
  test(`${status} hides retained overview and open unassigned financial details`, async ({ page }) => {
    let calls = 0;
    let releaseDenial!: () => void;
    const denialHeld = new Promise<void>(resolve => { releaseDenial = resolve; });
    await installApi(page, async route => {
      calls++;
      if (calls === 1) return json(route, detailedOverview);
      await denialHeld;
      return json(route, { error: 'Denied' }, status);
    });
    await page.goto('/org-insights');
    await page.getByTestId('refresh-org-insights').click();
    await expect(page.getByTestId('refresh-org-insights')).toContainText('Updating');
    await page.getByRole('button', { name: 'Inspect Unassigned Spend' }).click();
    await expect(page.getByTestId('org-unassigned-dialog')).toContainText('North Workspace');

    releaseDenial();
    if (status === 401) {
      // The shared API client sends expired sessions back to login.
      await expect(page).toHaveURL(/\/api\/login\?returnTo=/);
    } else {
      await expect(page.getByTestId('org-insights-error')).toBeVisible();
    }
    await expect(page.getByTestId('org-unassigned-dialog')).toHaveCount(0);
    await expect(page.getByText('North Workspace')).toHaveCount(0);
    await expect(page.getByText('$47.25')).toHaveCount(0);
  });
}