import crypto from 'crypto';
import type { AuthUser } from '@workspace/api-zod';
import { db, sessionsTable } from '@workspace/db';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { type NextFunction, type Request, type Response } from 'express';
import * as client from 'openid-client';

export const ISSUER_URL = process.env.ISSUER_URL ?? 'https://replit.com/oidc';
export const SESSION_COOKIE = 'sid';
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const SESSION_EXTENSION_WINDOW = 6 * 24 * 60 * 60 * 1000;
const SESSION_EXTENSION_INTERVAL = 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface SessionData {
  user: AuthUser;
}

export interface SessionLookup {
  data: SessionData;
  extended: boolean;
}

let oidcConfig: client.Configuration | null = null;

function configuredOriginForHost(host: string): string | undefined {
  const appBaseUrl = process.env.APP_BASE_URL;
  if (appBaseUrl) {
    try {
      const configured = new URL(appBaseUrl);
      if (configured.protocol === 'https:' || configured.protocol === 'http:') {
        return configured.origin;
      }
    } catch {
      // Invalid configuration is handled by the production guard below.
    }
  }

  const replitDomains = process.env.REPLIT_DOMAINS?.split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);
  if (replitDomains?.includes(host)) {
    return `https://${host}`;
  }

  return undefined;
}

export function getRequestOrigin(req: Request): string {
  const host = req.headers.host;

  if (!host) {
    throw new Error('Cannot determine the request origin without a Host header');
  }

  const configuredOrigin = configuredOriginForHost(host);
  if (configuredOrigin) return configuredOrigin;

  if (process.env.NODE_ENV === 'production') {
    throw new Error('No trusted public origin is configured for this host');
  }

  return new URL(`${req.protocol}://${host}`).origin;
}

export function requireSameOriginForCookieMutations(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const hasSessionCookie = typeof req.cookies?.[SESSION_COOKIE] === 'string';
  const usesBearerToken = req.headers.authorization?.startsWith('Bearer ') === true;

  if (SAFE_METHODS.has(req.method) || !hasSessionCookie || usesBearerToken) {
    next();
    return;
  }

  const origin = req.headers.origin;
  let expectedOrigin: string;
  try {
    expectedOrigin = getRequestOrigin(req);
  } catch {
    res.status(400).json({ message: 'Invalid request origin' });
    return;
  }

  if (origin !== expectedOrigin) {
    res.status(403).json({ message: 'Cross-origin request rejected' });
    return;
  }

  next();
}

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(ISSUER_URL),
      process.env.REPL_ID!,
    );
  }
  return oidcConfig;
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(now.getTime() + SESSION_TTL),
    lastExtendedAt: now,
  });
  return sid;
}

export async function getSession(
  sid: string,
  options: { extend?: boolean } = {},
): Promise<SessionLookup | null> {
  const now = new Date();
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire <= now) {
    if (row) await deleteSession(sid);
    return null;
  }

  let extended = false;
  if (
    options.extend !== false &&
    row.expire.getTime() - now.getTime() < SESSION_EXTENSION_WINDOW
  ) {
    const updated = await db
      .update(sessionsTable)
      .set({
        expire: new Date(now.getTime() + SESSION_TTL),
        lastExtendedAt: now,
      })
      .where(
        and(
          eq(sessionsTable.sid, sid),
          gt(sessionsTable.expire, now),
          or(
            isNull(sessionsTable.lastExtendedAt),
            lt(
              sessionsTable.lastExtendedAt,
              new Date(now.getTime() - SESSION_EXTENSION_INTERVAL),
            ),
          ),
        ),
      )
      .returning({ sid: sessionsTable.sid });
    extended = updated.length > 0;
  }

  return {
    data: row.sess as unknown as SessionData,
    extended,
  };
}

export function mayExtendCookieSession(req: Request): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    return origin === getRequestOrigin(req);
  } catch {
    return false;
  }
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function setSessionCookie(res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}
