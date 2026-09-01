import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pagePath = new URL('./user-guide.tsx', import.meta.url);
const appPath = new URL('../App.tsx', import.meta.url);
const shellPath = new URL('../components/app-shell.tsx', import.meta.url);

test('user guide is routed and linked under Administration for account admins only', async () => {
  const [app, shell] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(shellPath, 'utf8'),
  ]);
  assert.match(
    app,
    /function AccountAdminGuideRoute\(\)[\s\S]*isAccountAdmin \? <UserGuide \/> : <Redirect to="\/" \/>/,
  );
  assert.match(app, /path="\/user-guide" component=\{AccountAdminGuideRoute\}/);
  assert.match(
    shell,
    /label: 'Administration'[\s\S]*label: 'User Guide'[\s\S]*show: isAccountAdmin/,
  );
  const overviewSection = shell.match(
    /label: 'Overview',[\s\S]*?items: \[([\s\S]*?)\][\s\S]*?\},/,
  )?.[1] ?? '';
  assert.equal(overviewSection.includes("label: 'User Guide'"), false);
});

test('guide contains the canonical scoped usage, pool, and alert guidance', async () => {
  const page = await readFile(pagePath, 'utf8');
  for (const expected of [
    'selected date range controls the usage shown',
    'all metric types',
    'shared membership is counted once',
    'distinct visible workspaces is added together',
    'workspace-aware member rollups',
    'assigned once using stable group attribution',
    '“No group” row',
    'intentionally answer different questions',
    'Remaining is the allocated pool minus',
    '“Over Threshold” count includes visible pools at or above 75%',
    '50%, 75%, 90%, and 100%',
    'at most once per billing period',
    'next successful check',
    'remains retryable',
    'Email Activity is read-only',
    'spend captured when an email was sent and the current spend',
  ]) {
    assert.ok(page.includes(expected), `missing guide copy: ${expected}`);
  }
});

test('guide stays workspace-scoped and uses safe external credit navigation', async () => {
  const page = await readFile(pagePath, 'utf8');
  assert.match(page, /Request additional credits/);
  assert.match(page, /https:\/\/airtable\.com\/appDXDfAHCXfJWF94\/pag0RCmIauEcWroiy\/form/);
  assert.match(page, /target="_blank" rel="noopener noreferrer"/);

  for (const excluded of [
    'Run Check Now',
    'Send test',
    'Manage recipients',
    'Workspace Directory',
    'Team Budgets',
  ]) {
    assert.equal(page.includes(excluded), false, `guide exposes account-only reference: ${excluded}`);
  }
});

test('guide follows responsive page and card conventions', async () => {
  const page = await readFile(pagePath, 'utf8');
  assert.match(page, /max-w-4xl/);
  assert.match(page, /space-y-4 p-4 md:space-y-5 md:p-8/);
  assert.match(page, /Quick Start/);
  assert.match(page, /rounded-full border/);
  assert.match(page, /rounded-md border bg-muted\/30 p-3/);
  assert.match(page, /w-full shrink-0 sm:w-auto/);
});