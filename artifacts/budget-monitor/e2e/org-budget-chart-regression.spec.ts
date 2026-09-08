import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type ChartTeam = {
  id: string;
  name: string;
  allocationUsd: number | null;
  spendUsd: number | null;
};

const reporting = {
  acquisitionCoverage: 'complete',
  rosterAttributionBasis: 'current_membership',
  creatorCoverage: 'not_applicable',
  creatorAttributionBasis: 'not_applicable',
  freshness: 'fresh',
  valueBasis: 'verified',
  comparisonsVerified: true,
};

const points = (spendUsd: number | null) => [
  { date: '2026-06-01', spendUsd: spendUsd == null ? null : spendUsd * 0.2 },
  { date: '2026-07-01', spendUsd: spendUsd == null ? null : spendUsd * 0.5 },
  { date: '2026-08-01', spendUsd: spendUsd == null ? null : spendUsd * 0.8 },
  { date: '2026-09-01', spendUsd },
];

function teamFixture(team: ChartTeam) {
  const { id, name, allocationUsd, spendUsd } = team;
  return {
    id,
    name,
    allocationUsd,
    spendUsd,
    remainingUsd: allocationUsd != null && spendUsd != null ? allocationUsd - spendUsd : null,
    percentUsed: allocationUsd && spendUsd != null ? (spendUsd / allocationUsd) * 100 : null,
    complete: true,
    reporting,
    points: points(spendUsd),
  };
}

function overviewFixture(teams: ChartTeam[], accountSpendUsd = 300) {
  const teamAllocationUsd = teams.reduce((sum, team) => sum + (team.allocationUsd ?? 0), 0);
  const fundedTeamCount = teams.filter(team => team.allocationUsd != null && team.allocationUsd > 0).length;
  return {
    periodStart: '2026-05-20',
    periodEnd: '2027-05-20',
    asOf: '2026-09-08',
    complete: true,
    reporting,
    qualification: null,
    summary: {
      accountSpendUsd,
      teamAllocationUsd,
      remainingUsd: teamAllocationUsd - accountSpendUsd,
      teamsOverBudget: 0,
      unassignedSpendUsd: 0,
      fundedTeamCount,
      resolvedTeamCount: fundedTeamCount,
      unresolvedTeamCount: 0,
    },
    accountPoints: points(accountSpendUsd),
    teams: teams.map(teamFixture),
  };
}

const authFixture = {
  user: {
    id: 'chart-account',
    email: 'chart@example.test',
    firstName: 'Chart',
    lastName: 'Account',
    profileImageUrl: null,
  },
  auth: {
    authorizationRevision: 'chart-regression',
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

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installChartApi(page: Page, getOverview: () => unknown) {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/dev-view') return json(route, { enabled: false, users: [] });
    if (path === '/api/auth/user') return json(route, authFixture);
    if (path === '/api/org-insights') return json(route, getOverview());
    return json(route, {});
  });
}

function captureRuntimeFailures(page: Page) {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  return failures;
}

function expectNoHookOrChartTypeErrors(failures: string[]) {
  expect(
    failures.filter(message =>
      /invalid hook call|orgbudgetchart|cannot read properties of (null|undefined)|dispatcher/i.test(message),
    ),
  ).toEqual([]);
}

async function expectNativeLines(page: Page, count: number) {
  const lines = page.getByTestId('org-budget-chart').locator('.recharts-line-curve');
  await expect(lines).toHaveCount(count);
  for (const line of await lines.all()) {
    await expect(line).toHaveAttribute('d', /^M/);
  }
  return lines;
}

test('native chart survives data replacement, selected-team removal, and reorder', async ({ page }, testInfo) => {
  const failures = captureRuntimeFailures(page);
  let overview = overviewFixture([
    { id: 'alpha', name: 'Alpha Team', allocationUsd: 100, spendUsd: 90 },
    { id: 'beta', name: 'Beta Team', allocationUsd: 150, spendUsd: 70 },
    { id: 'gamma', name: 'Gamma Team', allocationUsd: 120, spendUsd: 50 },
  ]);
  await installChartApi(page, () => overview);
  await page.goto('/org-insights');

  const chart = page.getByTestId('org-budget-chart');
  const total = chart.getByRole('button', { name: /^Total/ });
  await expect(total).toHaveAttribute('aria-pressed', 'true');
  const lines = await expectNativeLines(page, 2);
  const initialTotalPath = await lines.first().getAttribute('d');

  await chart.getByRole('button', { name: 'Alpha Team' }).click();
  await chart.getByRole('button', { name: 'Beta Team' }).click();
  await expectNativeLines(page, 6);

  overview = overviewFixture([
    { id: 'gamma', name: 'Gamma Team', allocationUsd: 120, spendUsd: 65 },
    { id: 'beta', name: 'Beta Team', allocationUsd: 150, spendUsd: 95 },
    { id: 'delta', name: 'Delta Team', allocationUsd: 130, spendUsd: 20 },
  ], 360);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();

  await expect(chart.getByRole('button', { name: 'Alpha Team' })).toHaveCount(0);
  await expect(chart.getByRole('button', { name: 'Beta Team' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.getByRole('button')).toHaveText([
    /Total/,
    /Gamma Team/,
    /Beta Team/,
    /Delta Team/,
  ]);
  await expectNativeLines(page, 4);
  await expect(lines.first()).not.toHaveAttribute('d', initialTotalPath!);
  await page.screenshot({
    path: `e2e/evidence/org-budget-chart-${testInfo.project.name}-native.png`,
    fullPage: true,
  });

  await total.click();
  await expect(total).toHaveAttribute('aria-pressed', 'false');
  await expectNativeLines(page, 2);
  await chart.getByRole('button', { name: 'Beta Team' }).click();
  await expect(chart.getByText('No series selected.')).toBeVisible();
  await total.click();
  await expectNativeLines(page, 2);
  expectNoHookOrChartTypeErrors(failures);
});

test('malformed chart data keeps the report shell available through retry and recovery', async ({ page }, testInfo) => {
  const valid = overviewFixture([
    { id: 'alpha', name: 'Alpha Team', allocationUsd: 100, spendUsd: 90 },
  ]);
  let overview: unknown = valid;
  await installChartApi(page, () => overview);
  await page.goto('/org-insights');
  await expectNativeLines(page, 2);

  const malformed = { ...valid } as Record<string, unknown>;
  delete malformed.accountPoints;
  overview = malformed;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();

  const unavailable = page.getByTestId('org-chart-unavailable');
  await expect(unavailable).toContainText('incomplete or incompatible');
  await expect(page.getByTestId('org-budget-chart')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Organization Budget Overview' })).toBeVisible();
  await expect(page.getByTestId('org-card-account-spend')).toContainText('$300.00');
  await expect(page.getByRole('heading', { name: 'All Teams' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Alpha Team' })).toBeVisible();
  await page.screenshot({
    path: `e2e/evidence/org-budget-chart-${testInfo.project.name}-fallback.png`,
    fullPage: true,
  });

  await unavailable.getByRole('button', { name: 'Retry chart' }).click();
  await expect(unavailable).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Organization Budget Overview' })).toBeVisible();

  overview = overviewFixture([
    { id: 'alpha', name: 'Alpha Team', allocationUsd: 100, spendUsd: 95 },
  ], 320);
  await unavailable.getByRole('button', { name: 'Retry chart' }).click();
  await expect(unavailable).toHaveCount(0);
  await expectNativeLines(page, 2);
  await expect(page.getByTestId('org-card-account-spend')).toContainText('$320.00');
});

test('development React identity, HMR update, and Vite websocket reconnect keep the native chart mounted', async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.metadata.runtimeMode !== 'development', 'Development-server regression only');

  await page.addInitScript(() => {
    const nextDocument = Number(sessionStorage.getItem('chart-document-count') ?? '0') + 1;
    sessionStorage.setItem('chart-document-count', String(nextDocument));
    const NativeWebSocket = window.WebSocket;
    const sockets: WebSocket[] = [];
    class TrackedWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        const nextSocket = Number(sessionStorage.getItem('chart-socket-count') ?? '0') + 1;
        sessionStorage.setItem('chart-socket-count', String(nextSocket));
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: TrackedWebSocket });
    Object.defineProperty(window, '__chartViteSockets', { configurable: true, value: sockets });
  });

  const failures = captureRuntimeFailures(page);
  const overview = overviewFixture([
    { id: 'alpha', name: 'Alpha Team', allocationUsd: 100, spendUsd: 90 },
    { id: 'beta', name: 'Beta Team', allocationUsd: 150, spendUsd: 70 },
  ]);
  await installChartApi(page, () => overview);
  await page.goto('/org-insights');
  await expectNativeLines(page, 2);

  const identity = await page.evaluate(async () => {
    const source = async (url: string) => {
      const response = await fetch(url);
      return { url: response.url, text: await response.text() };
    };
    const dependency = (text: string, name: string) => {
      const urls = [...text.matchAll(/["']([^"']+\.js\?v=[\w-]+)["']/g)].map(match => match[1]);
      const match = urls.find(url => url.includes(`/${name}.js?v=`));
      if (!match) throw new Error(`Missing transformed ${name} dependency`);
      return match;
    };
    const requireReactChunk = (module: { url: string; text: string }) => {
      const match = module.text.match(/import\s*\{\s*require_react\s*\}\s*from\s*"([^"]+)"/);
      if (!match) throw new Error(`Missing require_react import in ${module.url}`);
      return new URL(match[1], module.url).href;
    };
    const chart = await source('/src/pages/org-budget-chart.tsx');
    const rendererEntry = await source('/src/main.tsx');
    const react = await source(dependency(chart.text, 'react'));
    const recharts = await source(dependency(chart.text, 'recharts'));
    const renderer = await source(dependency(rendererEntry.text, 'react-dom_client'));
    return {
      chartReactEntry: react.url,
      reactRequireChunk: requireReactChunk(react),
      rechartsRequireChunk: requireReactChunk(recharts),
      rendererRequireChunk: requireReactChunk(renderer),
    };
  });
  expect(identity.chartReactEntry).toMatch(/\/node_modules\/\.vite\/deps\/react\.js\?v=[\w-]+$/);
  expect(new Set([
    identity.reactRequireChunk,
    identity.rechartsRequireChunk,
    identity.rendererRequireChunk,
  ]).size).toBe(1);

  const chartSourcePath = fileURLToPath(new URL('../src/pages/org-budget-chart.tsx', import.meta.url));
  const originalSource = await readFile(chartSourcePath, 'utf8');
  try {
    const hmrProbe = `
if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => {
    window.__chartAfterUpdate = (window.__chartAfterUpdate ?? 0) + 1;
  });
}
`;
    await writeFile(chartSourcePath, `${originalSource}${hmrProbe}`);
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __chartAfterUpdate?: number }).__chartAfterUpdate ?? 0,
    )).toBeGreaterThan(0);
    await expect(page.getByTestId('org-budget-chart')).toBeVisible();
    await expectNativeLines(page, 2);
  } finally {
    const restoreResponse = page.waitForResponse(response =>
      response.url().includes('/src/pages/org-budget-chart.tsx') && response.status() === 200,
    );
    await writeFile(chartSourcePath, originalSource);
    await restoreResponse;
  }

  const reconnectBefore = await page.evaluate(() => ({
    documentCount: Number(sessionStorage.getItem('chart-document-count') ?? '0'),
    socketCount: Number(sessionStorage.getItem('chart-socket-count') ?? '0'),
  }));
  await page.evaluate(() => {
    const sockets = (window as unknown as { __chartViteSockets: WebSocket[] }).__chartViteSockets;
    const openSocket = [...sockets].reverse().find(socket => socket.readyState === WebSocket.OPEN);
    if (!openSocket) throw new Error('No open Vite websocket to close');
    openSocket.close();
  });
  await expect.poll(() => page.evaluate(() => {
    const documentCount = Number(sessionStorage.getItem('chart-document-count') ?? '0');
    const socketCount = Number(sessionStorage.getItem('chart-socket-count') ?? '0');
    return `${documentCount}:${socketCount}`;
  })).not.toBe(`${reconnectBefore.documentCount}:${reconnectBefore.socketCount}`);
  const reconnectAfter = await page.evaluate(() => ({
    documentCount: Number(sessionStorage.getItem('chart-document-count') ?? '0'),
    socketCount: Number(sessionStorage.getItem('chart-socket-count') ?? '0'),
  }));
  await testInfo.attach('vite-reconnect-result', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({
      before: reconnectBefore,
      after: reconnectAfter,
      documentReloaded: reconnectAfter.documentCount > reconnectBefore.documentCount,
    }, null, 2)),
  });
  await writeFile(
    fileURLToPath(new URL('./evidence/org-budget-chart-vite-reconnect.json', import.meta.url)),
    `${JSON.stringify({
      before: reconnectBefore,
      after: reconnectAfter,
      documentReloaded: reconnectAfter.documentCount > reconnectBefore.documentCount,
    }, null, 2)}\n`,
  );
  await expectNativeLines(page, 2);
  await page.getByTestId('org-budget-chart').getByRole('button', { name: 'Alpha Team' }).click();
  await expectNativeLines(page, 4);
  expectNoHookOrChartTypeErrors(failures);
});

test('development runtime chart exception stays local and recovers after source restoration', async ({ page }, testInfo: TestInfo) => {
  test.skip(testInfo.project.metadata.runtimeMode !== 'development', 'Development-server regression only');

  const overview = overviewFixture([
    { id: 'alpha', name: 'Alpha Team', allocationUsd: 100, spendUsd: 90 },
  ]);
  await installChartApi(page, () => overview);
  await page.goto('/org-insights');
  await expectNativeLines(page, 2);

  const chartSourcePath = fileURLToPath(new URL('../src/pages/org-budget-chart.tsx', import.meta.url));
  const originalSource = await readFile(chartSourcePath, 'utf8');
  const functionOpening = `}) {\n  const compatible = hasCompatibleOrgChartInput(data);`;
  const faultSource = originalSource.replace(
    functionOpening,
    `}) {\n  throw new Error('CHART_BROWSER_RUNTIME_PROBE');\n  const compatible = hasCompatibleOrgChartInput(data);`,
  );
  expect(faultSource).not.toBe(originalSource);
  try {
    await writeFile(chartSourcePath, faultSource);
    await expect(page.getByTestId('org-chart-unavailable')).toContainText('could not render');
    await expect(page.getByTestId('org-budget-chart')).toHaveCount(0);
    await expect(page.locator('#root')).toBeVisible();
    await expect(page.getByTestId('nav-help')).toBeVisible();
    await page.getByTestId('nav-help').click();
    await expect(page).toHaveURL(/\/help$/);
    await page.goBack();
    await expect(page.getByTestId('org-chart-unavailable')).toBeVisible();
  } finally {
    await writeFile(chartSourcePath, originalSource);
  }

  await page.getByTestId('org-chart-unavailable').getByRole('button', { name: 'Retry chart' }).click();
  await expect(page.getByTestId('org-chart-unavailable')).toHaveCount(0);
  await expectNativeLines(page, 2);
});