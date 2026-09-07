import type { AuthUserEnvelope } from "@workspace/api-client-react";

import type { AuthAvailability } from "./use-auth";
import { logAuthDebug } from "./auth-debug";

let requestSequence = 0;

export interface AuthRequestResult {
  availability: Exclude<AuthAvailability, "loading">;
  envelope: AuthUserEnvelope | null;
}

interface LoadAuthorizationOptions {
  previewAs: string | null;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
}

export class AuthRequestCancelledError extends Error {
  constructor() {
    super("Authorization request cancelled");
    this.name = "AuthRequestCancelledError";
  }
}

export function nextAuthorizationRequestVersion(version: number): number {
  return version + 1;
}

export async function loadAuthorization({
  previewAs,
  signal,
  fetcher = fetch,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  maxAttempts = 3,
}: LoadAuthorizationOptions): Promise<AuthRequestResult> {
  const request = ++requestSequence;
  const headers = new Headers();
  if (previewAs) headers.set("X-Preview-As", previewAs);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw new AuthRequestCancelledError();
    const started = Date.now();
    logAuthDebug('request.start', { request, attempt: attempt + 1, previewSelected: Boolean(previewAs) });
    try {
      const response = await fetcher("/api/auth/user", {
        credentials: "include",
        headers,
        signal,
      });
      logAuthDebug('request.response', {
        request, attempt: attempt + 1, status: response.status,
        durationMs: Date.now() - started, redirected: response.redirected,
      });
      if (response.status === 401) {
        return { availability: "signed-out", envelope: null };
      }
      if (response.status === 403) {
        return { availability: "denied", envelope: null };
      }
      if (response.status === 400 && previewAs) {
        return { availability: "invalid-preview", envelope: null };
      }
      if (!response.ok) {
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt + 1 < maxAttempts
        ) {
          logAuthDebug('request.retry', { request, reason: 'http-status', delayMs: 250 * 2 ** attempt });
          await sleep(250 * 2 ** attempt);
          continue;
        }
        return { availability: "unavailable", envelope: null };
      }

      const envelope = await response.json() as AuthUserEnvelope;
      // Without the complete revision, a background check cannot prove that
      // protected cached data still belongs to the caller's current scope.
      if (envelope.auth && (
        typeof envelope.auth.authorizationRevision !== "string" ||
        !envelope.auth.authorizationRevision
      )) {
        logAuthDebug('request.invalid-envelope', { request, reason: 'missing-authorization-revision' });
        return { availability: "unavailable", envelope: null };
      }
      logAuthDebug('request.identity', { request, hasUser: Boolean(envelope.user), hasAuthorization: Boolean(envelope.auth) });
      return {
        availability: !envelope.user
          ? "signed-out"
          : envelope.auth
            ? "authorized"
            : "denied",
        envelope,
      };
    } catch (error) {
      logAuthDebug('request.failure', {
        request, attempt: attempt + 1, aborted: signal.aborted,
        durationMs: Date.now() - started,
        reason: signal.aborted ? 'cancelled' : 'network-or-response-parse',
      });
      if (signal.aborted) throw new AuthRequestCancelledError();
      if (attempt + 1 >= maxAttempts) {
        return { availability: "unavailable", envelope: null };
      }
      logAuthDebug('request.retry', { request, reason: 'network-or-response-parse', delayMs: 250 * 2 ** attempt });
      await sleep(250 * 2 ** attempt);
    }
  }

  return { availability: "unavailable", envelope: null };
}