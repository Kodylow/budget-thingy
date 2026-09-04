import React, {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type FocusEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

interface VirtualizedTableRowsProps {
  children: ReactNode;
  columnCount: number;
  estimatedRowHeight?: number;
  logicalRowIndexOffset?: number;
  className?: string;
}

export function getMeasuredVirtualWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  estimatedRowHeight: number,
  measuredHeights: ReadonlyMap<number, number>,
  overscan = 6,
) {
  const offsets = [0];
  for (let index = 0; index < rowCount; index += 1) {
    offsets.push(offsets[index]! + (measuredHeights.get(index) ?? estimatedRowHeight));
  }
  const firstVisible = offsets.findIndex((offset, index) =>
    index < rowCount && offsets[index + 1]! > scrollTop);
  const start = Math.max(0, (firstVisible < 0 ? rowCount : firstVisible) - overscan);
  const visibleBottom = scrollTop + viewportHeight;
  let end = start;
  while (end < rowCount && offsets[end]! < visibleBottom) end += 1;
  end = Math.min(rowCount, end + overscan);
  return {
    start,
    end,
    before: offsets[start] ?? 0,
    after: Math.max(0, offsets[rowCount]! - (offsets[end] ?? 0)),
    offsets,
  };
}

export function getRestoredFocusIndex(
  focused: { index: number; key: string } | null,
  nextRowKeys: readonly string[],
): number | null {
  if (!focused || nextRowKeys.length === 0 || nextRowKeys.includes(focused.key)) {
    return null;
  }
  return Math.min(focused.index, nextRowKeys.length - 1);
}

export function VirtualizedTableRows({
  children,
  columnCount,
  estimatedRowHeight = 64,
  logicalRowIndexOffset = 0,
  className,
}: VirtualizedTableRowsProps) {
  const rows = useMemo(() => {
    const flatten = (nodes: ReactNode): ReactNode[] =>
      Children.toArray(nodes).flatMap((node) =>
        isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment
          ? flatten(node.props.children)
          : [node],
      );
    return flatten(children);
  }, [children]);
  const rowKeys = useMemo(() => rows.map((row, index) =>
    isValidElement(row) && row.key !== null ? String(row.key) : `row-${index}`), [rows]);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 640 });
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const heightsRef = useRef(new Map<number, number>());
  const pendingFocusRef = useRef<{ index: number; edge: 'first' | 'last' } | null>(null);
  const focusedRowRef = useRef<{ index: number; key: string } | null>(null);

  useEffect(() => {
    const scrollElement = bodyRef.current?.closest<HTMLElement>('[data-virtual-scroll]');
    if (!scrollElement) return;
    const update = () => {
      setViewport({
        scrollTop: scrollElement.scrollTop,
        height: scrollElement.clientHeight,
      });
    };
    update();
    scrollElement.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(update);
    observer?.observe(scrollElement);
    return () => {
      scrollElement.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, []);

  const window = useMemo(() => getMeasuredVirtualWindow(
    rows.length,
    viewport.scrollTop,
    viewport.height,
    estimatedRowHeight,
    heightsRef.current,
  ), [rows.length, viewport, estimatedRowHeight, measurementVersion]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const measuredRows = bodyRef.current?.querySelectorAll<HTMLElement>('[data-virtual-row-index]');
    if (!measuredRows?.length) return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.virtualRowIndex);
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (height > 0 && Math.abs((heightsRef.current.get(index) ?? 0) - height) > 0.5) {
          heightsRef.current.set(index, height);
          changed = true;
        }
      }
      if (changed) setMeasurementVersion((version) => version + 1);
    });
    measuredRows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [window.start, window.end, rows]);

  useEffect(() => {
    heightsRef.current.clear();
    setMeasurementVersion((version) => version + 1);
    const restoredIndex = getRestoredFocusIndex(focusedRowRef.current, rowKeys);
    if (restoredIndex !== null) {
      pendingFocusRef.current = { index: restoredIndex, edge: 'first' };
      focusLogicalRow(restoredIndex, 'first');
    }
  }, [rows, rowKeys]);

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `[data-virtual-row-index="${pending.index}"]`,
    );
    if (!row) return;
    const focusable = getFocusableElements(row);
    const target = pending.edge === 'last'
      ? focusable.at(-1)
      : focusable[0];
    (target ?? row).focus();
    pendingFocusRef.current = null;
  }, [window.start, window.end]);

  const focusLogicalRow = (index: number, edge: 'first' | 'last') => {
    if (index < 0 || index >= rows.length) return;
    const mountedRow = bodyRef.current?.querySelector<HTMLElement>(
      `[data-virtual-row-index="${index}"]`,
    );
    if (mountedRow) {
      const focusable = getFocusableElements(mountedRow);
      const target = edge === 'last' ? focusable.at(-1) : focusable[0];
      (target ?? mountedRow).focus();
      mountedRow.scrollIntoView({ block: 'nearest' });
      return;
    }
    const scrollElement = bodyRef.current?.closest<HTMLElement>('[data-virtual-scroll]');
    if (!scrollElement) return;
    pendingFocusRef.current = { index, edge };
    scrollElement.scrollTop = window.offsets[index] ?? index * estimatedRowHeight;
    setViewport({
      scrollTop: scrollElement.scrollTop,
      height: scrollElement.clientHeight,
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-virtual-row-index]');
    if (!row) return;
    const index = Number(row.dataset.virtualRowIndex);

    if (target === row && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      focusLogicalRow(index + (event.key === 'ArrowDown' ? 1 : -1), 'first');
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(row);
    const atForwardEdge = !event.shiftKey && target === focusable.at(-1);
    const atBackwardEdge = event.shiftKey && target === focusable[0];
    if (atForwardEdge && index === window.end - 1 && index < rows.length - 1) {
      event.preventDefault();
      focusLogicalRow(index + 1, 'first');
    } else if (atBackwardEdge && index === window.start && index > 0) {
      event.preventDefault();
      focusLogicalRow(index - 1, 'last');
    }
  };

  const handleFocus = (event: FocusEvent<HTMLTableSectionElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-row-index]');
    focusedRowRef.current = row ? {
      index: Number(row.dataset.virtualRowIndex),
      key: row.dataset.virtualRowKey ?? '',
    } : null;
  };

  const handleBlur = (event: FocusEvent<HTMLTableSectionElement>) => {
    if (event.relatedTarget && !bodyRef.current?.contains(event.relatedTarget as Node)) {
      focusedRowRef.current = null;
    }
  };

  return (
    <tbody
      ref={bodyRef}
      className={className}
      data-testid="virtualized-table-body"
      onKeyDownCapture={handleKeyDown}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
    >
      {window.before > 0 && (
        <tr aria-hidden="true">
          <td colSpan={columnCount} style={{ height: window.before, padding: 0, border: 0 }} />
        </tr>
      )}
      {rows.slice(window.start, window.end).map((row, offset) =>
        isValidElement(row)
          ? cloneElement(row, {
              'data-virtual-row-index': window.start + offset,
              'data-virtual-row-key': rowKeys[window.start + offset],
              'aria-rowindex': logicalRowIndexOffset + window.start + offset + 2,
              tabIndex: 0,
            } as never)
          : row,
      )}
      {window.after > 0 && (
        <tr aria-hidden="true">
          <td colSpan={columnCount} style={{ height: window.after, padding: 0, border: 0 }} />
        </tr>
      )}
    </tbody>
  );
}

function getFocusableElements(row: HTMLElement): HTMLElement[] {
  const descendants = Array.from(row.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ));
  return row.tabIndex >= 0 ? [row, ...descendants] : descendants;
}