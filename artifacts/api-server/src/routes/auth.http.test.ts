import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { GetCurrentAuthUserResponse, type AuthUserEnvelope } from "@workspace/api-zod";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../lib/configuration-snapshot", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../lib/configuration-snapshot")
  >();
  return {
    ...actual,
    getConfigurationSnapshot: vi.fn(async () => ({
      revision: "auth-http-test",
      groupBudgets: [],
      teamLimitTargets: [],
      teamBudgets: [],
      teamBudgetAdjustments: [],
      familyTeamMappings: [],
    })),
  };
});

import {
  buildAuthorization,
  setAuthorizationResolver,
  type Authorization,
} from "../lib/authz";
import { __setDirectoryCacheForTests } from "../lib/enterprise";
import authRouter from "./auth";

let server: Server;
let baseUrl: string;
let outcome: Authorization | null | Error;

function memberAuthorization(overrides: Partial<Authorization> = {}): Authorization {
  return {
    ...buildAuthorization({
      userId: "auth-http-user",
      roles: ["member"],
      groupIds: ["group-a"],
      userIds: ["auth-http-user"],
      managedGroupIds: [],
      groupUserIds: new Map([["group-a", ["auth-http-user"]]]),
    }),
    ...overrides,
  };
}

async function getAuth(previewAs?: string) {
  return fetch(`${baseUrl}/auth/user`, {
    headers: {
      "x-test-user": "auth-http-user",
      ...(previewAs ? { "x-preview-as": previewAs } : {}),
    },
  });
}

async function readEnvelope(response: Response): Promise<AuthUserEnvelope> {
  const body = await response.json();
  GetCurrentAuthUserResponse.parse(body);
  // Retain unknown properties so tests can catch accidentally exposed scope.
  return body as AuthUserEnvelope;
}

beforeAll(async () => {
  setAuthorizationResolver(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  __setDirectoryCacheForTests({
    workspaces: new Map([
      ["preview-workspace", {
        id: "preview-workspace",
        name: "Preview workspace",
        slug: "preview-workspace",
        memberCount: 0,
      }],
    ]),
    groups: [],
    groupMembers: new Map(),
    members: new Map(),
  });

  const app = express();
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user");
    req.log = { error: vi.fn() } as never;
    req.isAuthenticated = (() => userId != null) as typeof req.isAuthenticated;
    if (userId) {
      req.user = {
        id: userId,
        email: `${userId}@example.test`,
        firstName: "Auth",
        lastName: "Test",
        profileImageUrl: null,
      };
    }
    next();
  });
  app.use(authRouter);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  outcome = memberAuthorization();
});

afterAll(async () => {
  setAuthorizationResolver(null);
  __setDirectoryCacheForTests(null);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe.sequential("GET /auth/user authorization revision contract", () => {
  it.each([
    {
      name: "managedGroupIds",
      changed: () => memberAuthorization({ managedGroupIds: ["group-a"] }),
    },
    {
      name: "groupUserIds",
      changed: () => memberAuthorization({
        groupUserIds: { "group-a": ["auth-http-user", "other-user"] },
      }),
    },
  ])(
    "changes the revision for a $name-only change without exposing new scope",
    async ({ changed }) => {
      outcome = memberAuthorization();
      const beforeResponse = await getAuth();
      expect(beforeResponse.status).toBe(200);
      const before = await readEnvelope(beforeResponse);

      outcome = changed();
      const afterResponse = await getAuth();
      expect(afterResponse.status).toBe(200);
      const after = await readEnvelope(afterResponse);

      const { authorizationRevision: beforeRevision, ...beforeAuth } =
        before.auth!;
      const { authorizationRevision: afterRevision, ...afterAuth } = after.auth!;
      expect(afterAuth).toEqual(beforeAuth);
      expect(afterRevision).not.toBe(beforeRevision);
      expect(afterAuth).not.toHaveProperty("managedGroupIds");
      expect(afterAuth).not.toHaveProperty("groupUserIds");
    },
  );

  it("returns one revision for equivalent scope in different orders", async () => {
    outcome = memberAuthorization({
      groupIds: ["group-b", "group-a"],
      userIds: ["user-b", "auth-http-user"],
      managedGroupIds: ["group-b", "group-a"],
      groupUserIds: {
        "group-b": ["user-b", "auth-http-user"],
        "group-a": ["auth-http-user"],
      },
    });
    const first = await readEnvelope(await getAuth());

    outcome = memberAuthorization({
      groupIds: ["group-a", "group-b"],
      userIds: ["auth-http-user", "user-b"],
      managedGroupIds: ["group-a", "group-b"],
      groupUserIds: {
        "group-a": ["auth-http-user"],
        "group-b": ["auth-http-user", "user-b"],
      },
    });
    const second = await readEnvelope(await getAuth());

    expect(second.auth!.authorizationRevision).toBe(
      first.auth!.authorizationRevision,
    );
  });

  it("serializes a stable, distinct revision for preview authorization", async () => {
    outcome = buildAuthorization({
      userId: "auth-http-user",
      roles: ["account"],
      isTrueAccountAdmin: true,
      canPreviewRoles: true,
    });
    const real = await readEnvelope(await getAuth());
    const firstPreview = await readEnvelope(
      await getAuth("workspace_admin:preview-workspace"),
    );
    const secondPreview = await readEnvelope(
      await getAuth("workspace_admin:preview-workspace"),
    );

    expect(firstPreview.auth).toMatchObject({
      role: "workspace_admin",
      isPreview: true,
    });
    expect(firstPreview.auth!.authorizationRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(firstPreview.auth!.authorizationRevision).toBe(
      secondPreview.auth!.authorizationRevision,
    );
    expect(firstPreview.auth!.authorizationRevision).not.toBe(
      real.auth!.authorizationRevision,
    );
  });

  it("keeps genuine denial unauthorized with a null auth envelope", async () => {
    outcome = null;
    const response = await getAuth();
    expect(response.status).toBe(200);
    const body = await readEnvelope(response);
    expect(body.auth).toBeNull();
    expect(body.capabilities).toMatchObject({
      canViewAccountUsage: false,
      canManageAccess: false,
      canPreviewRoles: false,
    });
  });

  it("does not serialize authorization when its lookup is unavailable", async () => {
    outcome = new Error("authorization storage unavailable");
    const response = await getAuth();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Authorization temporarily unavailable",
      retryable: true,
    });
  });
});

describe.sequential("POST /logout", () => {
  it("clears the local session cookie without requiring OIDC provider discovery", async () => {
    const response = await fetch(`${baseUrl}/logout`, {
      method: "POST",
      redirect: "manual",
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("sid=");
    expect(response.headers.get("location")).toBeNull();
  });
});