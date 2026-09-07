import { describe, expect, it } from 'vitest';

import { getEnterpriseApiStatusPresentation } from './enterprise-api-status';

describe('getEnterpriseApiStatusPresentation', () => {
  it('shows setup guidance only when the runtime key is unavailable', () => {
    expect(getEnterpriseApiStatusPresentation({
      enterpriseApiConfigured: false,
      enterpriseApiOk: false,
      enterpriseApiError: null,
    })).toEqual({
      state: 'missing',
      detail: 'Not configured',
      badge: 'Not Set',
      calloutTitle: 'Configuration Required',
      guidance: 'Set the REPLIT_ENTERPRISE_API_KEY environment variable, then restart the API runtime to enable usage tracking.',
    });
  });

  it('shows a configured connection as pending before its first health result', () => {
    const presentation = getEnterpriseApiStatusPresentation({
      enterpriseApiConfigured: true,
      enterpriseApiOk: false,
      enterpriseApiError: null,
    });

    expect(presentation).toEqual({
      state: 'pending',
      detail: 'Configured; connection not yet verified',
      badge: 'Pending',
      calloutTitle: 'Connection Verification Pending',
      guidance: 'The Enterprise API key is configured, but no usage refresh has completed yet. Wait for the next refresh or restart the API runtime to retry.',
    });
    expect(presentation.guidance).not.toContain('Set the REPLIT_ENTERPRISE_API_KEY');
  });

  it('shows healthy Enterprise API connectivity as connected', () => {
    expect(getEnterpriseApiStatusPresentation({
      enterpriseApiConfigured: true,
      enterpriseApiOk: true,
      enterpriseApiError: null,
    })).toEqual({
      state: 'connected',
      detail: 'Connected',
      badge: 'OK',
      calloutTitle: null,
      guidance: null,
    });
  });

  it('shows the reported upstream error and recovery guidance for a configured failure', () => {
    const presentation = getEnterpriseApiStatusPresentation({
      enterpriseApiConfigured: true,
      enterpriseApiOk: false,
      enterpriseApiError: 'Enterprise API returned 503',
    });

    expect(presentation).toEqual({
      state: 'failed',
      detail: 'Enterprise API returned 503',
      badge: 'Error',
      calloutTitle: 'Enterprise API Connection Failed',
      guidance: 'Enterprise API returned 503 Retry the usage refresh. If the runtime configuration recently changed, restart the API runtime and try again.',
    });
    expect(presentation.guidance).not.toContain('Set the REPLIT_ENTERPRISE_API_KEY');
  });
});