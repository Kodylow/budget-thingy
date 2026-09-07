import { type NextFunction, type Request, type Response } from "express";
import {
  asAuthorizationUnavailable,
  hasCapability,
  hasRole,
  InvalidPreviewError,
  resolveCurrentAuthorization,
  resolvePreviewAuthorization,
  type Authorization,
  type AuthzRole,
  type Capability,
} from "../lib/authz";
import {
  getConfigurationSnapshot,
  type ConfigurationSnapshot,
} from "../lib/configuration-snapshot";
import { devViewReadOnly } from "../lib/dev-view";

export { setAuthorizationResolver } from "../lib/authz";

declare global {
  namespace Express {
    interface Request {
      authz?: Authorization;
      configurationSnapshot?: ConfigurationSnapshot;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.isAuthenticated()) {
    req.log?.info({ event: "auth.require", outcome: "signed-out" });
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const configuration = await getConfigurationSnapshot();
    const real = await resolveCurrentAuthorization(req.user.id, configuration);
    if (!real) {
      req.log?.info({ event: "auth.require", outcome: "denied" });
      res.status(403).json({ error: "Access denied" });
      return;
    }
    req.authz = req.devViewAs === true
      ? devViewReadOnly(real)
      : await resolvePreviewAuthorization(
          real,
          req.header("X-Preview-As"),
          configuration,
        );
    req.configurationSnapshot = configuration;
    req.log?.info({
      event: "auth.require",
      outcome: "authorized",
      preview: req.authz.isPreview === true,
    });
    next();
  } catch (err) {
    if (err instanceof InvalidPreviewError) {
      req.log?.info({ event: "auth.require", outcome: "invalid-preview" });
      res.status(400).json({ error: err.message, previewInvalid: true });
      return;
    }
    const unavailable = asAuthorizationUnavailable(err, "authorization");
    req.log?.error(
      {
        event: "auth.require",
        outcome: "unavailable",
        errorName: unavailable.name,
        source: unavailable.source,
      },
      "authorization resolution unavailable",
    );
    res.status(503).json({
      error: "Authorization temporarily unavailable",
      retryable: true,
    });
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

export function requireTrueAccountAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.authz?.isTrueAccountAdmin !== true) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
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
