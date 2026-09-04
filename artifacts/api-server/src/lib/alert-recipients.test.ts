import { beforeEach, describe, expect, it } from "vitest";

import { collectAlertRecipients } from "./alert-recipients";

function member(
  email: string | null,
  isAccountAdmin: boolean,
  workspaces: Record<string, { role: string; isDisabled: boolean }>,
) {
  return {
    userId: email ?? "missing",
    username: null,
    email,
    name: null,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

describe("collectAlertRecipients", () => {
  beforeEach(() => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = "bootstrap-admin@example.com";
  });
  it("unions account admins, Kody, configured extras, and relevant enabled workspace admins", () => {
    const dir = {
      groups: [],
      workspaces: new Map(),
      groupMembers: new Map(),
      members: new Map([
        ["acct", member("ACCOUNT@example.com", true, {})],
        ["ws1", member("ws1@example.com", false, {
          "ws-1": { role: "admin", isDisabled: false },
        })],
        ["ws2", member("ws2@example.com", false, {
          "ws-2": { role: "owner", isDisabled: false },
        })],
        ["disabled", member("disabled@example.com", false, {
          "ws-1": { role: "admin", isDisabled: true },
        })],
        ["member", member("member@example.com", false, {
          "ws-1": { role: "member", isDisabled: false },
        })],
      ]),
    } as never;

    expect(
      collectAlertRecipients(
        dir,
        [
          { email: " extra@example.com " },
          { email: "WS1@example.com" },
          { email: "not-an-email" },
        ],
        ["ws-1", "ws-2"],
      ),
    ).toEqual([
      "account@example.com",
      "bootstrap-admin@example.com",
      "extra@example.com",
      "ws1@example.com",
      "ws2@example.com",
    ]);
  });

  it("does not include admins from unrelated workspaces", () => {
    const dir = {
      groups: [],
      workspaces: new Map(),
      groupMembers: new Map(),
      members: new Map([
        ["ws1", member("ws1@example.com", false, {
          "ws-1": { role: "admin", isDisabled: false },
        })],
        ["ws2", member("ws2@example.com", false, {
          "ws-2": { role: "admin", isDisabled: false },
        })],
      ]),
    } as never;
    expect(collectAlertRecipients(dir, [], ["ws-1"])).toEqual([
      "bootstrap-admin@example.com",
      "ws1@example.com",
    ]);
  });
});