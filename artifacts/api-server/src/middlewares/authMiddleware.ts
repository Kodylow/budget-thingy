import type { AuthUser } from '@workspace/api-zod';
import { type NextFunction, type Request, type Response } from 'express';

import {
  getSession,
  getSessionId,
  mayExtendCookieSession,
  SESSION_COOKIE,
  setSessionCookie,
} from '../lib/auth';

const AUTH_DIAGNOSTIC_ENDPOINTS = new Set([
  '/api/auth/user',
  '/api/auth/me/debug',
  '/api/login',
  '/api/callback',
  '/api/logout',
  '/api/mobile-auth/token-exchange',
  '/api/mobile-auth/logout',
]);
const FETCH_SITES = new Set(['cross-site', 'same-origin', 'same-site', 'none']);
const FETCH_DESTINATIONS = new Set([
  'audio',
  'audioworklet',
  'document',
  'embed',
  'empty',
  'font',
  'frame',
  'iframe',
  'image',
  'manifest',
  'object',
  'paintworklet',
  'report',
  'script',
  'serviceworker',
  'sharedworker',
  'style',
  'track',
  'video',
  'webidentity',
  'worker',
  'xslt',
]);

function safeFetchMetadata(req: Request) {
  const site = req.headers['sec-fetch-site'];
  const destination = req.headers['sec-fetch-dest'];
  return {
    ...(typeof site === 'string' && FETCH_SITES.has(site)
      ? { secFetchSite: site }
      : {}),
    ...(typeof destination === 'string' && FETCH_DESTINATIONS.has(destination)
      ? { secFetchDest: destination }
      : {}),
  };
}

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      isAuthenticated(): this is AuthedRequest;

      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request['isAuthenticated'];

  const diagnostic = AUTH_DIAGNOSTIC_ENDPOINTS.has(req.path);
  const cookiePresent = typeof req.cookies?.[SESSION_COOKIE] === 'string';
  const bearerPresent =
    req.headers.authorization?.startsWith('Bearer ') === true;
  const sid = getSessionId(req);
  if (!sid) {
    if (diagnostic) {
      req.log.info({
        event: 'auth.session',
        cookiePresent,
        bearerPresent,
        sessionStatus: 'absent',
        refreshed: false,
        ...safeFetchMetadata(req),
      });
    }
    next();
    return;
  }

  const usesSessionCookie =
    !bearerPresent &&
    req.cookies?.[SESSION_COOKIE] === sid;
  const session = await getSession(sid, {
    extend: !usesSessionCookie || mayExtendCookieSession(req),
  });
  if (!session) {
    if (diagnostic) {
      req.log.info({
        event: 'auth.session',
        cookiePresent,
        bearerPresent,
        sessionStatus: 'invalid',
        refreshed: false,
        ...safeFetchMetadata(req),
      });
    }
    next();
    return;
  }

  if (session.extended && req.cookies?.[SESSION_COOKIE] === sid) {
    setSessionCookie(res, sid);
  }

  req.user = session.data.user;
  if (diagnostic) {
    req.log.info({
      event: 'auth.session',
      cookiePresent,
      bearerPresent,
      sessionStatus: 'valid',
      refreshed: session.extended,
      ...safeFetchMetadata(req),
    });
  }
  next();
}
