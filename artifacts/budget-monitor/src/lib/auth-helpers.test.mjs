import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  checkIsDenied,
  checkRealIsAccountAdmin,
  checkCanTestEmail,
  checkCanAccessSettings,
} from './auth-helpers.ts';

describe('auth-helpers', () => {
  describe('checkIsDenied', () => {
    it('returns true when authenticated but auth is null', () => {
      assert.strictEqual(checkIsDenied(true, null), true);
    });

    it('returns false when unauthenticated', () => {
      assert.strictEqual(checkIsDenied(false, null), false);
    });

    it('returns false when authenticated and auth exists', () => {
      assert.strictEqual(checkIsDenied(true, { role: 'member' }), false);
    });
  });

  describe('checkRealIsAccountAdmin', () => {
    it('returns true for account_admin', () => {
      assert.strictEqual(checkRealIsAccountAdmin('account_admin'), true);
    });

    it('returns true for account_delegate', () => {
      assert.strictEqual(checkRealIsAccountAdmin('account_delegate'), true);
    });

    it('returns false for others', () => {
      assert.strictEqual(checkRealIsAccountAdmin('workspace_admin'), false);
      assert.strictEqual(checkRealIsAccountAdmin('denied'), false);
      assert.strictEqual(checkRealIsAccountAdmin(null), false);
    });
  });

  describe('checkCanTestEmail', () => {
    it('returns true when capabilities.emailTesting is true', () => {
      assert.strictEqual(checkCanTestEmail({ emailTesting: true }), true);
    });

    it('returns false when capabilities.emailTesting is false', () => {
      assert.strictEqual(checkCanTestEmail({ emailTesting: false }), false);
    });

    it('returns false when capabilities is null or undefined', () => {
      assert.strictEqual(checkCanTestEmail(null), false);
      assert.strictEqual(checkCanTestEmail(undefined), false);
    });
  });

  describe('checkCanAccessSettings', () => {
    it('returns true if isAccountAdmin', () => {
      assert.strictEqual(checkCanAccessSettings(true, false, false), true);
    });

    it('returns true if realIsAccountAdmin', () => {
      assert.strictEqual(checkCanAccessSettings(false, true, false), true);
    });

    it('returns true if canTestEmail', () => {
      assert.strictEqual(checkCanAccessSettings(false, false, true), true);
    });

    it('returns false if none are true', () => {
      assert.strictEqual(checkCanAccessSettings(false, false, false), false);
    });
  });
});
