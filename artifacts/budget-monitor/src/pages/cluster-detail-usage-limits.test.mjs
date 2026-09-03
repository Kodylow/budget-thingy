import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const pageSource = await readFile(
  new URL('./cluster-detail.tsx', import.meta.url),
  'utf8',
);
const inputSource = await readFile(
  new URL('../components/member-budget-input.tsx', import.meta.url),
  'utf8',
);

test('member table presents one usage-limit column without legacy budget columns', () => {
  assert.match(pageSource, />Usage limit</);
  assert.doesNotMatch(pageSource, />Ind\. Budget</);
  assert.doesNotMatch(pageSource, />Remaining</);
});

test('selection controls and individual mutations use usage-limit language', () => {
  assert.match(pageSource, /Select all displayed members/);
  assert.match(pageSource, /Apply usage limit/);
  assert.match(inputSource, /Edit usage limit/);
  assert.match(inputSource, /Clear usage limit/);
});

test('operators can see disabled controls when connector write permission is unavailable', () => {
  assert.match(pageSource, /\{canWrite && \(/);
  assert.match(pageSource, /disabled=\{!canEditLimits \|\| bulkApplying\}/);
  assert.match(pageSource, /Ask your workspace admin to enable the approved Replit integration/);
  assert.match(inputSource, /Edit usage limit unavailable/);
});