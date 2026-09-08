// @vitest-environment happy-dom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RangeProvider, useRange } from './range-context';
import { RangeFilter } from './range-filter';

const route = vi.hoisted(() => ({ search: '', setLocation: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('wouter', () => ({
  useLocation: () => ['/', route.setLocation],
  useSearch: () => route.search,
}));

function Selection() {
  const { rangeType, rangeSelection, startDate, endDate } = useRange();
  return <output>{JSON.stringify({ rangeType, rangeSelection, startDate, endDate })}</output>;
}

function SelectRange({ selection }: { selection: 'mtd' | 'billing' }) {
  const { setRangeSelection } = useRange();
  return <button onClick={() => setRangeSelection(selection)}>Select range</button>;
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
    route.setLocation.mockReset();
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

  it('ignores stale custom dates on an externally supplied preset URL', () => {
    route.search = 'rangeType=mtd&startDate=2026-06-02&endDate=2026-07-03';
    expect(renderSelection()).toEqual({
      rangeType: 'mtd',
      rangeSelection: 'mtd',
    });
  });

  it.each([
    [
      'removes custom dates when changing from custom to month to date',
      'rangeType=custom&startDate=2026-06-02&endDate=2026-07-03&workspaceId=workspace-1&viewScope=my&tab=projects',
    ],
    [
      'recovers from invalid custom dates when changing to a preset',
      'rangeType=custom&startDate=2026-08-02&endDate=2026-07-03&workspaceId=workspace-1&viewScope=my&tab=projects',
    ],
  ])('%s', async (_description, search) => {
    route.search = search;
    window.history.replaceState(null, '', `/?${route.search}`);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<RangeProvider><SelectRange selection="mtd" /></RangeProvider>);
    });

    await act(async () => {
      container.querySelector('button')!.click();
    });

    expect(route.setLocation).toHaveBeenCalledTimes(1);
    const selectedUrl = new URL(route.setLocation.mock.calls[0][0], 'https://example.test');
    expect(selectedUrl.searchParams.get('rangeType')).toBe('mtd');
    expect(selectedUrl.searchParams.has('startDate')).toBe(false);
    expect(selectedUrl.searchParams.has('endDate')).toBe(false);
    expect(selectedUrl.searchParams.get('workspaceId')).toBe('workspace-1');
    expect(selectedUrl.searchParams.get('viewScope')).toBe('my');
    expect(selectedUrl.searchParams.get('tab')).toBe('projects');

    route.search = selectedUrl.search.slice(1);
    expect(renderSelection()).toEqual({
      rangeType: 'mtd',
      rangeSelection: 'mtd',
    });

    await act(async () => root.unmount());
    container.remove();
  });

  it('retains valid dates when custom remains selected', async () => {
    route.search = 'rangeType=custom&startDate=2026-05-20&endDate=2027-05-20&workspaceId=workspace-1';
    window.history.replaceState(null, '', `/?${route.search}`);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<RangeProvider><SelectRange selection="billing" /></RangeProvider>);
    });

    expect(renderSelection()).toEqual({
      rangeType: 'custom',
      rangeSelection: 'custom',
      startDate: '2026-05-20',
      endDate: '2027-05-20',
    });

    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps queries on a valid committed fallback when a custom URL pair is incomplete or reversed', () => {
    route.search = 'rangeType=custom&endDate=2026-07-03';
    const incomplete = renderSelection();
    expect(incomplete.rangeType).toBe('custom');
    expect(incomplete.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(incomplete.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(incomplete.startDate <= incomplete.endDate).toBe(true);

    route.search = 'rangeType=custom&startDate=2026-08-02&endDate=2026-07-03';
    const reversed = renderSelection();
    expect(reversed.startDate <= reversed.endDate).toBe(true);
  });

  it('keeps draft edits local and commits the completed pair only on Apply', async () => {
    route.search = 'rangeType=custom&startDate=2026-06-02&endDate=2026-07-03&workspaceId=workspace-1';
    window.history.replaceState(null, '', `/?${route.search}`);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<RangeProvider><RangeFilter /></RangeProvider>);
    });
    const start = container.querySelector<HTMLInputElement>('input[aria-label="Reporting start date"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

    await act(async () => {
      setInputValue.call(start, '');
      start.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(route.setLocation).not.toHaveBeenCalled();

    await act(async () => {
      setInputValue.call(start, '0006-02-02');
      start.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(route.setLocation).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);

    await act(async () => {
      setInputValue.call(start, '2026-06-05');
      start.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(route.setLocation).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(route.setLocation).toHaveBeenCalledTimes(1);
    const committed = new URL(route.setLocation.mock.calls[0][0], 'https://example.test');
    expect(committed.searchParams.get('startDate')).toBe('2026-06-05');
    expect(committed.searchParams.get('endDate')).toBe('2026-07-03');
    expect(committed.searchParams.get('workspaceId')).toBe('workspace-1');

    await act(async () => root.unmount());
    container.remove();
  });
});