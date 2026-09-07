// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { safeLoginReturnTarget } from './lib/login-navigation';

describe('authenticated /login navigation', () => {
  it('returns a completed login to an allowed local route with its query', () => {
    expect(safeLoginReturnTarget(
      '?returnTo=%2Fspend%3FrangeType%3Dmonth',
    )).toBe('/spend?rangeType=month');
    expect(safeLoginReturnTarget(
      '?returnTo=%2Fgroups%2Fgroup-1%3FrangeType%3Dcustom',
    )).toBe('/groups/group-1?rangeType=custom');
  });

  it('defaults a normal OIDC /login completion to the overview', () => {
    expect(safeLoginReturnTarget('')).toBe('/');
    expect(safeLoginReturnTarget('?code=completed-by-server')).toBe('/');
  });

  it('rejects external, looping, malformed, and nonexistent return targets', () => {
    expect(safeLoginReturnTarget('?returnTo=https%3A%2F%2Fevil.example')).toBe('/');
    expect(safeLoginReturnTarget('?returnTo=%2F%2Fevil.example%2Fspend')).toBe('/');
    expect(safeLoginReturnTarget('?returnTo=%2Flogin')).toBe('/');
    expect(safeLoginReturnTarget('?returnTo=%2Fmanagement')).toBe('/');
    expect(safeLoginReturnTarget('?returnTo=%2Fgroups%2Fa%2Fb')).toBe('/');
  });
});