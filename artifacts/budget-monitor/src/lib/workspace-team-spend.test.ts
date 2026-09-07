import { expect, test } from 'vitest';
import {
  allocateWorkspaceTeamBudgets,
  indexWorkspaceTeamSpend,
  totalWorkspaceSpend,
  workspaceTeamSpendKey,
} from './workspace-team-spend';

test('keeps same-named teams distinct by workspace without duplicating workspace totals', () => {
  const rows = [
    { workspaceId: 'growth', teamName: 'Shared Team', spendUsd: 125 },
    { workspaceId: 'enterprise', teamName: 'Shared Team', spendUsd: 375 },
    { workspaceId: 'growth', teamName: 'Other Team', spendUsd: 25 },
  ];

  const byTeam = indexWorkspaceTeamSpend(rows);
  expect(byTeam.get(workspaceTeamSpendKey('growth', 'Shared Team'))).toBe(125);
  expect(byTeam.get(workspaceTeamSpendKey('enterprise', 'Shared Team'))).toBe(375);

  const byWorkspace = totalWorkspaceSpend(rows);
  expect(byWorkspace.get('growth')).toBe(150);
  expect(byWorkspace.get('enterprise')).toBe(375);
  expect([...byWorkspace.values()].reduce((sum, spend) => sum + spend, 0)).toBe(525);
});

test('allocates a shared budget proportionally and preserves the exact total', () => {
  const allocations = allocateWorkspaceTeamBudgets([
    { workspaceId: 'one', teamName: 'Shared', spendUsd: 25 },
    { workspaceId: 'two', teamName: 'Shared', spendUsd: 75 },
  ], new Map([['Shared', 100]]));
  expect(allocations.get(workspaceTeamSpendKey('one', 'Shared'))?.budgetUsd).toBe(25);
  expect(allocations.get(workspaceTeamSpendKey('two', 'Shared'))?.budgetUsd).toBe(75);
  expect([...allocations.values()].reduce((sum, item) => sum + item.budgetUsd, 0)).toBe(100);
});

test('splits a shared budget equally when visible spend is zero', () => {
  const allocations = allocateWorkspaceTeamBudgets([
    { workspaceId: 'one', teamName: 'Shared', spendUsd: 0 },
    { workspaceId: 'two', teamName: 'Shared', spendUsd: -10 },
  ], new Map([['Shared', 100]]));
  expect([...allocations.values()].map((item) => item.budgetUsd)).toEqual([50, 50]);
  expect([...allocations.values()].every((item) => item.method === 'equal')).toBe(true);
});

test('corrects the final rounded remainder deterministically', () => {
  const allocations = allocateWorkspaceTeamBudgets([
    { workspaceId: 'a', teamName: 'Shared', spendUsd: 1 },
    { workspaceId: 'b', teamName: 'Shared', spendUsd: 1 },
    { workspaceId: 'c', teamName: 'Shared', spendUsd: 1 },
  ], new Map([['Shared', 100]]));
  expect([...allocations.values()].map((item) => item.budgetUsd)).toEqual([33.33, 33.33, 33.34]);
  expect([...allocations.values()].reduce((sum, item) => sum + item.budgetUsd, 0)).toBe(100);
});

test('keeps distinct generated team names and single-workspace budgets unchanged', () => {
  const allocations = allocateWorkspaceTeamBudgets([
    { workspaceId: 'one', teamName: 'Generated A', spendUsd: 20 },
    { workspaceId: 'two', teamName: 'Generated B', spendUsd: 40 },
  ], new Map([['Generated A', 80], ['Generated B', 120]]));
  expect(allocations.get(workspaceTeamSpendKey('one', 'Generated A'))).toEqual({
    budgetUsd: 80,
    isShared: false,
    method: 'full',
  });
  expect(allocations.get(workspaceTeamSpendKey('two', 'Generated B'))?.budgetUsd).toBe(120);
});