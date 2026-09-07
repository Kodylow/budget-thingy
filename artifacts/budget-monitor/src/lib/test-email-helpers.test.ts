// @ts-nocheck
import { describe, it, expect } from "vitest";

import {
  formatTestEmailSpend,
  formatTestEmailLabel,
  getTestEmailResultView,
} from './test-email-helpers.ts';

describe('test-email-helpers', () => {
  describe('formatTestEmailSpend', () => {
    it('calculates 50% correctly', () => {
      expect(formatTestEmailSpend(50)).toBe(5000);
    });

    it('calculates 75% correctly', () => {
      expect(formatTestEmailSpend(75)).toBe(7500);
    });

    it('calculates 100% with overage correctly', () => {
      expect(formatTestEmailSpend(100)).toBe(10250);
    });
  });

  describe('formatTestEmailLabel', () => {
    it('formats group', () => {
      expect(formatTestEmailLabel('group')).toBe('Engineering Group');
    });

    it('formats team', () => {
      expect(formatTestEmailLabel('team')).toBe('Engineering Team');
    });
  });

  describe('getTestEmailResultView', () => {
    it('shows sender and message ID only for a successful result', () => {
      expect(getTestEmailResultView({
        ok: true,
        error: null,
        senderEmail: 'budget@agentmail.to',
        messageId: 'message-123',
      })).toEqual({
        tone: 'success',
        title: 'Sent successfully',
        detail: 'Sender: budget@agentmail.to\nMessage ID: message-123',
      });
    });

    it('shows the returned error without success presentation', () => {
      expect(getTestEmailResultView({
        ok: false,
        error: 'Connector unavailable',
        senderEmail: null,
        messageId: null,
      })).toEqual({
        tone: 'error',
        title: 'Failed to send',
        detail: 'Connector unavailable',
      });
    });
  });
});
