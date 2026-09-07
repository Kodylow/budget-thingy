import { isEmbeddedPreview } from './login-navigation';

// A fresh, non-identifying label per document makes reload loops visible.
const documentId = Math.random().toString(36).slice(2, 10);
let sequence = 0;

/** Only pass fixed event/reason labels, counts, and booleans. Never auth data or URLs. */
export function logAuthDebug(
  event: string,
  details: Record<string, string | number | boolean | null> = {},
): void {
  try {
    console.info('[auth-debug]', JSON.stringify({
      event,
      documentId,
      sequence: ++sequence,
      at: new Date().toISOString(),
      embedded: typeof window !== 'undefined' && isEmbeddedPreview(),
      ...details,
    }));
  } catch {
    // Diagnostics must not interrupt login, including in restricted browsers.
  }
}