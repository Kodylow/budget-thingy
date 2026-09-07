import type { AuthUser } from '@workspace/api-zod';
import { type NextFunction, type Request, type Response } from 'express';

import {
  getSession,
  getSessionId,
  mayExtendCookieSession,
  SESSION_COOKIE,
  setSessionCookie,
} from '../lib/auth';

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

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const usesSessionCookie =
    req.headers.authorization?.startsWith('Bearer ') !== true &&
    req.cookies?.[SESSION_COOKIE] === sid;
  const session = await getSession(sid, {
    extend: !usesSessionCookie || mayExtendCookieSession(req),
  });
  if (!session) {
    next();
    return;
  }

  if (session.extended && req.cookies?.[SESSION_COOKIE] === sid) {
    setSessionCookie(res, sid);
  }

  req.user = session.data.user;
  next();
}
