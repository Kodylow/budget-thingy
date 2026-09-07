import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { db, sessionsTable } from '@workspace/db';
import { eq, inArray, sql } from 'drizzle-orm';
import cookieParser from 'cookie-parser';
import express from 'express';

import { SESSION_COOKIE, SESSION_TTL } from '../lib/auth';
import { authMiddleware } from './authMiddleware';

const sessionIds: string[] = [];
let server: Server;
let baseUrl: string;
let sessionLogs: unknown[] = [];

function testUser(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    firstName: 'Session',
    lastName: 'Test',
    profileImageUrl: null,
  };
}

async function requestProtected(sid: string) {
  return fetch(`${baseUrl}/protected`, {
    headers: { cookie: `${SESSION_COOKIE}=${sid}` },
  });
}

async function requestProtectedCrossSite(sid: string) {
  return fetch(`${baseUrl}/protected`, {
    headers: {
      cookie: `${SESSION_COOKIE}=${sid}`,
      origin: 'https://attacker.replit.app',
      'sec-fetch-site': 'cross-site',
    },
  });
}

beforeAll(async () => {
  // Keep this focused test compatible with shared databases that have not yet
  // run the additive sliding-expiry migration.
  await db.execute(sql`
    ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS last_extended_at timestamp with time zone
  `);

  const app = express();
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.log = {
      info: (details: unknown) => sessionLogs.push(details),
    } as never;
    next();
  });
  app.use(authMiddleware);
  app.get('/api/auth/user', (req, res) => {
    res.json({ authenticated: req.isAuthenticated() });
  });
  app.get('/protected', (req, res) => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.json({ userId: req.user.id });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  sessionLogs = [];
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (sessionIds.length > 0) {
    await db
      .delete(sessionsTable)
      .where(inArray(sessionsTable.sid, sessionIds));
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('concurrent requests remain authenticated after the old OIDC token expiry', async () => {
  const sid = randomUUID();
  sessionIds.push(sid);
  const originalExpire = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

  await db.insert(sessionsTable).values({
    sid,
    // Deliberately retain the legacy fields to cover sessions created before
    // token refresh semantics were removed.
    sess: {
      user: testUser('concurrent-user'),
      access_token: 'expired-access-token',
      refresh_token: 'expired-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) - 60,
    },
    expire: originalExpire,
    lastExtendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const [first, second] = await Promise.all([
    requestProtected(sid),
    requestProtected(sid),
  ]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  await expect(first.json()).resolves.toEqual({ userId: 'concurrent-user' });
  await expect(second.json()).resolves.toEqual({ userId: 'concurrent-user' });

  const renewedCookies = [first, second]
    .map((response) => response.headers.get('set-cookie'))
    .filter((value): value is string => value !== null);
  expect(renewedCookies).toHaveLength(1);
  expect(renewedCookies[0]).toContain(`${SESSION_COOKIE}=${sid}`);
  expect(renewedCookies[0]).toContain('Max-Age=604800');
  expect(renewedCookies[0]).toContain('HttpOnly');
  expect(renewedCookies[0]).toContain('Secure');
  expect(renewedCookies[0]).toContain('SameSite=Lax');

  const [extended] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));
  expect(extended.expire.getTime()).toBeGreaterThan(originalExpire.getTime());
  expect(extended.expire.getTime()).toBeGreaterThan(
    Date.now() + SESSION_TTL - 60_000,
  );
});

test('an expired database session returns 401 and is deleted', async () => {
  const sid = randomUUID();
  sessionIds.push(sid);

  await db.insert(sessionsTable).values({
    sid,
    sess: { user: testUser('expired-user') },
    expire: new Date(Date.now() - 1_000),
    lastExtendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const response = await requestProtected(sid);
  expect(response.status).toBe(401);

  const rows = await db
    .select({ sid: sessionsTable.sid })
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));
  expect(rows).toEqual([]);
});

test('a cross-site GET cannot extend a cookie session', async () => {
  const sid = randomUUID();
  sessionIds.push(sid);
  const originalExpire = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

  await db.insert(sessionsTable).values({
    sid,
    sess: { user: testUser('cross-site-user') },
    expire: originalExpire,
    lastExtendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  const response = await requestProtectedCrossSite(sid);
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();

  const [unchanged] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));
  expect(unchanged.expire.getTime()).toBe(originalExpire.getTime());
});

test('auth endpoint session diagnostics expose only safe presence and status fields', async () => {
  const sid = randomUUID();
  sessionIds.push(sid);
  await db.insert(sessionsTable).values({
    sid,
    sess: { user: testUser('diagnostic-user') },
    expire: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    lastExtendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });

  await fetch(`${baseUrl}/api/auth/user`, {
    headers: {
      cookie: `${SESSION_COOKIE}=${sid}`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'document',
    },
  });
  await fetch(`${baseUrl}/api/auth/user`, {
    headers: {
      cookie: `${SESSION_COOKIE}=not-a-real-session-secret`,
      'sec-fetch-site': 'unexpected-secret-site',
      'sec-fetch-dest': 'unexpected-secret-dest',
    },
  });

  expect(sessionLogs).toEqual([
    {
      event: 'auth.session',
      cookiePresent: true,
      bearerPresent: false,
      sessionStatus: 'valid',
      refreshed: true,
      secFetchSite: 'same-origin',
      secFetchDest: 'document',
    },
    {
      event: 'auth.session',
      cookiePresent: true,
      bearerPresent: false,
      sessionStatus: 'invalid',
      refreshed: false,
    },
  ]);
  const serialized = JSON.stringify(sessionLogs);
  expect(serialized).not.toContain(sid);
  expect(serialized).not.toContain('not-a-real-session-secret');
  expect(serialized).not.toContain('unexpected-secret');
  expect(serialized).not.toContain('diagnostic-user');
});