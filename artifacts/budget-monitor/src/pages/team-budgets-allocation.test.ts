import { describe, expect, it } from 'vitest';
import {
  allocationPayloadFingerprint,
  filterVisibleAudits,
  filterVisibleTeams,
  getAllocationPermissions,
  normalizeMonthlyAllocation,
  parseAllocationAmount,
} from './team-budgets-allocation';

const monthlyFixture = {
  teamName: 'Customer Solutions',
  month: '2026-04',
  amount: '1250.50',
};

describe('allocation entry normalization', () => {
  it('normalizes a valid monthly fixture to one stable payload', () => {
    const first = normalizeMonthlyAllocation(
      monthlyFixture.teamName,
      monthlyFixture.month,
      monthlyFixture.amount,
    );
    const reopened = normalizeMonthlyAllocation(
      monthlyFixture.teamName,
      monthlyFixture.month,
      '1250.5',
    );

    expect(first).toEqual({
      draft: { teamName: 'Customer Solutions', month: '2026-04', amountUsd: 1250.5 },
    });
    expect(allocationPayloadFingerprint(first.draft!))
      .toBe(allocationPayloadFingerprint(reopened.draft!));
  });

  it('rejects invalid months, non-positive additions, and fractional cents', () => {
    expect(normalizeMonthlyAllocation('Team', '2026-13', '10').error).toBe('Select a valid month.');
    expect(normalizeMonthlyAllocation('Team', '2026-04', '0').error).toBe('Amount must be greater than zero.');
    expect(normalizeMonthlyAllocation('Team', '2026-04', '10.001').error)
      .toBe('Enter a dollar amount with no more than two decimal places.');
  });

  it('permits zero, but never negative opening funding', () => {
    expect(parseAllocationAmount('0', { allowZero: true })).toEqual({ value: 0 });
    expect(parseAllocationAmount('-1', { allowZero: true }).error).toBeTruthy();
    expect(parseAllocationAmount('9007199254740991', { allowZero: true }).error)
      .toBe('Amount is too large.');
  });
});

describe('allocation authorization fixtures', () => {
  const roleFixtures = [
    { name: 'true account admin', capabilities: { canEditAllocations: true, canManageAccess: true }, expected: { canEdit: true, canManageVisibility: true, canViewAudit: true } },
    { name: 'allocation manager', capabilities: { canEditAllocations: true, canManageAccess: false }, expected: { canEdit: true, canManageVisibility: false, canViewAudit: true } },
    { name: 'read only', capabilities: { canEditAllocations: false, canManageAccess: false }, expected: { canEdit: false, canManageVisibility: false, canViewAudit: false } },
    { name: 'denied', capabilities: { canEditAllocations: false, canManageAccess: false }, expected: { canEdit: false, canManageVisibility: false, canViewAudit: false } },
  ];

  it.each(roleFixtures)('$name receives only permitted controls', ({ capabilities, expected }) => {
    expect(getAllocationPermissions(capabilities)).toEqual(expected);
  });

  it('read-only previews never inherit actionable administrator capabilities', () => {
    expect(getAllocationPermissions({ canEditAllocations: true, canManageAccess: true }, true))
      .toEqual({ canEdit: false, canManageVisibility: false, canViewAudit: false });
  });

  it('does not disclose hidden teams or their audit fixtures to an allocation manager', () => {
    const teams = [
      { teamName: 'Visible team', isHidden: false },
      { teamName: 'Hidden team', isHidden: true },
    ];
    const audits = [
      { id: 1, teamName: 'Visible team' },
      { id: 2, teamName: 'Hidden team' },
    ];
    const visibleTeams = filterVisibleTeams(teams, false);

    expect(visibleTeams).toEqual([{ teamName: 'Visible team', isHidden: false }]);
    expect(filterVisibleAudits(audits, new Set(visibleTeams.map((team) => team.teamName)), false))
      .toEqual([{ id: 1, teamName: 'Visible team' }]);
    expect(filterVisibleAudits(audits, new Set(), true)).toEqual(audits);
  });
});