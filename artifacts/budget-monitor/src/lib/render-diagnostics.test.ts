import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorInfo } from 'react';
import { getRecentDiagnosticRequestIds } from '@workspace/api-client-react';
import { reportRenderFailure } from './render-diagnostics';

vi.mock('@workspace/api-client-react', () => ({
  getRecentDiagnosticRequestIds: vi.fn(() => ['req-safe']),
}));

const info = (componentStack: string): ErrorInfo => ({ componentStack });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('render failure diagnostics privacy', () => {
  it('classifies the chart signal and emits only sanitized frame locations', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('ORG_CHART_INPUT_INCOMPATIBLE');
    error.stack = [
      'Error: ORG_CHART_INPUT_INCOMPATIBLE',
      ' at SecretCustomer (/src/pages/org-budget-chart.tsx?token=top-secret:41:9)',
      ' at PersonName (/src/components/private-account-123.tsx:8:2)',
      ' at https://private.example.test/accounts/financial-id?spend=987654.32:1:2',
    ].join('\n');

    reportRenderFailure(
      error,
      info(' at PrivateComponent (/src/App.tsx:333:7)\n at Account999 (/node_modules/react/index.js:2:1)'),
      'org-budget-chart',
    );

    expect(log).toHaveBeenCalledWith('ui_render_failed', expect.objectContaining({
      scope: 'org-budget-chart',
      classification: 'org_chart_input_incompatible',
      errorFrames: [
        { source: 'org-budget-chart', line: 41, column: 9 },
        { source: 'application-component', line: 8, column: 2 },
      ],
      componentFrames: [
        { source: 'app-root', line: 333, column: 7 },
        { source: 'react-runtime', line: 2, column: 1 },
      ],
      requestIdCandidates: ['req-safe'],
    }));
    const serialized = JSON.stringify(log.mock.calls);
    for (const secret of ['SecretCustomer', 'PrivateComponent', 'PersonName', 'Account999', 'top-secret', '987654.32', 'private.example.test', 'financial-id']) {
      expect(serialized).not.toContain(secret);
    }
    expect(getRecentDiagnosticRequestIds).toHaveBeenCalledWith(5);
  });

  it('allowlists hook failures without retaining arbitrary error text', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    reportRenderFailure(new TypeError("Cannot read properties of null (reading 'useMemo')"), info(''), 'root');
    reportRenderFailure(new Error('private@example.test spent $123456 for account abc-123'), info(''), 'root');

    expect(log.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      classification: 'react_hook_dispatcher_unavailable',
    }));
    expect(log.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      classification: 'render_error',
    }));
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('abc-123');
  });

  it('never throws for hostile inputs or a failed diagnostics sink', () => {
    vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('sink unavailable'); });
    const hostile = new Proxy({}, { get: () => { throw new Error('private getter'); } });
    expect(() => reportRenderFailure(hostile, hostile as ErrorInfo, 'root')).not.toThrow();
  });
});