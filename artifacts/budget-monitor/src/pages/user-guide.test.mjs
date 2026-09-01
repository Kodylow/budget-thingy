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

test('guide centers the uploaded team and role business rules', async () => {
  const page = await readFile(pagePath, 'utf8');
  for (const expected of [
    'Budget Monitor Business Rules',
    'AZ-Replit - XXX - Role',
    'the Admin, Member, and Viewer groups roll up together',
    'The resulting team is named XXX',
    'AZ-Replit - Comcast Advertising - Admin',
    'AZ-Replit - Comcast Advertising - Member',
    'AZ-Replit - Comcast Advertising - Viewer',
    'Admin takes precedence over Member',
    'the Team page shows only their Admin status',
  ]) {
    assert.ok(page.includes(expected), `missing guide copy: ${expected}`);
  }
});

test('guide contains the uploaded Comcast and multi-workspace attribution rules', async () => {
  const page = await readFile(pagePath, 'utf8');
  for (const expected of [
    'reassigned when the user has an eligible non-Comcast workspace with positive spend',
    'eligible non-Comcast workspace where that user has the highest positive spend',
    'overlapping roles do not duplicate it',
    'their Comcast spend remains in the Comcast workspace',
    'Comcast-only users are unchanged',
    'assigned only to the workspace where that spend occurred',
    'never copied across the user’s other workspaces',
    'highest positive spend',
    'assigned to that primary workspace only when one exists',
    'workspace ID breaks the tie consistently',
  ]) {
    assert.ok(page.includes(expected), `missing guide copy: ${expected}`);
  }
});

test('guide retains safe external credit navigation', async () => {
  const page = await readFile(pagePath, 'utf8');
  assert.match(page, /Request additional credits/);
  assert.match(page, /https:\/\/airtable\.com\/appDXDfAHCXfJWF94\/pag0RCmIauEcWroiy\/form/);
  assert.match(page, /target="_blank" rel="noopener noreferrer"/);
});

test('guide follows responsive page and card conventions', async () => {
  const page = await readFile(pagePath, 'utf8');
  assert.match(page, /max-w-4xl/);
  assert.match(page, /space-y-4 p-4 md:space-y-5 md:p-8/);
  assert.match(page, /Rules at a glance/);
  assert.match(page, /aria-label="Business rule sections"/);
  assert.match(page, /rounded-full border/);
  assert.match(page, /rounded-md border bg-muted\/30 p-3/);
  assert.match(page, /w-full shrink-0 sm:w-auto/);
});