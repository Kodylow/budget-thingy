import { describe, expect, it } from 'vitest';
import {
  resolveSpendViewScope,
  spendScopeLabel,
  spendScopeOptions,
} from './spend-scope';

describe('spend scope presentation', () => {
  it('accepts only public query values and uses the caller fallback otherwise', () => {
    expect(resolveSpendViewScope('my')).toBe('my');
    expect(resolveSpendViewScope('all_authorized')).toBe('all_authorized');
    expect(resolveSpendViewScope('self', 'my')).toBe('my');
    expect(resolveSpendViewScope('internal_value', 'managed')).toBe('managed');
  });

  it('does not claim account-wide spend without the account usage capability', () => {
    expect(spendScopeLabel('all_authorized', true)).toBe('Account spend');
    expect(spendScopeLabel('all_authorized', false)).toBe('All spend I can access');
    expect(spendScopeOptions(false).map((option) => option.label)).not.toContain('Account spend');
  });

  it('uses product language instead of internal enum labels', () => {
    expect(spendScopeLabel('my', false)).toBe('My spend');
    expect(spendScopeLabel('managed', false)).toBe('Teams and workspaces I manage');
    expect(spendScopeOptions(true).map((option) => option.label)).toEqual([
      'Teams and workspaces I manage',
      'My spend',
      'Account spend',
    ]);
  });
});