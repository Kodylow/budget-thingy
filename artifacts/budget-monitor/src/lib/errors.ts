import { createElement, useEffect } from 'react';
import type { Query, QueryClient } from '@tanstack/react-query';
import { ToastAction, type ToastActionElement } from '../components/ui/toast';
import { toast } from '../hooks/use-toast';

export type ErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'server'
  | 'network'
  | 'validation';

export interface ErrorDescription {
  title: string;
  detail: string;
  kind: ErrorKind;
}

interface ToastControl {
  dismiss: () => void;
}

interface UsageHealthData {
  usageHealth?: {
    status?: string;
    coverage?: {
      ratio?: number;
    };
  };
}

export function updateNoticeState(
  activeKeys: Set<string>,
  key: string,
  isActive: boolean,
): 'activated' | 'cleared' | 'unchanged' {
  if (isActive) {
    if (activeKeys.has(key)) return 'unchanged';
    activeKeys.add(key);
    return 'activated';
  }
  if (!activeKeys.delete(key)) return 'unchanged';
  return 'cleared';
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  return error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : null;
}

export function getErrorStatus(error: unknown): number | null {
  const status = errorRecord(error)?.status;
  return typeof status === 'number' ? status : null;
}

function getErrorUrl(error: unknown, fallbackUrl = 'request'): string {
  const url = errorRecord(error)?.url;
  return typeof url === 'string' && url.length > 0 ? url : fallbackUrl;
}

export function describeError(error: unknown): ErrorDescription {
  const status = getErrorStatus(error);

  if (status === 401) {
    return {
      kind: 'auth',
      title: 'Session expired',
      detail: 'Sign in again to continue.',
    };
  }
  if (status === 403) {
    return {
      kind: 'permission',
      title: 'Access denied',
      detail: 'You do not have permission to complete this request.',
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      title: 'Not found',
      detail: 'The requested data is no longer available.',
    };
  }
  if (status !== null && status >= 500) {
    return {
      kind: 'server',
      title: 'Service unavailable',
      detail: 'The server could not complete the request. Please try again.',
    };
  }
  if (
    status === null &&
    (error instanceof TypeError ||
      (error instanceof Error && /network|fetch|offline/i.test(error.message)))
  ) {
    return {
      kind: 'network',
      title: 'Connection problem',
      detail: 'Check your connection and try again.',
    };
  }
  return {
    kind: 'validation',
    title: 'Check your request',
    detail: 'The request could not be completed. Check the information and try again.',
  };
}

/** TanStack retry policy: retry transient failures once, never client failures. */
export function shouldRetryRequest(failureCount: number, error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403 || status === 404) return false;
  return failureCount < 1 && (status === null || status >= 500);
}

const DEDUPE_MS = 30_000;
const recentToasts = new Map<string, number>();

function fallbackQueryUrl(query: Query): string {
  const first = query.queryKey[0];
  return typeof first === 'string' ? first : JSON.stringify(query.queryKey);
}

function showErrorToast(
  queryClient: QueryClient,
  error: unknown,
  fallbackUrl: string,
  query?: Query,
): ToastControl | null {
  const detail = describeError(error);
  const url = getErrorUrl(error, fallbackUrl);
  // A 401 immediately transitions to login, so a toast would only flash.
  if (detail.kind === 'auth') return null;

  const dedupeKey = `${detail.kind}:${url}`;
  const now = Date.now();
  if (now - (recentToasts.get(dedupeKey) ?? 0) < DEDUPE_MS) return null;
  recentToasts.set(dedupeKey, now);

  return toast({
    title: detail.title,
    description: detail.detail,
    variant: 'destructive',
    action: query
      ? createElement(
          ToastAction,
          {
            altText: 'Retry request',
            onClick: () => {
              void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
            },
          },
          'Retry',
        ) as unknown as ToastActionElement
      : undefined,
  });
}

export function getUsageHealthWarning(data: unknown): 'partial' | 'stale' | null {
  if (!data || typeof data !== 'object') return null;
  const usageHealth = (data as UsageHealthData).usageHealth;
  if (!usageHealth) return null;
  if (usageHealth.status === 'stale') return 'stale';
  if (usageHealth.status === 'partial' && (usageHealth.coverage?.ratio ?? 0) < 1) {
    return 'partial';
  }
  return null;
}

/**
 * Connects TanStack query and mutation events to deduplicated operational
 * notices. Exported separately from the React hook so the full event path can
 * be verified without mounting the application.
 */
export function subscribeApiErrorToasts(queryClient: QueryClient): () => void {
  const activeQueryErrors = new Map<string, ToastControl>();
  const activeQueryErrorKeys = new Set<string>();
  const degradedQueries = new Map<string, 'partial' | 'stale'>();
  let usageHealthToast: ToastControl | null = null;

  const updateUsageHealthToast = () => {
    if (degradedQueries.size > 0 && !usageHealthToast) {
      const hasPartial = [...degradedQueries.values()].includes('partial');
      usageHealthToast = toast({
        title: hasPartial ? 'Some usage data is still updating' : 'Usage data may be out of date',
        description: 'Available values remain visible and refresh automatically.',
      });
    } else if (degradedQueries.size === 0 && usageHealthToast) {
      usageHealthToast.dismiss();
      usageHealthToast = null;
    }
  };

  const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'removed') {
      activeQueryErrors.get(event.query.queryHash)?.dismiss();
      activeQueryErrors.delete(event.query.queryHash);
      updateNoticeState(activeQueryErrorKeys, event.query.queryHash, false);
      degradedQueries.delete(event.query.queryHash);
      updateUsageHealthToast();
      return;
    }
    if (event.type !== 'updated') return;

    if (event.action.type === 'error') {
      if (
        updateNoticeState(activeQueryErrorKeys, event.query.queryHash, true) === 'unchanged'
      ) return;
      const control = showErrorToast(
        queryClient,
        event.query.state.error,
        fallbackQueryUrl(event.query),
        event.query,
      );
      if (control) activeQueryErrors.set(event.query.queryHash, control);
      else updateNoticeState(activeQueryErrorKeys, event.query.queryHash, false);
      return;
    }
    if (event.action.type !== 'success') return;

    activeQueryErrors.get(event.query.queryHash)?.dismiss();
    activeQueryErrors.delete(event.query.queryHash);
    updateNoticeState(activeQueryErrorKeys, event.query.queryHash, false);

    const warning = getUsageHealthWarning(event.query.state.data);
    if (warning) degradedQueries.set(event.query.queryHash, warning);
    else degradedQueries.delete(event.query.queryHash);
    updateUsageHealthToast();
  });
  const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'error') return;
    const mutationKey = event.mutation.options.mutationKey;
    showErrorToast(
      queryClient,
      event.mutation.state.error,
      mutationKey ? JSON.stringify(mutationKey) : 'mutation',
    );
  });

  return () => {
    activeQueryErrors.forEach((control) => control.dismiss());
    usageHealthToast?.dismiss();
    unsubscribeQueries();
    unsubscribeMutations();
  };
}

/**
 * Subscribes once at the application root. Components keep stale data visible
 * and leave operational presentation to this hook.
 */
export function useApiErrorToasts(queryClient: QueryClient): void {
  useEffect(() => subscribeApiErrorToasts(queryClient), [queryClient]);
}