import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requireAuth,
  setAuthorizationResolver,
} from "./requireAuth";
import type { Authorization } from "../lib/authz";

function response() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { status, json };
}

function request(authenticated: boolean) {
  return {
    isAuthenticated: () => authenticated,
    user: { id: "caller" },
    header: () => undefined,
    log: { error: vi.fn(), info: vi.fn() },
  };
}

const authorization: Authorization = {
  role: "member",
  roles: ["member"],
  userId: "caller",
  workspaceIds: [],
  teamNames: [],
  groupIds: [],
  userIds: ["caller"],
  isTrueAccountAdmin: false,
  capabilities: {
    canViewAccountUsage: false,
    canManageAccess: false,
    canEditAllocations: false,
    canManageNotifications: false,
    canManageSystem: false,
    canPreviewRoles: false,
    canWriteGroupLimits: false,
    canRunChecks: false,
    canSendTestEmail: false,
    canWriteUserLimitsIn: [],
  },
};

afterEach(() => {
  setAuthorizationResolver(null);
});

describe("requireAuth authorization outcomes", () => {
  it("returns 401 for an anonymous caller", async () => {
    const res = response();
    const req = request(false);
    await requireAuth(req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Authentication required" });
    expect(req.log.info).toHaveBeenCalledWith({
      event: "auth.require",
      outcome: "signed-out",
    });
  });

  it("returns 403 only for a resolved genuine denial", async () => {
    setAuthorizationResolver(async () => null);
    const res = response();
    const req = request(true);
    await requireAuth(req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Access denied" });
    expect(req.log.info).toHaveBeenCalledWith({
      event: "auth.require",
      outcome: "denied",
    });
  });

  it("returns a retryable 503 when authorization lookup fails", async () => {
    setAuthorizationResolver(async () => {
      throw new Error("database unavailable");
    });
    const res = response();
    const req = request(true);
    await requireAuth(req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: "Authorization temporarily unavailable",
      retryable: true,
    });
    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.require",
        outcome: "unavailable",
      }),
      "authorization resolution unavailable",
    );
    expect(JSON.stringify(req.log.error.mock.calls)).not.toContain(
      "database unavailable",
    );
  });

  it("mounts authorization only after successful resolution", async () => {
    setAuthorizationResolver(async () => authorization);
    const req = request(true) as ReturnType<typeof request> & {
      authz?: Authorization;
    };
    const next = vi.fn();
    await requireAuth(req as never, response() as never, next);
    expect(req.authz).toEqual(authorization);
    expect(next).toHaveBeenCalledOnce();
    expect(req.log.info).toHaveBeenCalledWith({
      event: "auth.require",
      outcome: "authorized",
      preview: false,
    });
  });
});