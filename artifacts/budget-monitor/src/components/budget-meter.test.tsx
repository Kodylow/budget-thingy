import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetMeter } from './budget-meter';

const observed = vi.hoisted(() => ({ adminNotes: [] as React.ReactNode[] }));
vi.mock('@/components/admin-data-quality', () => ({
  AdminDataQualityNote: ({ children }: { children: React.ReactNode }) => {
    observed.adminNotes.push(children);
    return null;
  },
}));

describe('BudgetMeter', () => {
  beforeEach(() => {
    observed.adminNotes.length = 0;
  });
  it('shows zero-budget overage dollars and a restrained red status', () => {
    const html = renderToStaticMarkup(<BudgetMeter actualUsd={12.5} budgetUsd={0} />);
    expect(html).toContain('$12.50 used · Zero budget');
    expect(html).toContain('budget-meter__status--over');
  });

  it('distinguishes an unavailable budget from no configured budget', () => {
    const unavailable = renderToStaticMarkup(
      <BudgetMeter actualUsd={null} budgetUsd={null} incomplete />,
    );
    const none = renderToStaticMarkup(<BudgetMeter actualUsd={10} budgetUsd={null} />);
    expect(unavailable).toContain('Budget unknown');
    expect(unavailable).not.toContain('>No budget<');
    expect(none).toContain('No budget');
  });

  it('does not report non-finite or negative budgets as zero', () => {
    for (const budgetUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const html = renderToStaticMarkup(<BudgetMeter actualUsd={10} budgetUsd={budgetUsd} />);
      expect(html).toContain('Budget value invalid');
      expect(html).toContain('data-state="invalid-budget"');
      expect(html).not.toContain('Zero budget');
    }
  });

  it('marks actual overage status while retaining blue actual fill', () => {
    const html = renderToStaticMarkup(<BudgetMeter actualUsd={125} budgetUsd={100} compact />);
    expect(html).toContain('125.0% used');
    expect(html).toContain('budget-meter__status--over');
    expect(html).toContain('budget-meter__actual budget-meter__actual--over');
  });

  it('never renders a green projection when data is stale or incomplete', () => {
    const stale = renderToStaticMarkup(
      <BudgetMeter actualUsd={20} budgetUsd={100} projectedUsd={50} stale />,
    );
    const incomplete = renderToStaticMarkup(
      <BudgetMeter actualUsd={20} budgetUsd={100} projectedUsd={50} incomplete />,
    );
    expect(stale).toContain('budget-meter__projection--neutral');
    expect(stale).not.toContain('budget-meter__projection--green');
    expect(incomplete).toContain('budget-meter__projection--neutral');
    expect(incomplete).not.toContain('budget-meter__projection--green');
  });

  it('renders elapsed-time marker and labels the period end as exclusive', () => {
    const html = renderToStaticMarkup(
      <BudgetMeter
        actualUsd={20}
        budgetUsd={100}
        periodStart="2026-09-01T00:00:00Z"
        periodEnd="2026-09-11T00:00:00Z"
        dataThrough="2026-09-06T00:00:00Z"
      />,
    );
    expect(html).toContain('budget-meter__time-marker');
    expect(html).toContain('left:50%');
    expect(html).toContain('(end exclusive)');
    expect(html).toContain('50.0% through Sep 6, 2026');
  });

  it('provides focusable exact-value details while moving explanatory keys to admin data quality', () => {
    const html = renderToStaticMarkup(
      <BudgetMeter actualUsd={90.25} budgetUsd={100} projectedUsd={95.5} compact />,
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain('Actual spend $90.25 · 90.3% of budget');
    expect(html).toContain('Projected spend $95.50 · 95.5% of budget');
    expect(html).toContain('Budget capacity $100.00');
    expect(html).not.toContain('Near limit: projection is 90%–100% of capacity');
    expect(html).not.toContain('hatched bar is projected spend');
    expect(String(observed.adminNotes[0])).toContain('hatched bar is projected spend');
    expect(String(observed.adminNotes[0])).toContain('Near limit: projection is 90%–100% of capacity');
  });

  it('withholds projection assessment for stale or incomplete data', () => {
    const html = renderToStaticMarkup(
      <BudgetMeter actualUsd={20} budgetUsd={100} projectedUsd={50} stale incomplete />,
    );
    expect(html).not.toContain('Assessment withheld: stale data and incomplete data');
    expect(String(observed.adminNotes[0])).toContain('Assessment withheld: stale data and incomplete data');
    expect(html).toContain('Projected spend $50.00 · 50.0% of budget');
  });
});