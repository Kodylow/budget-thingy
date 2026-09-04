import { describe, expect, it } from 'vitest';
import {
  getAutomatedEmailPolicyPresentation,
  getEmailConnectorPresentation,
} from './email-policy';

describe('email status presentation', () => {
  it('keeps connector readiness separate from automated delivery policy', () => {
    expect(getEmailConnectorPresentation(true)).toMatchObject({ label: 'Ready' });
    expect(getAutomatedEmailPolicyPresentation(false)).toMatchObject({ label: 'Off' });
  });

  it('explains that disabled automation preserves due alerts', () => {
    expect(getAutomatedEmailPolicyPresentation(false).detail)
      .toContain('will not send or consume');
  });

  it('does not imply enabling policy configures the connector', () => {
    expect(getAutomatedEmailPolicyPresentation(true).detail)
      .not.toContain('AgentMail');
    expect(getEmailConnectorPresentation(false).detail)
      .toContain('policy is unchanged');
  });
});