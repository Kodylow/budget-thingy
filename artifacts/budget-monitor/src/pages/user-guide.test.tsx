import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Help from './user-guide';

vi.stubGlobal('React', React);

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({
    capabilities: {
      canWriteUserLimitsIn: [],
      canEditAllocations: false,
    },
  }),
}));

describe('Help walkthrough', () => {
  it('links to the portable PDF securely without an onboarding launcher', () => {
    const html = renderToStaticMarkup(<Help />);

    expect(html).toContain('href="/guides/budget-monitor-walkthrough.pdf"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('Open walkthrough (PDF)');
    expect(html).toContain('12-slide guide for members and team administrators');
    expect(html).not.toMatch(/onboarding|Take the tour|help-start-tours/i);
  });
});