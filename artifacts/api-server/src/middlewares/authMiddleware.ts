import type { AuthUser } from '@workspace/api-zod';
import { type NextFunction, type Request, type Response } from 'express';

import {
  getSession,
  getSessionId,
  mayExtendCookieSession,
  SESSION_COOKIE,
  setSessionCookie,
} from '../lib/auth';
import {
  DEV_VIEW_AS_HEADER,
  InvalidDevViewSelectionError,
  isDevViewEnabled,
  resolveDevViewMember,
} from '../lib/dev-view';

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
      devViewAs?: boolean;
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

  if (isDevViewEnabled() && req.header(DEV_VIEW_AS_HEADER)) {
    try {
      const member = await resolveDevViewMember(req);
      const nameParts = member.name?.trim().split(/\s+/) ?? [];
      req.user = {
        id: member.userId,
        email: member.email,
        firstName: nameParts.shift() ?? member.username,
        lastName: nameParts.length > 0 ? nameParts.join(' ') : null,
        profileImageUrl: null,
      };
      req.devViewAs = true;
      next();
    } catch (error) {
      if (error instanceof InvalidDevViewSelectionError) {
        res.status(400).json({ error: error.message });
        return;
      }
      req.log.error(
        { event: 'auth.dev-view', outcome: 'unavailable' },
        'development directory lookup unavailable',
      );
      res.status(503).json({
        enabled: true,
        error: 'Development directory temporarily unavailable',
        retryable: true,
      });
    }
    return;
  }

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
