import crypto from 'crypto';
import type { AuthUser } from '@workspace/api-zod';
import { db, sessionsTable } from '@workspace/db';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { type Request, type Response } from 'express';
import * as client from 'openid-client';

export const ISSUER_URL = process.env.ISSUER_URL ?? 'https://replit.com/oidc';
export const SESSION_COOKIE = 'sid';
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const SESSION_EXTENSION_WINDOW = 6 * 24 * 60 * 60 * 1000;
const SESSION_EXTENSION_INTERVAL = 24 * 60 * 60 * 1000;

export interface SessionData {
  user: AuthUser;
}

export interface SessionLookup {
  data: SessionData;
  extended: boolean;
}

let oidcConfig: client.Configuration | null = null;

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

export async function getSession(sid: string): Promise<SessionLookup | null> {
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
  if (row.expire.getTime() - now.getTime() < SESSION_EXTENSION_WINDOW) {
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
