import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const oidcMocks = vi.hoisted(() => ({
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  calculatePKCECodeChallenge: vi.fn(),
  randomNonce: vi.fn(),
  randomPKCECodeVerifier: vi.fn(),
  randomState: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getOidcConfig: vi.fn(),
}));

vi.mock("openid-client", () => oidcMocks);

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return {
    ...actual,
    createSession: authMocks.createSession,
    getOidcConfig: authMocks.getOidcConfig,
  };
});

vi.mock("../lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/authz")>();
  return {
    ...actual,
    maybeBootstrapAppAdmin: vi.fn(async () => undefined),
  };
});

import authRouter from "./auth";

let server: Server;
let baseUrl: string;
let authLogs: Array<{ level: string; details: unknown; message?: string }> = [];

const oidcClaims = {
  sub: "oidc-regression-user",
  email: "oidc-regression@example.test",
  first_name: "OIDC",
  last_name: "Regression",
  profile_image_url: null,
};

function cookieValue(response: Response, name: string): string | undefined {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const match = setCookies
    .flatMap((value) => value.split(/,(?=[^;,]+=)/))
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1).split(";")[0]) : undefined;
}

beforeAll(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = {
      error: (details: unknown, message?: string) => {
        authLogs.push({ level: "error", details, message });
      },
      info: (details: unknown, message?: string) => {
        authLogs.push({ level: "info", details, message });
      },
    } as never;
    req.isAuthenticated = (() => false) as typeof req.isAuthenticated;
    next();
  });
  app.use("/api", authRouter);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  vi.clearAllMocks();
  authLogs = [];
  authMocks.getOidcConfig.mockResolvedValue({ client: "test" });
  authMocks.createSession.mockResolvedValue("fresh-session");
  oidcMocks.randomPKCECodeVerifier.mockReturnValue("generated-verifier");
  oidcMocks.randomNonce.mockReturnValue("generated-nonce");
  oidcMocks.randomState.mockReturnValue("generated-state");
  oidcMocks.calculatePKCECodeChallenge.mockResolvedValue("generated-challenge");
  oidcMocks.buildAuthorizationUrl.mockReturnValue(
    new URL("https://issuer.example.test/authorize"),
  );
  oidcMocks.authorizationCodeGrant.mockResolvedValue({
    claims: () => oidcClaims,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe.sequential("OIDC HTTP regression coverage", () => {
  it("generates fresh login proof values and rejects an unsafe returnTo", async () => {
    const response = await fetch(
      `${baseUrl}/api/login?returnTo=${encodeURIComponent("//evil.example/phish")}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(oidcMocks.randomPKCECodeVerifier).toHaveBeenCalledOnce();
    expect(oidcMocks.randomNonce).toHaveBeenCalledOnce();
    expect(oidcMocks.randomState).toHaveBeenCalledOnce();
    expect(oidcMocks.calculatePKCECodeChallenge).toHaveBeenCalledWith(
      "generated-verifier",
    );
    expect(oidcMocks.buildAuthorizationUrl).toHaveBeenCalledWith(
      { client: "test" },
      expect.objectContaining({
        redirect_uri: `${baseUrl}/api/callback`,
        code_challenge: "generated-challenge",
        code_challenge_method: "S256",
        nonce: "generated-nonce",
        state: "generated-state",
      }),
    );
    expect(cookieValue(response, "code_verifier")).toBe("generated-verifier");
    expect(cookieValue(response, "nonce")).toBe("generated-nonce");
    expect(cookieValue(response, "state")).toBe("generated-state");
    expect(cookieValue(response, "return_to")).toBe("/");
  });

  it("grants with saved proof values and issues a new browser session", async () => {
    const response = await fetch(
      `${baseUrl}/api/callback?code=provider-secret-code&state=saved-state&iss=provider`,
      {
        redirect: "manual",
        headers: {
          cookie: [
            "sid=inbound-session",
            "code_verifier=saved-verifier",
            "nonce=saved-nonce",
            "state=saved-state",
            `return_to=${encodeURIComponent("/dashboard?view=mine")}`,
          ].join("; "),
        },
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard?view=mine");
    expect(oidcMocks.authorizationCodeGrant).toHaveBeenCalledOnce();
    const [config, currentUrl, checks] =
      oidcMocks.authorizationCodeGrant.mock.calls[0];
    expect(config).toEqual({ client: "test" });
    expect(currentUrl).toEqual(
      new URL(
        `${baseUrl}/api/callback?code=provider-secret-code&state=saved-state&iss=provider`,
      ),
    );
    expect(checks).toEqual({
      pkceCodeVerifier: "saved-verifier",
      expectedNonce: "saved-nonce",
      expectedState: "saved-state",
      idTokenExpected: true,
    });
    expect(authMocks.createSession).toHaveBeenCalledWith({
      user: {
        id: oidcClaims.sub,
        email: oidcClaims.email,
        firstName: oidcClaims.first_name,
        lastName: oidcClaims.last_name,
        profileImageUrl: null,
      },
    });
    expect(cookieValue(response, "sid")).toBe("fresh-session");
    expect(cookieValue(response, "sid")).not.toBe("inbound-session");
    expect(JSON.stringify(authLogs)).not.toContain("provider-secret-code");
    expect(JSON.stringify(authLogs)).not.toContain("saved-verifier");
    expect(JSON.stringify(authLogs)).not.toContain("saved-nonce");
  });

  it("redirects callbacks with missing proof cookies without attempting a grant", async () => {
    const response = await fetch(
      `${baseUrl}/api/callback?code=provider-code&state=provider-state`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/api/login");
    expect(oidcMocks.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(authMocks.createSession).not.toHaveBeenCalled();
  });

  it("returns a fresh mobile session token rather than the inbound sid", async () => {
    authMocks.createSession.mockResolvedValue("fresh-mobile-session");
    const response = await fetch(`${baseUrl}/api/mobile-auth/token-exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "sid=inbound-mobile-session",
      },
      body: JSON.stringify({
        code: "mobile-code",
        code_verifier: "mobile-verifier",
        redirect_uri: "com.example.app:/oidc/callback",
        state: "mobile-state",
        nonce: "mobile-nonce",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      token: "fresh-mobile-session",
    });
    expect(authMocks.createSession).toHaveBeenCalledWith({
      user: {
        id: oidcClaims.sub,
        email: oidcClaims.email,
        firstName: oidcClaims.first_name,
        lastName: oidcClaims.last_name,
        profileImageUrl: null,
      },
    });
    expect(oidcMocks.authorizationCodeGrant).toHaveBeenCalledWith(
      { client: "test" },
      new URL(
        "com.example.app:/oidc/callback?code=mobile-code&state=mobile-state&iss=https%3A%2F%2Freplit.com%2Foidc",
      ),
      {
        pkceCodeVerifier: "mobile-verifier",
        expectedNonce: "mobile-nonce",
        expectedState: "mobile-state",
        idTokenExpected: true,
      },
    );
  });
});