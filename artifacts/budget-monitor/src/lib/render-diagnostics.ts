import React, { type ErrorInfo } from 'react';
import { getRecentDiagnosticRequestIds } from '@workspace/api-client-react';

type RenderFailureScope = 'root' | 'org-budget-chart';
type FrameSource =
  | 'app-root'
  | 'org-budget-chart'
  | 'application-component'
  | 'application-page'
  | 'application-lib'
  | 'react-runtime'
  | 'recharts-runtime'
  | 'vite-runtime'
  | 'dependency'
  | 'built-asset';

interface SafeFrame {
  source: FrameSource;
  line?: number;
  column?: number;
}

const MAX_FRAMES = 8;
const MAX_COUNTER = 10_000;
const HOOK_NAMES = '(?:useState|useEffect|useLayoutEffect|useMemo|useCallback|useContext|useRef|useReducer|useSyncExternalStore|useId|useTransition|useDeferredValue|useInsertionEffect)';

let hmrConnected = false;
let hmrUpdateCount = 0;
let hmrErrorCount = 0;
let hmrLastEventAt: string | null = null;

function noteHmrEvent(event: 'connected' | 'update' | 'error' | 'disconnected'): void {
  hmrConnected = event === 'connected' || event === 'update'
    ? true
    : event === 'disconnected'
      ? false
      : hmrConnected;
  if (event === 'update') hmrUpdateCount = Math.min(MAX_COUNTER, hmrUpdateCount + 1);
  if (event === 'error') hmrErrorCount = Math.min(MAX_COUNTER, hmrErrorCount + 1);
  hmrLastEventAt = new Date().toISOString();
}

if (import.meta.hot) {
  import.meta.hot.on('vite:ws:connect', () => noteHmrEvent('connected'));
  import.meta.hot.on('vite:connected', () => noteHmrEvent('connected'));
  // Count before applying an update so a render failure during that update
  // can still be correlated without inspecting update payloads.
  import.meta.hot.on('vite:beforeUpdate', () => noteHmrEvent('update'));
  import.meta.hot.on('vite:error', () => noteHmrEvent('error'));
  import.meta.hot.on('vite:ws:disconnect', () => noteHmrEvent('disconnected'));
}

function safeMessage(error: unknown): string {
  try {
    return error instanceof Error && typeof error.message === 'string' ? error.message : '';
  } catch {
    return '';
  }
}

function classifyError(error: unknown): string {
  const message = safeMessage(error);
  if (message === 'ORG_CHART_INPUT_INCOMPATIBLE') return 'org_chart_input_incompatible';
  if (/^Invalid hook call(?:\.|$)/.test(message)) return 'invalid_hook_call';
  if (new RegExp(`^Cannot read properties of (?:null|undefined) \\(reading '${HOOK_NAMES}'\\)$`).test(message)) {
    return 'react_hook_dispatcher_unavailable';
  }
  try {
    if (error instanceof TypeError) return 'type_error';
    if (error instanceof Error) return 'render_error';
  } catch {
    // A hostile error-like object must not escape diagnostics.
  }
  return 'non_error_throw';
}

function frameSource(line: string): FrameSource | null {
  const normalized = line.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('/src/app.tsx')) return 'app-root';
  if (normalized.includes('/src/pages/org-budget-chart.tsx')) return 'org-budget-chart';
  if (normalized.includes('/node_modules/react/') || normalized.includes('/node_modules/react-dom/')) return 'react-runtime';
  if (normalized.includes('/node_modules/recharts/')) return 'recharts-runtime';
  if (normalized.includes('/@vite/client') || normalized.includes('/node_modules/vite/')) return 'vite-runtime';
  if (normalized.includes('/src/components/')) return 'application-component';
  if (normalized.includes('/src/pages/')) return 'application-page';
  if (normalized.includes('/src/lib/')) return 'application-lib';
  if (normalized.includes('/node_modules/')) return 'dependency';
  if (normalized.includes('/assets/')) return 'built-asset';
  return null;
}

function boundedPosition(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_000_000 ? parsed : undefined;
}

function sanitizeFrames(stack: unknown): SafeFrame[] {
  if (typeof stack !== 'string') return [];
  const frames: SafeFrame[] = [];
  for (const rawLine of stack.slice(0, 16_384).split('\n').slice(0, 40)) {
    const source = frameSource(rawLine);
    if (!source) continue;
    const location = rawLine.match(/:(\d{1,7})(?::(\d{1,7}))?(?:[)\s]|$)/);
    const frame: SafeFrame = { source };
    const line = boundedPosition(location?.[1]);
    const column = boundedPosition(location?.[2]);
    if (line !== undefined) frame.line = line;
    if (column !== undefined) frame.column = column;
    frames.push(frame);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

function errorStack(error: unknown): unknown {
  try {
    return error instanceof Error ? error.stack : undefined;
  } catch {
    return undefined;
  }
}

function componentStack(info: ErrorInfo): unknown {
  try {
    return info.componentStack;
  } catch {
    return undefined;
  }
}

function safeReactVersion(): string {
  try {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,32})?$/.test(React.version)
      ? React.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Emits a bounded, allowlist-only render failure report. It intentionally
 * retains no error text, function/component names, URLs, or application data.
 */
export function reportRenderFailure(
  error: unknown,
  info: ErrorInfo,
  scope: RenderFailureScope,
): void {
  try {
    console.error('ui_render_failed', {
      scope,
      classification: classifyError(error),
      timestamp: new Date().toISOString(),
      reactVersion: safeReactVersion(),
      errorFrames: sanitizeFrames(errorStack(error)),
      componentFrames: sanitizeFrames(componentStack(info)),
      requestIdCandidates: getRecentDiagnosticRequestIds(5),
      hmr: {
        available: Boolean(import.meta.hot),
        connected: hmrConnected,
        updateCount: hmrUpdateCount,
        errorCount: hmrErrorCount,
        lastEventAt: hmrLastEventAt,
      },
    });
  } catch {
    // Diagnostics must never replace or compound the original render failure.
  }
}