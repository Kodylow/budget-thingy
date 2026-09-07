import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { devViewReadOnlyBoundary } from "../app";
import {
  buildAuthorization,
  setAppAdminLookup,
  setAuthorizationResolver,
  type Authorization,
} from "../lib/authz";
import { __setDirectoryCacheForTests } from "../lib/enterprise";
import { authMiddleware } from "../middlewares/authMiddleware";
import { requireAuth } from "../middlewares/requireAuth";
import authRouter from "./auth";

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  DEV_VIEW_AS: process.env.DEV_VIEW_AS,
  REPLIT_DEPLOYMENT: process.env.REPLIT_DEPLOYMENT,
  REPLIT_DEPLOYMENT_ID: process.env.REPLIT_DEPLOYMENT_ID,
};

let server: Server;
let baseUrl: string;
let authorization: Authorization | null;

function developmentEnvironment(): void {
  process.env.NODE_ENV = "development";
  delete process.env.DEV_VIEW_AS;
  delete process.env.REPLIT_DEPLOYMENT;
  delete process.env.REPLIT_DEPLOYMENT_ID;
}

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => {
  setAuthorizationResolver(async () => authorization);
  __setDirectoryCacheForTests({
    workspaces: new Map([
      ["comcast", {
        id: "comcast",
        name: "Comcast",
        slug: "comcast",
        memberCount: 3,
      }],
    ]),
    groups: [],
    groupMembers: new Map(),
    members: new Map([
      ["eligible-user", {
        userId: "eligible-user",
        username: "eligible",
        email: "eligible@comcast.example",
        name: "Eligible User",
        isAccountAdmin: false,
        isInternalReplitUser: false,
        workspaces: new Map([
          ["comcast", { role: "member", isDisabled: false }],
        ]),
      }],
      ["disabled-user", {
        userId: "disabled-user",
        username: "disabled",
        email: "disabled@comcast.example",
        name: "Disabled User",
        isAccountAdmin: false,
        isInternalReplitUser: false,
        workspaces: new Map([
          ["comcast", { role: "member", isDisabled: true }],
        ]),
      }],
      ["internal-user", {
        userId: "internal-user",
        username: "internal",
        email: "internal@repl.it",
        name: "Internal User",
        isAccountAdmin: true,
        isInternalReplitUser: true,
        workspaces: new Map([
          ["comcast", { role: "admin", isDisabled: false }],
        ]),
      }],
    ]),
  });

  const app = express();
  app.use((req, _res, next) => {
    req.log = {
      info() {},
      error() {},
    } as never;
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use(devViewReadOnlyBoundary);
  app.use(authMiddleware);
  app.use("/api", authRouter);
  app.get("/protected", requireAuth, (req, res) => {
    res.json({
      userId: req.user!.id,
      authz: req.authz,
    });
  });
  app.post("/unprotected-write", (_req, res) => res.sendStatus(204));

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  restoreEnvironment();
  authorization = null;
});

afterAll(async () => {
  setAppAdminLookup(null);
  setAuthorizationResolver(null);
  __setDirectoryCacheForTests(null);
  restoreEnvironment();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe.sequential("development view-as HTTP boundary", () => {
  it("is enabled by default only in non-deployment development", async () => {
    developmentEnvironment();
    const enabled = await fetch(`${baseUrl}/api/auth/dev-view`);
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toEqual({
      enabled: true,
      users: [{
        userId: "eligible-user",
        name: "Eligible User",
        username: "eligible",
        email: "eligible@comcast.example",
      }],
    });

    process.env.DEV_VIEW_AS = "0";
    await expect(
      (await fetch(`${baseUrl}/api/auth/dev-view`)).json(),
    ).resolves.toEqual({ enabled: false });

    delete process.env.DEV_VIEW_AS;
    process.env.REPLIT_DEPLOYMENT = "1";
    await expect(
      (await fetch(`${baseUrl}/api/auth/dev-view`)).json(),
    ).resolves.toEqual({ enabled: false });
  });

  it.each(["production", "test", ""])(
    "ignores a forged header and preserves normal auth in NODE_ENV=%j",
    async (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;
      delete process.env.REPLIT_DEPLOYMENT;
      const response = await fetch(`${baseUrl}/protected`, {
        headers: { "X-Dev-View-As": "eligible-user" },
      });
      expect(response.status).toBe(401);
    },
  );

  it("fails closed for missing and unknown directory IDs", async () => {
    developmentEnvironment();
    expect((await fetch(`${baseUrl}/protected`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/protected`, {
      headers: { "X-Dev-View-As": "unknown-user" },
    })).status).toBe(400);
  });

  it("does not expose real auth, app-admin, or bootstrap diagnostics", async () => {
    developmentEnvironment();
    authorization = null;
    const response = await fetch(`${baseUrl}/api/auth/me/debug`, {
      headers: { "X-Dev-View-As": "eligible-user" },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({
      error: "Authentication diagnostics are disabled in development view-as",
    });
    expect(body).not.toHaveProperty("directory");
    expect(body).not.toHaveProperty("appAdmin");
    expect(body).not.toHaveProperty("bootstrap");
  });

  it("derives distinct account, workspace-admin, and member scopes with the canonical resolver", async () => {
    developmentEnvironment();
    __setDirectoryCacheForTests({
      workspaces: new Map([
        ["comcast", {
          id: "comcast",
          name: "Comcast",
          slug: "comcast",
          memberCount: 3,
        }],
      ]),
      groups: [{
        id: "group-a",
        workspaceId: "comcast",
        name: "Finance - Members",
        type: "member",
      }],
      groupMembers: new Map([
        ["group-a", ["account-user", "workspace-user", "member-user"]],
      ]),
      members: new Map([
        ["account-user", {
          userId: "account-user",
          username: "account",
          email: "account@comcast.example",
          name: "Account User",
          isAccountAdmin: true,
          isInternalReplitUser: false,
          workspaces: new Map([
            ["comcast", { role: "member", isDisabled: false }],
          ]),
        }],
        ["workspace-user", {
          userId: "workspace-user",
          username: "workspace",
          email: "workspace@comcast.example",
          name: "Workspace User",
          isAccountAdmin: false,
          isInternalReplitUser: false,
          workspaces: new Map([
            ["comcast", { role: "admin", isDisabled: false }],
          ]),
        }],
        ["member-user", {
          userId: "member-user",
          username: "member",
          email: "member@comcast.example",
          name: "Member User",
          isAccountAdmin: false,
          isInternalReplitUser: false,
          workspaces: new Map([
            ["comcast", { role: "member", isDisabled: false }],
          ]),
        }],
      ]),
    });
    setAuthorizationResolver(null);
    setAppAdminLookup(async () => false);
    try {
      const snapshots = await Promise.all(
        ["account-user", "workspace-user", "member-user"].map(async (userId) => {
          const response = await fetch(`${baseUrl}/protected`, {
            headers: { "X-Dev-View-As": userId },
          });
          expect(response.status).toBe(200);
          return (await response.json() as { authz: Authorization }).authz;
        }),
      );

      expect(snapshots[0]).toMatchObject({
        userId: "account-user",
        roles: ["account"],
        isPreview: true,
        previewReadOnly: true,
      });
      expect(snapshots[1]).toMatchObject({
        userId: "workspace-user",
        roles: ["workspace_admin"],
        workspaceIds: ["comcast"],
        groupIds: ["group-a"],
        userIds: ["account-user", "member-user", "workspace-user"],
        isPreview: true,
        previewReadOnly: true,
      });
      expect(snapshots[2]).toMatchObject({
        userId: "member-user",
        roles: ["member"],
        workspaceIds: [],
        groupIds: ["group-a"],
        userIds: ["member-user"],
        isPreview: true,
        previewReadOnly: true,
      });
    } finally {
      setAppAdminLookup(null);
      setAuthorizationResolver(async () => authorization);
    }
  });

  it("uses canonical selected-user scopes but strips all write authority", async () => {
    developmentEnvironment();
    __setDirectoryCacheForTests({
      workspaces: new Map([
        ["comcast", {
          id: "comcast",
          name: "Comcast",
          slug: "comcast",
          memberCount: 1,
        }],
      ]),
      groups: [],
      groupMembers: new Map(),
      members: new Map([
        ["eligible-user", {
          userId: "eligible-user",
          username: "eligible",
          email: "eligible@comcast.example",
          name: "Eligible User",
          isAccountAdmin: false,
          isInternalReplitUser: false,
          workspaces: new Map([
            ["comcast", { role: "member", isDisabled: false }],
          ]),
        }],
      ]),
    });
    authorization = buildAuthorization({
      userId: "eligible-user",
      roles: ["account", "workspace_admin"],
      workspaceIds: ["comcast"],
      groupIds: ["group-a"],
      userIds: ["eligible-user", "other-user"],
      isTrueAccountAdmin: true,
      canPreviewRoles: true,
      allWorkspaceIds: ["comcast"],
    });
    const response = await fetch(`${baseUrl}/protected`, {
      headers: { "X-Dev-View-As": "eligible-user" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { userId: string; authz: Authorization };
    expect(body.userId).toBe("eligible-user");
    expect(body.authz).toMatchObject({
      userId: "eligible-user",
      roles: ["account", "workspace_admin"],
      workspaceIds: ["comcast"],
      groupIds: ["group-a"],
      userIds: ["eligible-user", "other-user"],
      previewReadOnly: true,
      isPreview: true,
      isTrueAccountAdmin: true,
      capabilities: {
        canViewAccountUsage: true,
        canManageAccess: false,
        canEditAllocations: false,
        canPreviewRoles: false,
        canWriteUserLimitsIn: [],
      },
    });

    const userResponse = await fetch(`${baseUrl}/api/auth/user`, {
      headers: { "X-Dev-View-As": "eligible-user" },
    });
    expect(userResponse.status).toBe(200);
    await expect(userResponse.json()).resolves.toMatchObject({
      user: { id: "eligible-user", email: "eligible@comcast.example" },
      auth: {
        role: "account",
        isPreview: true,
        previewReadOnly: true,
      },
      capabilities: {
        canViewAccountUsage: true,
        canManageAccess: false,
        canEditAllocations: false,
        canPreviewRoles: false,
        canWriteUserLimitsIn: [],
      },
    });
  });

  it("blocks unsafe methods globally without any identity or session", async () => {
    developmentEnvironment();
    const response = await fetch(`${baseUrl}/unprotected-write`, {
      method: "POST",
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Development view-as is read-only",
    });
  });

  it("ignores an existing session cookie and never issues a cookie in dev view", async () => {
    developmentEnvironment();
    authorization = buildAuthorization({
      userId: "eligible-user",
      roles: ["member"],
      userIds: ["eligible-user"],
    });
    const response = await fetch(`${baseUrl}/protected`, {
      headers: {
        "X-Dev-View-As": "eligible-user",
        cookie: "sid=existing-real-oauth-session",
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      userId: "eligible-user",
      authz: {
        userId: "eligible-user",
        isPreview: true,
        previewReadOnly: true,
      },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("blocks both safe-method OAuth entry points while enabled", async () => {
    developmentEnvironment();
    for (const path of ["/api/login", "/api/callback?code=forged"]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("returns enabled true with 503 when the directory is unavailable", async () => {
    developmentEnvironment();
    __setDirectoryCacheForTests(null);
    const response = await fetch(`${baseUrl}/api/auth/dev-view`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      retryable: true,
    });
  });
});