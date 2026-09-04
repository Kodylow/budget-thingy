// @ts-nocheck
import { test, expect } from "vitest";

import {
  chunkMemberIds,
  eligibleLimitMemberIds,
  failedBulkSelection,
  indexMemberBudgets,
  toggleDisplayedSelection,
} from './member-budgets.ts';

test('one workspace budget is joined once for duplicate role membership', () => {
  const clusterMembers = [{ userId: 'member-1' }, { userId: 'member-1' }];
  const budget = {
    userId: 'member-1',
    budgetUsd: 50,
    usageUsd: 65,
    remainingUsd: -15,
  };

  const indexed = indexMemberBudgets(clusterMembers, [budget, budget]);
  expect(indexed.size).toBe(1);
  expect(indexed.get('member-1')).toEqual(budget);
});

test('budget and remaining are independent of selected-range spend', () => {
  const budget = {
    userId: 'member-1',
    budgetUsd: 100,
    usageUsd: 30,
    remainingUsd: 70,
  };
  const januaryMember = { userId: 'member-1', spendUsd: 12 };
  const augustMember = { userId: 'member-1', spendUsd: 900 };

  expect(indexMemberBudgets([januaryMember], [budget]).get('member-1')).toEqual(budget);
  expect(indexMemberBudgets([augustMember], [budget]).get('member-1')).toEqual(budget);
});

test('members outside the visible cluster are not joined', () => {
  const indexed = indexMemberBudgets(
    [{ userId: 'visible' }],
    [{
      userId: 'hidden',
      budgetUsd: 25,
      usageUsd: 5,
      remainingUsd: 20,
    }],
  );
  expect(indexed.size).toBe(0);
});

test('select all only changes displayed members and can clear them again', () => {
  const selected = toggleDisplayedSelection(new Set(['off-page']), ['one', 'two'], true);
  expect([...selected].sort()).toEqual(['off-page', 'one', 'two']);
  expect([...toggleDisplayedSelection(selected, ['one', 'two'], false)]).toEqual(['off-page']);
});

test('only failed bulk outcomes remain selected for retry', () => {
  const selected = failedBulkSelection([
    { userId: 'one', success: true },
    { userId: 'two', success: false },
    { userId: 'three', success: true },
  ]);
  expect([...selected]).toEqual(['two']);
});

test('large select-all updates are split into bounded API batches', () => {
  const ids = Array.from({ length: 205 }, (_, index) => `user-${index}`);
  const chunks = chunkMemberIds(ids);
  expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 5]);
  expect(chunks.flat()).toEqual(ids);
});

test('internal Replit members are never eligible for bulk limit targeting', () => {
  expect(eligibleLimitMemberIds([
    { userId: 'customer', isInternal: false },
    { userId: 'employee', isInternal: true },
    { userId: 'missing-marker' },
  ])).toEqual(['customer', 'missing-marker']);
});