import assert from 'node:assert/strict';
import test from 'node:test';

import { indexMemberBudgets } from './member-budgets.ts';

test('one workspace budget is joined once for duplicate role membership', () => {
  const clusterMembers = [{ userId: 'member-1' }, { userId: 'member-1' }];
  const budget = {
    userId: 'member-1',
    budgetUsd: 50,
    usageUsd: 65,
    remainingUsd: -15,
  };

  const indexed = indexMemberBudgets(clusterMembers, [budget, budget]);
  assert.equal(indexed.size, 1);
  assert.deepEqual(indexed.get('member-1'), budget);
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

  assert.deepEqual(indexMemberBudgets([januaryMember], [budget]).get('member-1'), budget);
  assert.deepEqual(indexMemberBudgets([augustMember], [budget]).get('member-1'), budget);
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
  assert.equal(indexed.size, 0);
});