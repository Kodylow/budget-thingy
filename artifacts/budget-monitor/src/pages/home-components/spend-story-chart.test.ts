import { describe, expect, it } from 'vitest';
import type { BillingCycleComparisonCycle } from '@workspace/api-client-react';
import { billingCycleSeriesData } from './spend-story-chart';

describe('billing cycle spend series', () => {
  it('aligns cycles by day and preserves missing and future values as null', () => {
    const cycles: BillingCycleComparisonCycle[] = [
      {
        key: 'current',
        label: 'This month',
        startDate: '2026-03-10',
        endDate: '2026-04-09',
        personalComplete: false,
        teamComplete: false,
        points: [
          { day: 1, date: '2026-03-10', personalSpendUsd: 10, teamSpendUsd: 25 },
          { day: 2, date: '2026-03-11', personalSpendUsd: null, teamSpendUsd: null },
        ],
      },
      {
        key: 'previous',
        label: 'Last month',
        startDate: '2026-02-10',
        endDate: '2026-03-09',
        personalComplete: true,
        teamComplete: true,
        points: [
          { day: 1, date: '2026-02-10', personalSpendUsd: 8, teamSpendUsd: 20 },
          { day: 2, date: '2026-02-11', personalSpendUsd: 12, teamSpendUsd: 30 },
          { day: 3, date: '2026-02-12', personalSpendUsd: 18, teamSpendUsd: 40 },
        ],
      },
    ];

    const personal = billingCycleSeriesData(cycles, 'personal');

    expect(personal).toHaveLength(3);
    expect(personal[0]).toMatchObject({ day: 1, current: 10, previous: 8 });
    expect(personal[1]).toMatchObject({ day: 2, current: null, previous: 12 });
    expect(personal[2]).toMatchObject({ day: 3, current: null, previous: 18, twoAgo: null });
    expect(personal[2].current).not.toBe(0);
  });
});