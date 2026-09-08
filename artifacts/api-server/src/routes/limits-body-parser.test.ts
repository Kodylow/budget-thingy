import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { limitsChangesJsonParser } from "./set-limits";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("limits changes body parser", () => {
  it("accepts a real HTTP commit payload containing more than 2,000 targets", async () => {
    const app = express();
    app.use("/api/limits/changes", limitsChangesJsonParser);
    app.use(express.json());
    app.post("/api/limits/changes/:id/commit", (req, res) => {
      res.json({ count: Array.isArray(req.body?.targets) ? req.body.targets.length : -1 });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    closeServer = () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const targets = Array.from({ length: 2_001 }, (_, index) => ({
      workspaceId: "ws1",
      type: "workspace_user_limit",
      targetId: String(index + 1),
      amountUsd: null,
    }));
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/limits/changes/test/commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targets }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 2_001 });
  });
});