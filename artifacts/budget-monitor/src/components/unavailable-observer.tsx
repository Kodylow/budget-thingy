import { useEffect } from 'react';
import {
  currentDiagnosticRoute,
  getRecentDiagnosticRequestIds,
  getUiDiagnostics,
  recordUiDiagnostics,
  subscribeApiDiagnostics,
  type UiDiagnosticEntry,
  type UiDiagnosticSource,
} from '@workspace/api-client-react';

const MAX_ACTIVE_NODES = 2_000;
const MAX_QUEUE = 4_000;
const MAX_VISITS_PER_FRAME = 1_000;
const MAX_TEXT_CHARS_PER_FRAME = 128_000;
const MAX_FRAME_MS = 8;
const MAX_DIRECT_TEXT_NODES = 1_000;
const MAX_SELECTOR_DEPTH = 8;
const MAX_SIBLING_WALK = 100;
const OBSERVED_ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt'] as const;
type ObservedAttribute = typeof OBSERVED_ATTRIBUTES[number];
type ObservationKey = '#text' | ObservedAttribute;
interface ActiveValue { count: number; source: UiDiagnosticSource }
interface ScanTask { node: Node; descend: boolean }

function occurrenceCount(value: string, budget: number): { count: number; chars: number; truncated: boolean } {
  const length = Math.min(value.length, Math.max(0, budget));
  const count = value.slice(0, length).match(/unavailable/gi)?.length ?? 0;
  return { count, chars: length, truncated: length < value.length };
}

function ignoredElement(element: Element | null): boolean {
  for (let current = element as HTMLElement | null; current; current = current.parentElement) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || current.isContentEditable ||
        current.hasAttribute('data-diagnostic-ignore')) return true;
  }
  return false;
}

function elementSelector(element: Element): { selector: string; truncated: boolean } {
  const parts: string[] = [];
  let current: Element | null = element;
  let truncated = false;
  while (current && current !== document.documentElement && parts.length < MAX_SELECTOR_DEPTH) {
    const tag = current.tagName.toLowerCase();
    let sameTagBefore = 0;
    let siblingVisits = 0;
    let sibling = current.previousElementSibling;
    while (sibling && siblingVisits < MAX_SIBLING_WALK) {
      if (sibling.tagName === current.tagName) sameTagBefore += 1;
      siblingVisits += 1;
      sibling = sibling.previousElementSibling;
    }
    if (sibling) truncated = true;
    parts.unshift(sibling ? tag : `${tag}:nth-of-type(${sameTagBefore + 1})`);
    if (current === document.body) break;
    current = current.parentElement;
  }
  if (current && current !== document.body && current !== document.documentElement) truncated = true;
  return { selector: parts.join(' > ') || '[detached]', truncated };
}

export function unavailableNodeSource(
  node: Node,
  attribute?: ObservedAttribute,
): UiDiagnosticSource {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  const selector = element ? elementSelector(element) : { selector: '[detached]', truncated: true };
  const cell = element?.closest('td,th');
  const source: UiDiagnosticSource = {
    page: currentDiagnosticRoute(),
    selector: selector.selector,
    ...(attribute ? { attribute } : {}),
    ...(selector.truncated ? { truncated: true } : {}),
  };
  if (cell?.parentElement) {
    let columnIndex = 0;
    let siblingVisits = 0;
    let sibling = cell.previousElementSibling;
    while (sibling && siblingVisits < MAX_SIBLING_WALK) {
      if (sibling.tagName === 'TD' || sibling.tagName === 'TH') columnIndex += 1;
      siblingVisits += 1;
      sibling = sibling.previousElementSibling;
    }
    if (sibling) source.truncated = true;
    else source.columnIndex = columnIndex;
  }
  return source;
}

/** Bounded observer for rendered availability labels and native accessible labels. */
export function UnavailableObserver() {
  useEffect(() => {
    try {
      if (typeof MutationObserver === 'undefined' || !document.body) return undefined;
      const active = new Map<Node, Map<ObservationKey, ActiveValue>>();
      const queue: ScanTask[] = [];
      const queued = new Set<Node>();
      let cursor = 0;
      let frame: number | ReturnType<typeof setTimeout> | null = null;
      let frameIsTimeout = false;
      let droppedWork = 0;

      const emit = (
        event: UiDiagnosticEntry['event'],
        count: number,
        source: UiDiagnosticSource,
        truncated = false,
      ): UiDiagnosticEntry | null => {
        try {
          return {
            timestamp: new Date().toISOString(),
            event,
            reason: 'rendered_unavailable',
            source,
            count,
            requestIdCandidates: getRecentDiagnosticRequestIds(),
            ...(truncated ? { truncated: true } : {}),
          };
        } catch {
          return null;
        }
      };

      const enqueue = (node: Node, descend: boolean): boolean => {
        if (queued.has(node)) return true;
        if (queue.length - cursor >= MAX_QUEUE) {
          return false;
        }
        queued.add(node);
        queue.push({ node, descend });
        return true;
      };

      const update = (
        node: Node,
        key: ObservationKey,
        nextCount: number,
        source: UiDiagnosticSource,
        entries: UiDiagnosticEntry[],
      ) => {
        const values = active.get(node);
        const previous = values?.get(key);
        if (nextCount === 0) {
          if (previous) {
            const entry = emit('ui_data_available', previous.count, previous.source);
            if (entry) entries.push(entry);
            values?.delete(key);
            if (values?.size === 0) active.delete(node);
          }
          return;
        }
        if (!previous && active.size >= MAX_ACTIVE_NODES) {
          droppedWork += nextCount;
          return;
        }
        if (!previous) {
          const nextValues = values ?? new Map<ObservationKey, ActiveValue>();
          nextValues.set(key, { count: nextCount, source });
          active.set(node, nextValues);
          const entry = emit('ui_data_unavailable', nextCount, source);
          if (entry) entries.push(entry);
        } else if (previous.count !== nextCount) {
          const event = nextCount > previous.count ? 'ui_data_unavailable' : 'ui_data_available';
          const entry = emit(event, Math.abs(nextCount - previous.count), source);
          if (entry) entries.push(entry);
          values?.set(key, { count: nextCount, source });
        }
      };

      const process = () => {
        frame = null;
        try {
          const entries: UiDiagnosticEntry[] = [];
          let visits = 0;
          let chars = 0;
          const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
          active.forEach((values, node) => {
            if (node.isConnected) return;
            values.forEach(value => {
              const entry = emit('ui_unavailable_removed', value.count, value.source);
              if (entry) entries.push(entry);
            });
            active.delete(node);
          });
          while (cursor < queue.length && visits < MAX_VISITS_PER_FRAME &&
                 chars < MAX_TEXT_CHARS_PER_FRAME &&
                 (typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt < MAX_FRAME_MS) {
            const task = queue[cursor++];
            queued.delete(task.node);
            visits += 1;
            if (!task.node.isConnected) continue;
            if (task.node.nodeType === Node.TEXT_NODE) {
              const parent = task.node.parentElement;
              if (parent && !enqueue(parent, false)) droppedWork += 1;
              continue;
            }
            if (task.node.nodeType !== Node.ELEMENT_NODE) continue;
            const element = task.node as Element;
            if (ignoredElement(element)) continue;
            let directTextCount = 0;
            let directTextVisits = 0;
            let directTextTruncated = false;
            for (let child = element.firstChild; child; child = child.nextSibling) {
              if (directTextVisits >= MAX_DIRECT_TEXT_NODES ||
                  chars >= MAX_TEXT_CHARS_PER_FRAME ||
                  (typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt >= MAX_FRAME_MS) {
                directTextTruncated = true;
                break;
              }
              directTextVisits += 1;
              if (child.nodeType !== Node.TEXT_NODE) continue;
              const result = occurrenceCount(
                (child as Text).data,
                MAX_TEXT_CHARS_PER_FRAME - chars,
              );
              chars += result.chars;
              directTextCount += result.count;
              if (result.truncated) directTextTruncated = true;
            }
            if (directTextTruncated) droppedWork += 1;
            const previousText = active.get(element)?.get('#text');
            if (directTextCount > 0 || previousText) {
              update(
                element,
                '#text',
                directTextCount,
                previousText?.source ?? unavailableNodeSource(element),
                entries,
              );
            }
            for (const attribute of OBSERVED_ATTRIBUTES) {
              const value = element.getAttribute(attribute);
              const result = occurrenceCount(value ?? '', MAX_TEXT_CHARS_PER_FRAME - chars);
              chars += result.chars;
              if (result.truncated) droppedWork += 1;
              const previous = active.get(element)?.get(attribute);
              if (result.count > 0 || previous) {
                update(
                  element,
                  attribute,
                  result.count,
                  previous?.source ?? unavailableNodeSource(element, attribute),
                  entries,
                );
              }
              if (chars >= MAX_TEXT_CHARS_PER_FRAME) break;
            }
            if (task.descend) {
              for (let child = element.lastChild; child; child = child.previousSibling) {
                if (child.nodeType === Node.TEXT_NODE) continue;
                const elapsed = (typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt;
                if (elapsed >= MAX_FRAME_MS || !enqueue(child, true)) {
                  droppedWork += 1;
                  break;
                }
              }
            }
          }
          if (cursor > 0 && cursor === queue.length) {
            queue.length = 0;
            cursor = 0;
          }
          if (droppedWork > 0) {
            const entry = emit('ui_data_unavailable', droppedWork, {
              page: currentDiagnosticRoute(),
              selector: '[scan-truncated]',
              truncated: true,
            }, true);
            if (entry) entries.push(entry);
            droppedWork = 0;
          }
          try {
            recordUiDiagnostics(entries);
          } catch {
            // History subscribers are best effort.
          }
          for (const event of ['ui_data_unavailable', 'ui_data_available', 'ui_unavailable_removed'] as const) {
            const transitions = entries.filter(entry => entry.event === event).map(entry => ({
              reason: entry.reason,
              source: entry.source,
              count: entry.count,
              requestIdCandidates: entry.requestIdCandidates,
              ...(entry.truncated ? { truncated: true } : {}),
            }));
            if (transitions.length > 0) {
              try { console.warn(event, transitions); } catch { /* best effort */ }
            }
          }
        } catch {
          try {
            const failure = emit('ui_data_unavailable', 1, {
              page: currentDiagnosticRoute(),
              selector: '[instrumentation-failed]',
              truncated: true,
            }, true);
            if (failure) recordUiDiagnostics([failure]);
          } catch {
            // Never escape a MutationObserver callback.
          }
        }
        if (cursor < queue.length) schedule();
      };

      const schedule = () => {
        try {
          if (frame !== null) return;
          if (typeof requestAnimationFrame === 'function') {
            frameIsTimeout = false;
            frame = requestAnimationFrame(process);
          } else {
            frameIsTimeout = true;
            frame = setTimeout(process, 0);
          }
        } catch {
          // Observability setup is best effort.
        }
      };

      enqueue(document.body, true);
      process();
      const observer = new MutationObserver(records => {
        try {
          records.forEach(record => {
            if (record.type === 'characterData') {
              const parent = record.target.parentElement;
              if (parent && !enqueue(parent, false)) droppedWork += 1;
            } else if (record.type === 'attributes') {
              if (!enqueue(record.target, false)) droppedWork += 1;
            } else {
              for (const node of record.addedNodes) {
                const target = node.nodeType === Node.TEXT_NODE ? record.target : node;
                if (!enqueue(target, node.nodeType !== Node.TEXT_NODE)) {
                  droppedWork += 1;
                  break;
                }
              }
              if (!enqueue(record.target, false)) droppedWork += 1;
            }
          });
          schedule();
        } catch {
          droppedWork += 1;
          schedule();
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...OBSERVED_ATTRIBUTES],
      });
      let previousUiHistoryLength = getUiDiagnostics().length;
      const unsubscribe = subscribeApiDiagnostics(() => {
        try {
          const nextLength = getUiDiagnostics().length;
          if (previousUiHistoryLength > 0 && nextLength === 0) {
            active.clear();
            if (!enqueue(document.body, true)) droppedWork += 1;
            schedule();
          }
          previousUiHistoryLength = nextLength;
        } catch {
          // A diagnostics reset must not escape its listener.
        }
      });
      return () => {
        try { observer.disconnect(); } catch { /* best effort */ }
        try { unsubscribe(); } catch { /* best effort */ }
        if (frame !== null) {
          try {
            if (frameIsTimeout) clearTimeout(frame as ReturnType<typeof setTimeout>);
            else cancelAnimationFrame(frame as number);
          } catch { /* best effort */ }
        }
        active.clear();
        queue.length = 0;
        queued.clear();
      };
    } catch {
      return undefined;
    }
  }, []);
  return null;
}