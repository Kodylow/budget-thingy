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
  it('explains navigation and routes questions to the responsible administrators', () => {
    const html = renderToStaticMarkup(<Help />);
    expect(html).toContain('Who to contact');
    expect(html).toContain('Access or missing workspaces');
    expect(html).toContain('Funding or allocation changes');
    expect(html).toContain('Agent limits or blocked usage');
    expect(html).toContain('Incorrect totals, stale data, or app errors');
    expect(html).toContain('My Team');
    expect(html).toContain('Org Insights');
    expect(html).not.toContain('Open <strong class="text-foreground">Spend</strong>');
  });
  it('renders the approved guide layout and links to the portable PDF securely', () => {
    const html = renderToStaticMarkup(<Help />);

    expect(html).toContain('href="/guides/budget-monitor-walkthrough.pdf"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain('Open walkthrough (PDF)');
    expect(html).toContain('12-slide guide for members and team administrators');
    expect(html).toContain('12 slides');
    expect(html).toContain('Keep these concepts separate');
    expect(html).toContain('Observed usage in the selected reporting period.');
    expect(html).toContain('Monthly platform control that can block paid usage.');
    expect(html).not.toMatch(/onboarding|Take the tour|help-start-tours/i);
  });
});