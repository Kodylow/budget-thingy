// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  resolvedRootDestination,
  safeLoginReturnTarget,
} from './lib/login-navigation';
import { legacyReportingDestination, teamOverviewHref } from './lib/reporting-navigation';

describe('resolved root landing', () => {
  it('routes an effective account viewer to canonical Org Insights', () => {
    expect(resolvedRootDestination('authorized', true)).toBe('/org-insights');
  });

  it('keeps scoped and preview roles on personal Home when their effective capability is false', () => {
    expect(resolvedRootDestination('authorized', false)).toBe('/');
  });

  it.each(['loading', 'signed-out', 'unavailable', 'denied', 'invalid-preview'] as const)(
    'does not choose or mount a landing while authorization is %s',
    availability => {
      expect(resolvedRootDestination(availability, true)).toBeNull();
      expect(resolvedRootDestination(availability, false)).toBeNull();
    },
  );
});

describe('authenticated /login navigation', () => {
  it('preserves standalone projects and canonical team bookmarks through login', () => {
    for (const destination of [
      '/my-projects?search=alpha',
      '/teams/pool%3Ateam%3AR%252FD?rangeType=billing',
    ]) {
      expect(safeLoginReturnTarget(`?returnTo=${encodeURIComponent(destination)}`))
        .toBe(destination);
    }
  });

  it('returns a completed login to an allowed local route with its query', () => {
    expect(safeLoginReturnTarget(
      '?returnTo=%2Fspend%3FrangeType%3Dmonth',
    )).toBe('/spend?rangeType=month');
    expect(safeLoginReturnTarget(
      '?returnTo=%2Fgroups%2Fgroup-1%3FrangeType%3Dcustom',
    )).toBe('/groups/group-1?rangeType=custom');
    expect(safeLoginReturnTarget(
      '?returnTo=%2Fusers%2Fuser-1%3FreturnTo%3D%252Fspend',
    )).toBe('/users/user-1?returnTo=%2Fspend');
    expect(safeLoginReturnTarget(
      '?returnTo=%2Fworkspaces%2Fworkspace-1%2Fprojects%2Fproject-1%23usage',
    )).toBe('/workspaces/workspace-1/projects/project-1#usage');
  });

  it('defaults a normal OIDC /login completion to the capability-derived root landing', () => {
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

describe('retired reporting routes', () => {
  it('does not widen an explicitly empty team selector to an account landing', () => {
    expect(legacyReportingDestination('poolId=', true)).toBe('/teams/');
  });

  it('sends personal project bookmarks to standalone My Projects', () => {
    expect(legacyReportingDestination(
      'tab=projects&viewScope=my&rangeType=month&search=alpha',
      false,
    )).toBe('/my-projects?rangeType=month&search=alpha');
  });

  it('sends a selected canonical team to its exact route for every role', () => {
    const search = 'poolId=pool%3Ateam%3AR%252FD&rangeType=full-term';
    expect(legacyReportingDestination(search, false))
      .toBe('/teams/pool%3Ateam%3AR%252FD?rangeType=full-term');
    expect(teamOverviewHref('pool:team:R%2FD'))
      .toBe('/teams/pool%3Ateam%3AR%252FD');
  });

  it('uses role-safe generic replacements', () => {
    expect(legacyReportingDestination('rangeType=month', true)).toBe('/org-insights');
    expect(legacyReportingDestination('rangeType=month', false)).toBe('/my-team?rangeType=month');
  });
});