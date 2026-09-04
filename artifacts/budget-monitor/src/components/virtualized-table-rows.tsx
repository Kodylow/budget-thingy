import React, {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getVirtualWindow } from '@/lib/client-performance';

interface VirtualizedTableRowsProps {
  children: ReactNode;
  columnCount: number;
  estimatedRowHeight?: number;
  className?: string;
}

export function VirtualizedTableRows({
  children,
  columnCount,
  estimatedRowHeight = 64,
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
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 640 });
  const pendingFocusRef = useRef<{ index: number; edge: 'first' | 'last' } | null>(null);

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
    const observer = new ResizeObserver(update);
    observer.observe(scrollElement);
    return () => {
      scrollElement.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, []);

  const window = getVirtualWindow(
    rows.length,
    viewport.scrollTop,
    viewport.height,
    estimatedRowHeight,
  );

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
    scrollElement.scrollTop = index * estimatedRowHeight;
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

  return (
    <tbody
      ref={bodyRef}
      className={className}
      data-testid="virtualized-table-body"
      onKeyDownCapture={handleKeyDown}
    >
      {window.before > 0 && (
        <tr aria-hidden="true">
          <td colSpan={columnCount} style={{ height: window.before, padding: 0, border: 0 }} />
        </tr>
      )}
      {rows.slice(window.start, window.end).map((row, offset) =>
        isValidElement(row)
          ? cloneElement(row, { 'data-virtual-row-index': window.start + offset } as never)
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