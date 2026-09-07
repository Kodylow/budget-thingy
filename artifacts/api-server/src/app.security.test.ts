import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

import app from './app';
import { getSafeReturnTo } from './routes/auth';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('cross-origin request security', () => {
  it('keeps login and logout return paths on the trusted origin', () => {
    const origin = 'https://budget.example.com';

    expect(getSafeReturnTo('/dashboard?range=month#usage', origin)).toBe(
      '/dashboard?range=month#usage',
    );
    expect(getSafeReturnTo('//attacker.invalid/path', origin)).toBe('/');
    expect(getSafeReturnTo('/\\attacker.invalid/path', origin)).toBe('/');
    expect(getSafeReturnTo('https://attacker.invalid/path', origin)).toBe('/');
  });

  it('allows credentialed CORS only for the exact request origin', async () => {
    const sameOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: baseUrl },
    });
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBe(baseUrl);
    expect(sameOrigin.headers.get('access-control-allow-credentials')).toBe('true');

    const siblingOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: 'https://attacker.replit.app' },
    });
    expect(siblingOrigin.headers.get('access-control-allow-origin')).toBeNull();
    expect(siblingOrigin.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('rejects cross-origin state changes carrying the session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`, {
      method: 'POST',
      headers: {
        cookie: 'sid=attacker-controlled-example',
        origin: 'https://attacker.replit.app',
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: 'Cross-origin request rejected',
    });
  });

  it('ignores spoofed forwarding headers in CORS and CSRF decisions', async () => {
    const headers = {
      cookie: 'sid=attacker-controlled-example',
      origin: 'https://attacker.replit.app',
      'x-forwarded-host': 'attacker.replit.app',
      'x-forwarded-proto': 'https',
    };
    const readResponse = await fetch(`${baseUrl}/api/health`, { headers });
    expect(readResponse.headers.get('access-control-allow-origin')).toBeNull();

    const writeResponse = await fetch(`${baseUrl}/api/does-not-exist`, {
      method: 'POST',
      headers,
    });
    expect(writeResponse.status).toBe(403);
  });

  it('does not authorize hostile preflight requests', async () => {
    const response = await fetch(`${baseUrl}/api/groups/example/budget`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://attacker.replit.app',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('rejects cookie-authenticated state changes without an Origin header', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`, {
      method: 'DELETE',
      headers: { cookie: 'sid=attacker-controlled-example' },
    });

    expect(response.status).toBe(403);
  });

  it('allows same-origin state changes through to normal authentication', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`, {
      method: 'POST',
      headers: {
        cookie: 'sid=attacker-controlled-example',
        origin: baseUrl,
      },
    });

    expect(response.status).not.toBe(403);
  });

  it('does not expose a state-changing GET logout endpoint', async () => {
    const response = await fetch(`${baseUrl}/api/logout`, {
      redirect: 'manual',
      headers: {
        cookie: 'sid=attacker-controlled-example',
        'sec-fetch-site': 'cross-site',
      },
    });

    expect(response.status).not.toBe(302);
  });

  it('does not apply the cookie CSRF gate to requests without session cookies', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`, {
      method: 'POST',
      headers: { origin: 'https://attacker.replit.app' },
    });

    expect(response.status).not.toBe(403);
  });
});