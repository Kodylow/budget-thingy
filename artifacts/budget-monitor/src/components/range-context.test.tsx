import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RangeProvider, useRange } from './range-context';

const route = vi.hoisted(() => ({ search: '' }));

vi.mock('wouter', () => ({
  useLocation: () => ['/', vi.fn()],
  useSearch: () => route.search,
}));

function Selection() {
  const { rangeType, rangeSelection, startDate, endDate } = useRange();
  return <output>{JSON.stringify({ rangeType, rangeSelection, startDate, endDate })}</output>;
}

function renderSelection() {
  const markup = renderToStaticMarkup(
    <RangeProvider><Selection /></RangeProvider>,
  );
  return JSON.parse(markup.match(/<output>(.*)<\/output>/)![1]
    .replaceAll('&quot;', '"'));
}

describe('reporting range URL selection', () => {
  beforeEach(() => {
    route.search = '';
  });

  it('defaults an omitted range to the full reporting period', () => {
    expect(renderSelection()).toEqual({
      rangeType: 'full-term',
      rangeSelection: 'full-term',
    });
  });

  it.each([
    ['rangeType=billing', {
      rangeType: 'billing',
      rangeSelection: 'billing',
    }],
    ['rangeType=custom&startDate=2026-06-02&endDate=2026-07-03', {
      rangeType: 'custom',
      rangeSelection: 'custom',
      startDate: '2026-06-02',
      endDate: '2026-07-03',
    }],
  ])('preserves an explicit query: %s', (search, expected) => {
    route.search = search;
    expect(renderSelection()).toEqual(expected);
  });
});