import { type NextFunction, type Request, type Response } from "express";
import {
  resolveCurrentAuthorization,
  type Authorization,
} from "../lib/authz";

export { setAuthorizationResolver } from "../lib/authz";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Resolved Enterprise authorization for the signed-in user, attached by
       * `requireAuth`. Present only after `requireAuth` has run and allowed the
       * request through.
       */
      authz?: Authorization | undefined;
    }
  }
}

/**
 * Require an authenticated, authorized user for a route.
 *
 * - 401 when there is no valid session (unauthenticated).
 * - 403 when the signed-in user is neither an account admin nor an enabled
 *   workspace admin (access denied), returned as a non-disclosing message.
 * - Otherwise attaches `req.authz` and continues.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  let authz: Authorization | null;
  try {
    authz = await resolveCurrentAuthorization(req.user.id);
  } catch (err) {
    req.log.error({ err }, "authorization resolution failed");
    // Fail closed: an error resolving scope must not grant access.
    res.status(403).json({ error: "Access denied" });
    return;
  }
  if (!authz) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  req.authz = authz;
  next();
}

/**
 * Require that the authenticated user is a *true* Enterprise account admin.
 * Must run after `requireAuth` has populated `req.authz`. Reserved for
 * privilege management (e.g. editing the editor allowlist): persisted editors
 * and workspace admins get a non-disclosing 403.
 */
export function requireAccountAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.authz?.role !== "account_admin") {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
}

/**
 * Require that the authenticated user is an account-wide operator: either a
 * true account admin or a persisted account editor. Must run after
 * `requireAuth` has populated `req.authz`. Used for account-wide operational
 * controls (setting/removing pools) that editors may perform. Workspace admins
 * get a non-disclosing 403.
 */
export function requireAccountOperator(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const role = req.authz?.role;
  if (role !== "account_admin" && role !== "account_editor") {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
}
