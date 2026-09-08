import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLoginUrl,
  isEmbeddedPreview,
  navigateToLogin,
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

  it('assigns an absolute app-origin login URL for a direct visit', () => {
    const assign = vi.fn();
    const self = {};
    vi.stubGlobal('window', {
      self,
      top: self,
      location: {
        href: 'https://budget.example/spend?range=month',
        assign,
      },
    });

    expect(navigateToLogin('/spend?range=month')).toBe('_self');
    expect(assign).toHaveBeenCalledWith(
      'https://budget.example/api/login?returnTo=%2Fspend%3Frange%3Dmonth',
    );
  });

  it('navigates an accessible top frame using the app origin', () => {
    const topLocation = { href: 'https://parent.example/preview' };
    const self = {};
    vi.stubGlobal('window', {
      self,
      top: { location: topLocation },
      location: { href: 'https://budget.example/spend?range=month' },
      open: vi.fn(),
    });

    expect(navigateToLogin('/spend?range=month')).toBe('_top');
    expect(topLocation.href).toBe(
      'https://budget.example/api/login?returnTo=%2Fspend%3Frange%3Dmonth',
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it('opens a secure new tab when sandboxed top navigation throws', () => {
    const open = vi.fn();
    const topLocation = {};
    Object.defineProperty(topLocation, 'href', {
      set() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const self = {};
    vi.stubGlobal('window', {
      self,
      top: { location: topLocation },
      location: { href: 'https://budget.example/spend?range=month' },
      open,
    });

    expect(navigateToLogin('/spend?range=month')).toBe('_blank');
    expect(open).toHaveBeenCalledWith(
      'https://budget.example/api/login?returnTo=%2Fspend%3Frange%3Dmonth',
      '_blank',
      'noopener,noreferrer',
    );
  });
});