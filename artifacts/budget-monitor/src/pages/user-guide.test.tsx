import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Help from './user-guide';

vi.stubGlobal('React', React);

const capabilities = vi.hoisted(() => ({
  canWriteUserLimitsIn: [] as string[],
  canEditAllocations: false,
}));

vi.mock('@/components/auth-context', () => ({
  useAuthContext: () => ({ capabilities }),
}));

describe('Help and contact', () => {
  it('shows both exact contact links once, immediately after the header', () => {
    const html = renderToStaticMarkup(<Help />);
    expect(html).toMatch(/<\/header><section[^>]*aria-labelledby="help-contacts"><h2[^>]*id="help-contacts"[^>]*>Contact<\/h2>/);
    for (const email of ['chris.cattie@repl.it', 'support@repl.it']) {
      expect(html.match(new RegExp(`href="mailto:${email.replaceAll('.', '\\.')}"`, 'g'))).toHaveLength(1);
      expect(html).toContain(`>${email}</a>`);
    }
    expect(html).not.toMatch(/Who to contact|Access or missing workspaces|Funding or allocation changes|Agent limits or blocked usage|Incorrect totals, stale data, or app errors/);
    expect(html).not.toMatch(/walkthrough|12 slides|12-slide|Download|\.pdf/);
  });

  it('keeps the surrounding guide and concepts', () => {
    const html = renderToStaticMarkup(<Help />);
    expect(html).toContain('My Team');
    expect(html).toContain('Org Insights');
    expect(html).toContain('Read current spend');
    expect(html).toContain('Find where it went');
    expect(html).toContain('Check freshness and coverage');
    expect(html).not.toContain('Open <strong class="text-foreground">Spend</strong>');
    expect(html).toContain('Keep these concepts separate');
    expect(html).toContain('Observed usage in the selected reporting period.');
    expect(html).toContain('Monthly platform control that can block paid usage.');
    expect(html).not.toMatch(/onboarding|Take the tour|help-start-tours/i);
  });

  it('preserves role-dependent limits and allocation guidance', () => {
    expect(renderToStaticMarkup(<Help />)).not.toContain('Set Agent limits');
    capabilities.canWriteUserLimitsIn = ['workspace'];
    try {
      const html = renderToStaticMarkup(<Help />);
      expect(html).toContain('Set Agent limits');
      expect(html).toContain('Clear Limits');
      expect(html).not.toContain('Budget allocations are planning baselines');
      capabilities.canEditAllocations = true;
      expect(renderToStaticMarkup(<Help />)).toContain('Budget allocations are planning baselines');
    } finally {
      capabilities.canWriteUserLimitsIn = [];
      capabilities.canEditAllocations = false;
    }
  });
});