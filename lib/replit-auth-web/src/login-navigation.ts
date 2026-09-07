export function isEmbeddedPreview(): boolean {
  return window.self !== window.top;
}

export function getLoginUrl(returnTo: string): string {
  return `/api/login?returnTo=${encodeURIComponent(returnTo)}`;
}