import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { Request } from "express";

import app, { diagnosticEndpoint } from "./app";
import { isDocumentNavigation, rootProbeDiagnostic } from "./routes/health";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("API route diagnostics", () => {
  it("serves only the exact API root and documented health probe as health", async () => {
    for (const path of ["/api", "/api/", "/api/healthz"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
      expect(response.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    }

    const unknownApiPath = await fetch(`${baseUrl}/api/unknown-probe`);
    // The shared monitor auth boundary precedes child-route matching.
    expect(unknownApiPath.status).toBe(401);
    expect(unknownApiPath.headers.get("x-request-id")).toBeTruthy();

    const processProbe = await fetch(`${baseUrl}/`);
    expect(processProbe.status).toBe(200);
    await expect(processProbe.json()).resolves.toEqual({ status: "ok" });
    expect(processProbe.headers.get("x-request-id")).toBeTruthy();

    const headProbe = await fetch(`${baseUrl}/`, { method: "HEAD" });
    expect(headProbe.status).toBe(200);
    expect(await headProbe.text()).toBe("");
    expect(headProbe.headers.get("x-request-id")).toBeTruthy();

    const browserNavigation = await fetch(`${baseUrl}/`, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    expect(browserNavigation.status).toBe(404);
    expect(browserNavigation.headers.get("x-request-id")).toBeTruthy();

    const unknownApplicationPath = await fetch(`${baseUrl}/unknown-probe`);
    expect(unknownApplicationPath.status).toBe(404);
    expect(unknownApplicationPath.headers.get("x-request-id")).toBeTruthy();
  });

  it("correlates signed-out membership and unknown requests at the auth boundary", async () => {
    const membership = await fetch(`${baseUrl}/api/me/membership-context`);
    expect(membership.status).toBe(401);
    await expect(membership.json()).resolves.toEqual({
      error: "Authentication required",
    });
    expect(membership.headers.get("x-request-id")).toBeTruthy();

    const unknown = await fetch(`${baseUrl}/api/me/not-a-route`);
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get("x-request-id")).toBeTruthy();
  });

  it("sanitizes dynamic route segments before request diagnostics", () => {
    expect(
      diagnosticEndpoint(
        "/api/groups/private%40example.test/projects?token=not-logged",
      ),
    ).toBe("/api/groups/[redacted]/projects");
    expect(
      diagnosticEndpoint("/api/me/membership-context?identity=not-logged"),
    ).toBe("/api/me/membership-context");
  });

  it("classifies exact-root callers without retaining raw headers", () => {
    const headers: Record<string, string> = {
      "user-agent": "Mozilla/5.0 private-build-detail",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "x-forwarded-for": "sensitive-address",
      referer: "https://private.example/path",
      authorization: "Bearer secret",
    };
    const diagnostic = rootProbeDiagnostic({
      headers,
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    } as unknown as Request);

    expect(diagnostic).toEqual({
      sourceKind: "browser",
      secFetchMode: "navigate",
      isNavigation: true,
      hasForwarded: true,
      hasReferer: true,
    });
    expect(isDocumentNavigation({
      headers,
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    } as unknown as Request)).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /private|sensitive|secret|authorization|user-agent|Mozilla|example/i,
    );

    const undiciHeaders: Record<string, string> = {
      "user-agent": "undici",
      "sec-fetch-mode": "cors",
      accept: "*/*",
    };
    const undiciRequest = {
      headers: undiciHeaders,
      header(name: string) {
        return undiciHeaders[name.toLowerCase()];
      },
    } as unknown as Request;
    expect(rootProbeDiagnostic(undiciRequest)).toEqual({
      sourceKind: "node-undici",
      secFetchMode: "cors",
      isNavigation: false,
      hasForwarded: false,
      hasReferer: false,
    });
    expect(isDocumentNavigation(undiciRequest)).toBe(false);
  });
});