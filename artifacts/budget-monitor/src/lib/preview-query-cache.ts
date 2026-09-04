import { getPreviewAs } from '@workspace/api-client-react';

/**
 * Partitions every React Query cache entry by the effective preview identity.
 * This prevents identical generated query keys from crossing authorization
 * scopes while preserving the generated keys themselves.
 */
export function previewScopedQueryHash(queryKey: readonly unknown[]): string {
  return JSON.stringify([getPreviewAs(), queryKey]);
}