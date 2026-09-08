// @vitest-environment happy-dom
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RangeProvider, useRange } from './range-context';
import { RangeFilter } from './range-filter';

const route = vi.hoisted(() => ({ search: '', setLocation: vi.fn() }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('wouter', () => ({
  useLocation: () => ['/', route.setLocation],
  useSearch: () => route.search,
}));

vi.mock('@/components/ui/select', async () => {
  const ReactModule = await import('react');
  const SelectContext = ReactModule.createContext<((value: string) => void) | null>(null);
  return {
    Select: ({ children, onValueChange }: any) => (
      <SelectContext.Provider value={onValueChange}><div>{children}</div></SelectContext.Provider>
    ),
    SelectTrigger: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    SelectValue: ({ children }: any) => <>{children}</>,
    SelectContent: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ children, value }: any) => {
      const onValueChange = ReactModule.useContext(SelectContext);
      return <button role="option" onClick={() => onValueChange?.(value)}>{children}</button>;
    },
  };
});

function Selection() {
  const { rangeType, rangeSelection, startDate, endDate } = useRange();
  return <output>{JSON.stringify({ rangeType, rangeSelection, startDate, endDate })}</output>;
}

function SelectRange({ selection }: { selection: 'full-term' | 'billing' }) {
  const { setRangeSelection } = useRange();
  return <button onClick={() => setRangeSelection(selection)}>Select range</button>;
}

function renderSelection() {
  const markup = renderToStaticMarkup(<RangeProvider><Selection /></RangeProvider>);
  return JSON.parse(markup.match(/<output>(.*)<\/output>/)![1].replaceAll('&quot;', '"'));
}

async function renderClient(children: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RangeProvider>{children}</RangeProvider>));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe('reporting range URL selection', () => {
  beforeEach(() => {
    route.search = '';
    route.setLocation.mockReset();
    window.history.replaceState(null, '', '/');
  });

  it.each([
    ['', 'full-term'],
    ['rangeType=full-term', 'full-term'],
    ['rangeType=billing', 'billing'],
    ['rangeType=mtd', 'full-term'],
    ['rangeType=ytd', 'full-term'],
    ['rangeType=custom', 'full-term'],
    ['rangeType=invalid', 'full-term'],
  ])('derives the supported selection from %s', (search, selection) => {
    route.search = search;
    expect(renderSelection()).toEqual({
      rangeType: selection,
      rangeSelection: selection,
    });
  });

  it.each(['', 'rangeType=full-term', 'rangeType=billing'])(
    'does not rewrite a valid or omitted selection: %s',
    async search => {
      route.search = search;
      window.history.replaceState(null, '', search ? `/?${search}` : '/');
      const rendered = await renderClient(<Selection />);
      expect(route.setLocation).not.toHaveBeenCalled();
      await rendered.unmount();
    },
  );

  it('normalizes a legacy URL and removes stale dates and pagination while preserving filters', async () => {
    route.search = 'rangeType=custom&startDate=2026-06-02&endDate=2026-07-03&page=4&workspaceId=workspace-1&viewScope=my&tab=projects&search=agent';
    window.history.replaceState(null, '', `/?${route.search}`);
    const rendered = await renderClient(<Selection />);

    expect(route.setLocation).toHaveBeenCalledTimes(1);
    const [href, options] = route.setLocation.mock.calls[0];
    const url = new URL(href, 'https://example.test');
    expect(url.searchParams.get('rangeType')).toBe('full-term');
    for (const key of ['startDate', 'endDate', 'page']) expect(url.searchParams.has(key)).toBe(false);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      workspaceId: 'workspace-1',
      viewScope: 'my',
      tab: 'projects',
      search: 'agent',
    });
    expect(options).toEqual({ replace: true });
    await rendered.unmount();
  });

  it.each(['full-term', 'billing'] as const)(
    'writes %s, clears custom dates and page, and preserves other controls',
    async selection => {
      route.search = 'rangeType=billing&startDate=2026-06-02&endDate=2026-07-03&page=3&workspaceId=workspace-1&viewScope=my&tab=groups&search=ops';
      window.history.replaceState(null, '', `/?${route.search}`);
      const rendered = await renderClient(<SelectRange selection={selection} />);
      route.setLocation.mockClear();

      await act(async () => rendered.container.querySelector('button')!.click());

      expect(route.setLocation).toHaveBeenCalledTimes(1);
      const url = new URL(route.setLocation.mock.calls[0][0], 'https://example.test');
      expect(url.searchParams.get('rangeType')).toBe(selection);
      for (const key of ['startDate', 'endDate', 'page']) expect(url.searchParams.has(key)).toBe(false);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        workspaceId: 'workspace-1',
        viewScope: 'my',
        tab: 'groups',
        search: 'ops',
      });
      await rendered.unmount();
    },
  );

  it('offers only Full term and Billing period while retaining the selected label', async () => {
    route.search = 'rangeType=billing';
    window.history.replaceState(null, '', `/?${route.search}`);
    const rendered = await renderClient(<RangeFilter selectedLabel="September 2026" />);

    expect([...rendered.container.querySelectorAll('[role="option"]')].map(node => node.textContent))
      .toEqual(['Full term', 'Billing period']);
    expect(rendered.container.textContent).toContain('September 2026');
    await rendered.unmount();
  });
});