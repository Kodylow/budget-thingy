// @ts-nocheck
import { describe, it, expect } from "vitest";

import {
  checkIsDenied,
  checkRealIsAccountAdmin,
  checkCanTestEmail,
  checkCanAccessSettings,
} from './auth-helpers.ts';

describe('auth-helpers', () => {
  describe('checkIsDenied', () => {
    it('returns true when authenticated but auth is null', () => {
      expect(checkIsDenied(true, null)).toBe(true);
    });

    it('returns false when unauthenticated', () => {
      expect(checkIsDenied(false, null)).toBe(false);
    });

    it('returns false when authenticated and auth exists', () => {
      expect(checkIsDenied(true, { role: 'member' })).toBe(false);
    });
  });

  describe('checkRealIsAccountAdmin', () => {
    it('returns true for account_admin', () => {
      expect(checkRealIsAccountAdmin('account_admin')).toBe(true);
    });

    it('returns true for account_delegate', () => {
      expect(checkRealIsAccountAdmin('account_delegate')).toBe(true);
    });

    it('returns false for others', () => {
      expect(checkRealIsAccountAdmin('workspace_admin')).toBe(false);
      expect(checkRealIsAccountAdmin('denied')).toBe(false);
      expect(checkRealIsAccountAdmin(null)).toBe(false);
    });
  });

  describe('checkCanTestEmail', () => {
    it('returns true when capabilities.emailTesting is true', () => {
      expect(checkCanTestEmail({ emailTesting: true })).toBe(true);
    });

    it('returns false when capabilities.emailTesting is false', () => {
      expect(checkCanTestEmail({ emailTesting: false })).toBe(false);
    });

    it('returns false when capabilities is null or undefined', () => {
      expect(checkCanTestEmail(null)).toBe(false);
      expect(checkCanTestEmail(undefined)).toBe(false);
    });
  });

  describe('checkCanAccessSettings', () => {
    it('returns true if isAccountAdmin', () => {
      expect(checkCanAccessSettings(true, false, false)).toBe(true);
    });

    it('returns true if realIsAccountAdmin', () => {
      expect(checkCanAccessSettings(false, true, false)).toBe(true);
    });

    it('returns true if canTestEmail', () => {
      expect(checkCanAccessSettings(false, false, true)).toBe(true);
    });

    it('returns false if none are true', () => {
      expect(checkCanAccessSettings(false, false, false)).toBe(false);
    });
  });
});
