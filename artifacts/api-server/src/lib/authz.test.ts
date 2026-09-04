// @ts-nocheck
import { test, expect, beforeEach, afterAll } from "vitest";
import {
  resolveAuthorization,
  scopeGroups,
  canSeeGroup,
  canSeeWorkspace,
  isAccountAdmin,
  isAccountEditor,
  isApplicationAdmin,
  isAccountWide,
  normalizeEmail,
  BOOTSTRAP_EDITOR_EMAIL,
  setEditorAllowlistLookup,
} from "./authz.ts";
import { __setDirectoryCacheForTests, parseIsAccountAdmin } from "./enterprise.ts";

// ---------------------------------------------------------------------------
// Representative fixture: a Comcast-style Enterprise directory with three
// workspaces, several custom groups, and members spanning account admins,
// single- and multi-workspace admins, disabled admins, and plain members.
// ---------------------------------------------------------------------------

function member(userId, isAccountAdmin, workspaces) {
  return {
    userId,
    username: userId,
    email: `${userId}@example.com`,
    name: userId,
    isAccountAdmin,
    workspaces: new Map(Object.entries(workspaces)),
  };
}

const groups = [
  { id: "g-ws1-a", workspaceId: "ws-1", name: "Alpha", type: "custom" },
  { id: "g-ws1-b", workspaceId: "ws-1", name: "Beta", type: "custom" },
  { id: "g-ws2-a", workspaceId: "ws-2", name: "Gamma", type: "custom" },
  { id: "g-ws3-a", workspaceId: "ws-3", name: "Delta", type: "custom" },
];

const members = new Map([
  // Account admin — no per-workspace admin roles needed.
  ["acct", member("acct", true, {})],
  // Admin of a single workspace.
  ["ws1admin", member("ws1admin", false, { "ws-1": { role: "admin", isDisabled: false } })],
  // Admin of two workspaces (multi-workspace union).
  ["ws12admin", member("ws12admin", false, {
    "ws-1": { role: "admin", isDisabled: false },
    "ws-2": { role: "admin", isDisabled: false },
  })],
  // Admin role but disabled — must be denied.
  ["disabled", member("disabled", false, { "ws-1": { role: "admin", isDisabled: true } })],
  // Non-admin member — must be denied.
  ["plain", member("plain", false, { "ws-1": { role: "member", isDisabled: false } })],
  // Admin of one workspace + non-admin of another (union excludes non-admin ws).
  ["mixed", member("mixed", false, {
    "ws-1": { role: "member", isDisabled: false },
    "ws-2": { role: "admin", isDisabled: false },
  })],
]);

// In-memory editor allowlist injected in place of the DB-backed lookup so
// authorization logic can be exercised without a database.
let editorIds = new Set();

function seed() {
  editorIds = new Set();
  __setDirectoryCacheForTests({ groups, members });
  setEditorAllowlistLookup((userId) => Promise.resolve(editorIds.has(userId)));
}

beforeEach(seed);
afterAll(() => {
  __setDirectoryCacheForTests(null);
  setEditorAllowlistLookup(null);
});

test("unknown user is denied (fail closed)", async () => {
  expect(await resolveAuthorization("nobody")).toBe(null);
});

test("account admin resolves to account_admin with empty workspaceIds", async () => {
  const authz = await resolveAuthorization("acct");
  expect(authz).toEqual({ role: "account_admin", workspaceIds: [] });
  expect(isAccountAdmin(authz)).toBe(true);
});

test("single-workspace admin scopes to that workspace only", async () => {
  const authz = await resolveAuthorization("ws1admin");
  expect(authz.role).toBe("workspace_admin");
  expect(authz.workspaceIds).toEqual(["ws-1"]);
});

test("multi-workspace admin scopes to the union of admin workspaces", async () => {
  const authz = await resolveAuthorization("ws12admin");
  expect(authz.role).toBe("workspace_admin");
  expect([...authz.workspaceIds].sort()).toEqual(["ws-1", "ws-2"]);
});

test("mixed member only counts workspaces where the role is admin", async () => {
  const authz = await resolveAuthorization("mixed");
  expect(authz.role).toBe("workspace_admin");
  expect(authz.workspaceIds).toEqual(["ws-2"]);
});

test("disabled admin is denied", async () => {
  expect(await resolveAuthorization("disabled")).toBe(null);
});

test("plain member is denied", async () => {
  expect(await resolveAuthorization("plain")).toBe(null);
});

test("scopeGroups returns all groups for account admins", () => {
  const authz = { role: "account_admin", workspaceIds: [] };
  expect(scopeGroups(authz, groups).length).toBe(groups.length);
});

test("scopeGroups filters to admin workspaces for workspace admins", () => {
  const authz = { role: "workspace_admin", workspaceIds: ["ws-1"] };
  const scoped = scopeGroups(authz, groups);
  expect(scoped.map((g) => g.id)).toEqual(["g-ws1-a", "g-ws1-b"]);
});

test("canSeeGroup / canSeeWorkspace enforce scope", () => {
  const authz = { role: "workspace_admin", workspaceIds: ["ws-2"] };
  expect(canSeeWorkspace(authz, "ws-2")).toBe(true);
  expect(canSeeWorkspace(authz, "ws-1")).toBe(false);
  expect(canSeeGroup(authz, groups[2])).toBe(true); // g-ws2-a
  expect(canSeeGroup(authz, groups[0])).toBe(false); // g-ws1-a
  const acct = { role: "account_admin", workspaceIds: [] };
  expect(canSeeWorkspace(acct, "any")).toBe(true);
});

// ---------------------------------------------------------------------------
// Managed account_editor allowlist resolution.
// ---------------------------------------------------------------------------

test("persisted editor resolves to account_editor with account-wide access", async () => {
  editorIds.add("plain");
  const authz = await resolveAuthorization("plain");
  expect(authz).toEqual({ role: "account_editor", workspaceIds: [] });
  expect(isAccountEditor(authz)).toBe(true);
  expect(isAccountWide(authz)).toBe(true);
  expect(isAccountAdmin(authz)).toBe(false);
  // Account-wide visibility: every workspace/group is visible.
  expect(canSeeWorkspace(authz, "ws-1")).toBe(true);
  expect(canSeeWorkspace(authz, "ws-unknown")).toBe(true);
  expect(scopeGroups(authz, groups).length).toBe(groups.length);
});

test("designated persisted identity resolves to full application-admin delegate", async () => {
  setEditorAllowlistLookup((userId) =>
    Promise.resolve(userId === "plain" ? "account_delegate" : false));
  const authz = await resolveAuthorization("plain");
  expect(authz).toEqual({ role: "account_delegate", workspaceIds: [] });
  expect(isApplicationAdmin(authz)).toBe(true);
  expect(isAccountWide(authz)).toBe(true);
  expect(isAccountEditor(authz)).toBe(false);
});

test("persisted editor not in the directory still gets account-wide access", async () => {
  editorIds.add("external-editor");
  const authz = await resolveAuthorization("external-editor");
  expect(authz).toEqual({ role: "account_editor", workspaceIds: [] });
  expect(isAccountWide(authz)).toBe(true);
});

test("workspace admin who is also a persisted editor is upgraded to editor", async () => {
  editorIds.add("ws1admin");
  const authz = await resolveAuthorization("ws1admin");
  expect(authz.role).toBe("account_editor");
  expect(authz.workspaceIds).toEqual([]);
});

test("true account admin takes precedence over the editor allowlist", async () => {
  editorIds.add("acct");
  const authz = await resolveAuthorization("acct");
  expect(authz.role).toBe("account_admin");
  expect(isAccountAdmin(authz)).toBe(true);
  expect(isAccountEditor(authz)).toBe(false);
});

test("non-editor ordinary member is still denied (fail closed)", async () => {
  // "plain" is a non-admin member and not on the allowlist.
  expect(await resolveAuthorization("plain")).toBe(null);
});

test("workspace admin who is not an editor retains scoped workspace_admin", async () => {
  const authz = await resolveAuthorization("ws12admin");
  expect(authz.role).toBe("workspace_admin");
  expect([...authz.workspaceIds].sort()).toEqual(["ws-1", "ws-2"]);
  // Scoping still applies: not account-wide.
  expect(isAccountWide(authz)).toBe(false);
  expect(canSeeWorkspace(authz, "ws-3")).toBe(false);
});

test("isAccountWide / isAccountEditor handle null authz", () => {
  expect(isAccountWide(null)).toBe(false);
  expect(isAccountEditor(undefined)).toBe(false);
  expect(isAccountWide({ role: "workspace_admin", workspaceIds: [] })).toBe(false);
});

// ---------------------------------------------------------------------------
// Bootstrap helper: verified-email-only, exact normalized match.
// ---------------------------------------------------------------------------

test("normalizeEmail trims and lowercases", () => {
  expect(normalizeEmail("  KODY.Low@Repl.it \n")).toBe(BOOTSTRAP_EDITOR_EMAIL);
});

// ---------------------------------------------------------------------------
// parseIsAccountAdmin: all recognized field shapes + fail-closed behaviour.
// ---------------------------------------------------------------------------

function rawMember(overrides = {}) {
  return {
    user: { id: "u1", username: "u1", email: "u1@example.com", firstName: null, lastName: null },
    workspaces: [],
    ...overrides,
  };
}

test("parseIsAccountAdmin: top-level isAccountAdmin boolean", () => {
  expect(parseIsAccountAdmin(rawMember({ isAccountAdmin: true }))).toBe(true);
  expect(parseIsAccountAdmin(rawMember({ isAccountAdmin: false }))).toBe(false);
});

test("parseIsAccountAdmin: top-level user_is_account_admin boolean", () => {
  expect(parseIsAccountAdmin(rawMember({ user_is_account_admin: true }))).toBe(true);
  expect(parseIsAccountAdmin(rawMember({ user_is_account_admin: false }))).toBe(false);
});

test("parseIsAccountAdmin: user.isAccountAdmin (nested boolean)", () => {
  const rm = rawMember();
  rm.user.isAccountAdmin = true;
  expect(parseIsAccountAdmin(rm)).toBe(true);
  rm.user.isAccountAdmin = false;
  expect(parseIsAccountAdmin(rm)).toBe(false);
});

test("parseIsAccountAdmin: user.is_account_admin (nested snake_case boolean)", () => {
  const rm = rawMember();
  rm.user.is_account_admin = true;
  expect(parseIsAccountAdmin(rm)).toBe(true);
  rm.user.is_account_admin = false;
  expect(parseIsAccountAdmin(rm)).toBe(false);
});

test("parseIsAccountAdmin: top-level role string (admin / owner / account_admin)", () => {
  for (const role of ["admin", "ADMIN", " Admin ", "owner", "account_admin"]) {
    expect(parseIsAccountAdmin(rawMember({ role })), `role=${role}`).toBe(true);
  }
  for (const role of ["member", "viewer", "guest", ""]) {
    expect(parseIsAccountAdmin(rawMember({ role })), `role=${role}`).toBe(false);
  }
});

test("parseIsAccountAdmin: organizationRole string", () => {
  expect(parseIsAccountAdmin(rawMember({ organizationRole: "admin" }))).toBe(true);
  expect(parseIsAccountAdmin(rawMember({ organizationRole: "owner" }))).toBe(true);
  expect(parseIsAccountAdmin(rawMember({ organizationRole: "member" }))).toBe(false);
});

test("parseIsAccountAdmin: accountRole string", () => {
  expect(parseIsAccountAdmin(rawMember({ accountRole: "account_admin" }))).toBe(true);
  expect(parseIsAccountAdmin(rawMember({ accountRole: "owner" }))).toBe(true);
  expect(parseIsAccountAdmin(rawMember({ accountRole: "member" }))).toBe(false);
});

test("parseIsAccountAdmin: no recognized field resolves to false (fail closed)", () => {
  expect(parseIsAccountAdmin(rawMember())).toBe(false);
});

test("parseIsAccountAdmin: non-boolean isAccountAdmin is not treated as truthy", () => {
  // Only strict === true counts for the boolean fields.
  expect(parseIsAccountAdmin(rawMember({ isAccountAdmin: 1 }))).toBe(false);
  expect(parseIsAccountAdmin(rawMember({ isAccountAdmin: "true" }))).toBe(false);
});
