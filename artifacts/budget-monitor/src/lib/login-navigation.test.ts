import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLoginUrl,
  isEmbeddedPreview,
} from '@workspace/replit-auth-web';

afterEach(() => vi.unstubAllGlobals());

function browser(embedded: boolean): void {
  const self = {};
  vi.stubGlobal('window', {
    self,
    top: embedded ? {} : self,
  });
}

describe('login navigation', () => {
  it('preserves the requested route and query string', () => {
    expect(getLoginUrl('/spend?range=month')).toBe(
      '/api/login?returnTo=%2Fspend%3Frange%3Dmonth',
    );
  });

  it('detects an embedded preview', () => {
    browser(true);
    expect(isEmbeddedPreview()).toBe(true);
  });

  it('detects a direct visit', () => {
    browser(false);
    expect(isEmbeddedPreview()).toBe(false);
  });
});