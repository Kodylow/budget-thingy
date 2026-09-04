import { type NextFunction, type Request, type Response } from "express";
import {
  hasCapability,
  hasRole,
  resolveCurrentAuthorization,
  resolvePreviewAuthorization,
  type Authorization,
  type AuthzRole,
  type Capability,
} from "../lib/authz";

export { setAuthorizationResolver } from "../lib/authz";

declare global {
  namespace Express {
    interface Request {
      authz?: Authorization;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const real = await resolveCurrentAuthorization(req.user.id);
    if (!real) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    req.authz = await resolvePreviewAuthorization(real, req.header("X-Preview-As"));
    next();
  } catch (err) {
    req.log.error({ err }, "authorization resolution failed");
    res.status(403).json({ error: "Access denied" });
  }
}

export function requireRole(role: AuthzRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasRole(req.authz, role)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    next();
  };
}

export function requireCapability(capability: Capability) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasCapability(req.authz, capability)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    next();
  };
}

export function requireUserLimitWorkspace(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const workspaceId = String(req.params["workspaceId"] ?? "");
  if (!req.authz?.capabilities.canWriteUserLimitsIn.includes(workspaceId)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
}