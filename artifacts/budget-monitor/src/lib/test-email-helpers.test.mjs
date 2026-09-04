import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  formatTestEmailSpend,
  formatTestEmailLabel,
  getTestEmailResultView,
} from './test-email-helpers.ts';

describe('test-email-helpers', () => {
  describe('formatTestEmailSpend', () => {
    it('calculates 50% correctly', () => {
      assert.strictEqual(formatTestEmailSpend(50), 5000);
    });

    it('calculates 75% correctly', () => {
      assert.strictEqual(formatTestEmailSpend(75), 7500);
    });

    it('calculates 100% with overage correctly', () => {
      assert.strictEqual(formatTestEmailSpend(100), 10250);
    });
  });

  describe('formatTestEmailLabel', () => {
    it('formats group', () => {
      assert.strictEqual(formatTestEmailLabel('group'), 'Engineering Group');
    });

    it('formats team', () => {
      assert.strictEqual(formatTestEmailLabel('team'), 'Engineering Team');
    });
  });

  describe('getTestEmailResultView', () => {
    it('shows sender and message ID only for a successful result', () => {
      assert.deepStrictEqual(getTestEmailResultView({
        ok: true,
        error: null,
        senderEmail: 'budget@agentmail.to',
        messageId: 'message-123',
      }), {
        tone: 'success',
        title: 'Sent successfully',
        detail: 'Sender: budget@agentmail.to\nMessage ID: message-123',
      });
    });

    it('shows the returned error without success presentation', () => {
      assert.deepStrictEqual(getTestEmailResultView({
        ok: false,
        error: 'Connector unavailable',
        senderEmail: null,
        messageId: null,
      }), {
        tone: 'error',
        title: 'Failed to send',
        detail: 'Connector unavailable',
      });
    });
  });
});
