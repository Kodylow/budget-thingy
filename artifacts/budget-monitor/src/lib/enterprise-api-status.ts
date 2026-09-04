export type EnterpriseApiPresentationState = 'missing' | 'pending' | 'connected' | 'failed';

export interface EnterpriseApiStatusInput {
  enterpriseApiConfigured: boolean;
  enterpriseApiOk: boolean;
  enterpriseApiError?: string | null;
}

export interface EnterpriseApiStatusPresentation {
  state: EnterpriseApiPresentationState;
  detail: string;
  badge: string;
  calloutTitle: string | null;
  guidance: string | null;
}

export function getEnterpriseApiStatusPresentation(
  status: EnterpriseApiStatusInput,
): EnterpriseApiStatusPresentation {
  if (!status.enterpriseApiConfigured) {
    return {
      state: 'missing',
      detail: 'Not configured',
      badge: 'Not Set',
      calloutTitle: 'Configuration Required',
      guidance: 'Set the REPLIT_ENTERPRISE_API_KEY environment variable, then restart the API runtime to enable usage tracking.',
    };
  }

  if (status.enterpriseApiOk) {
    return {
      state: 'connected',
      detail: 'Connected',
      badge: 'OK',
      calloutTitle: null,
      guidance: null,
    };
  }

  const error = status.enterpriseApiError?.trim();
  if (error) {
    return {
      state: 'failed',
      detail: error,
      badge: 'Error',
      calloutTitle: 'Enterprise API Connection Failed',
      guidance: `${error} Retry the usage refresh. If the runtime configuration recently changed, restart the API runtime and try again.`,
    };
  }

  return {
    state: 'pending',
    detail: 'Configured; connection not yet verified',
    badge: 'Pending',
    calloutTitle: 'Connection Verification Pending',
    guidance: 'The Enterprise API key is configured, but no usage refresh has completed yet. Wait for the next refresh or restart the API runtime to retry.',
  };
}