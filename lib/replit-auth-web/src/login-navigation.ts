export function isEmbeddedPreview(): boolean {
  return window.self !== window.top;
}

export function getLoginUrl(returnTo: string): string {
  return `/api/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Navigate explicitly so a synchronous auth-state render cannot cancel the link. */
export function navigateToLogin(returnTo: string): '_self' | '_top' | '_blank' {
  const url = new URL(getLoginUrl(returnTo), window.location.href).href;
  if (!isEmbeddedPreview()) {
    window.location.assign(url);
    return '_self';
  }
  try {
    window.top!.location.href = url;
    return '_top';
  } catch {
    // Sandboxed previews may forbid top navigation but permit user-click popups.
    window.open(url, '_blank', 'noopener,noreferrer');
    return '_blank';
  }
}