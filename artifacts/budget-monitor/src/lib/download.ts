import { customFetch } from '@workspace/api-client-react';

export interface BlobDownloadOptions {
  filename: string;
  responseType?: 'blob';
}

/**
 * Download through the shared API transport so cookie/bearer authentication,
 * preview identity, and normal HTTP error handling match generated requests.
 */
export async function downloadAuthenticatedBlob(
  url: string,
  { filename }: BlobDownloadOptions,
): Promise<void> {
  const blob = await customFetch<Blob>(url, {
    credentials: 'include',
    responseType: 'blob',
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}