import type { AuthUserEnvelope } from "@workspace/api-client-react";

import type { AuthAvailability } from "./use-auth";

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
  const headers = new Headers();
  if (previewAs) headers.set("X-Preview-As", previewAs);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw new AuthRequestCancelledError();
    try {
      const response = await fetcher("/api/auth/user", {
        credentials: "include",
        headers,
        signal,
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
          await sleep(250 * 2 ** attempt);
          continue;
        }
        return { availability: "unavailable", envelope: null };
      }

      const envelope = await response.json() as AuthUserEnvelope;
      return {
        availability: !envelope.user
          ? "signed-out"
          : envelope.auth
            ? "authorized"
            : "denied",
        envelope,
      };
    } catch (error) {
      if (signal.aborted) throw new AuthRequestCancelledError();
      if (attempt + 1 >= maxAttempts) {
        return { availability: "unavailable", envelope: null };
      }
      await sleep(250 * 2 ** attempt);
    }
  }

  return { availability: "unavailable", envelope: null };
}